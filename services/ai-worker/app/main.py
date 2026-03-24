import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

from fastapi import FastAPI
from pydantic import BaseModel, Field

logging.basicConfig(
    level=getattr(logging, os.getenv("UNIFIED_WORKER_LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("unified_ai_worker")


class ResumeChunk(BaseModel):
    id: str
    section: str
    text: str
    keywords: List[str] = Field(default_factory=list)


class JobProfile(BaseModel):
    title: str = ""
    company: str = ""
    location: str = ""
    workModel: str = "unknown"
    seniority: str = "unknown"
    primaryStack: List[str] = Field(default_factory=list)
    secondaryStack: List[str] = Field(default_factory=list)
    tools: List[str] = Field(default_factory=list)
    keywords: List[str] = Field(default_factory=list)
    domain: List[str] = Field(default_factory=list)
    summary: str = ""
    hardStops: List[str] = Field(default_factory=list)
    confidence: float = 0.0


class RankRequest(BaseModel):
    jobProfile: JobProfile
    resumes: List[Dict[str, Any]] = Field(default_factory=list)


class VerifierRequest(BaseModel):
    baseResume: Dict[str, Any]
    patch: Dict[str, Any]
    jobProfile: JobProfile


class WorkerRuntimeState(BaseModel):
    enabled: bool = False
    running: bool = False
    workerId: str = "python-worker"
    taskApiBaseUrl: str = ""
    taskTypes: List[str] = Field(default_factory=list)
    pollIntervalMs: int = 3000
    startedAt: Optional[str] = None
    lastPollAt: Optional[str] = None
    lastProcessedAt: Optional[str] = None
    lastTaskId: Optional[str] = None
    processedCount: int = 0
    errorCount: int = 0
    idlePollCount: int = 0
    lastError: Optional[str] = None
    lastResult: Dict[str, Any] = Field(default_factory=dict)


worker_state = WorkerRuntimeState()
worker_lock = threading.Lock()
worker_stop_event = threading.Event()
worker_thread: Optional[threading.Thread] = None


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def load_worker_config() -> Dict[str, Any]:
    task_types = [item.strip() for item in os.getenv("UNIFIED_WORKER_TASK_TYPES", "").split(",") if item.strip()]
    return {
        "enabled": env_flag("UNIFIED_WORKER_ENABLED", False),
        "worker_id": os.getenv("UNIFIED_WORKER_ID", "python-worker").strip() or "python-worker",
        "task_api_base_url": os.getenv("UNIFIED_TASK_API_BASE_URL", "http://127.0.0.1:3000").strip().rstrip("/"),
        "worker_token": os.getenv("UNIFIED_WORKER_TOKEN", "").strip(),
        "poll_interval_ms": max(250, int(os.getenv("UNIFIED_WORKER_POLL_INTERVAL_MS", "3000"))),
        "task_types": task_types,
    }


def snapshot_worker_state() -> WorkerRuntimeState:
    config = load_worker_config()
    with worker_lock:
        worker_state.enabled = bool(config["enabled"])
        worker_state.workerId = str(config["worker_id"])
        worker_state.taskApiBaseUrl = str(config["task_api_base_url"])
        worker_state.taskTypes = list(config["task_types"])
        worker_state.pollIntervalMs = int(config["poll_interval_ms"])
        return worker_state.model_copy(deep=True)


def update_worker_state(**updates: Any) -> WorkerRuntimeState:
    with worker_lock:
        for key, value in updates.items():
            setattr(worker_state, key, value)
        return worker_state.model_copy(deep=True)


def post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout_seconds: int = 60) -> Dict[str, Any]:
    request = urllib_request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
        body = response.read().decode("utf-8").strip()
        if not body:
            return {}
        return json.loads(body)


def process_next_task_once() -> Dict[str, Any]:
    config = load_worker_config()
    state = update_worker_state(
        enabled=bool(config["enabled"]),
        workerId=str(config["worker_id"]),
        taskApiBaseUrl=str(config["task_api_base_url"]),
        taskTypes=list(config["task_types"]),
        pollIntervalMs=int(config["poll_interval_ms"]),
        lastPollAt=now_iso(),
    )

    if not config["enabled"]:
        return {"processed": False, "reason": "worker_disabled", "state": state.model_dump()}

    if not config["worker_token"]:
        message = "UNIFIED_WORKER_TOKEN is required when UNIFIED_WORKER_ENABLED=1"
        update_worker_state(lastError=message, errorCount=worker_state.errorCount + 1)
        raise RuntimeError(message)

    payload: Dict[str, Any] = {"workerId": config["worker_id"]}
    if config["task_types"]:
        payload["taskTypes"] = config["task_types"]

    try:
        response = post_json(
            config["task_api_base_url"] + "/api/unified/tasks/process-next",
            payload,
            headers={
                "x-unified-worker-token": str(config["worker_token"]),
                "x-unified-worker-id": str(config["worker_id"]),
            },
        )
    except urllib_error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace").strip()
        message = "HTTP %s from Next task API: %s" % (exc.code, body or exc.reason)
        update_worker_state(lastError=message, errorCount=worker_state.errorCount + 1)
        raise RuntimeError(message) from exc
    except Exception as exc:
        message = "Task API request failed: %s" % exc
        update_worker_state(lastError=message, errorCount=worker_state.errorCount + 1)
        raise RuntimeError(message) from exc

    processed = bool(response.get("processed"))
    if processed:
        item = response.get("item") or {}
        update_worker_state(
            lastProcessedAt=now_iso(),
            lastTaskId=str(item.get("id") or ""),
            processedCount=worker_state.processedCount + 1,
            lastError=None,
            lastResult=response,
        )
    else:
        update_worker_state(
            idlePollCount=worker_state.idlePollCount + 1,
            lastResult=response,
        )
    return response


def worker_loop() -> None:
    logger.info("unified worker loop starting")
    update_worker_state(running=True, startedAt=now_iso(), lastError=None)
    sleep_seconds = 0.0
    while True:
        if worker_stop_event.wait(sleep_seconds):
            break
        try:
            result = process_next_task_once()
            sleep_seconds = 0.25 if result.get("processed") else load_worker_config()["poll_interval_ms"] / 1000.0
        except Exception as exc:
            logger.exception("worker poll failed: %s", exc)
            sleep_seconds = load_worker_config()["poll_interval_ms"] / 1000.0
    update_worker_state(running=False)
    logger.info("unified worker loop stopped")


app = FastAPI(title="Unified Tailor AI Worker", version="0.2.0")


@app.on_event("startup")
def start_worker_loop() -> None:
    global worker_thread
    config = load_worker_config()
    snapshot_worker_state()
    if not config["enabled"]:
        logger.info("unified worker loop disabled")
        return
    if worker_thread and worker_thread.is_alive():
        return
    worker_stop_event.clear()
    worker_thread = threading.Thread(target=worker_loop, name="unified-ai-worker", daemon=True)
    worker_thread.start()


@app.on_event("shutdown")
def stop_worker_loop() -> None:
    worker_stop_event.set()
    if worker_thread and worker_thread.is_alive():
        worker_thread.join(timeout=5)


@app.get("/health")
def health() -> Dict[str, Any]:
    state = snapshot_worker_state()
    return {
        "status": "ok",
        "service": "unified-ai-worker",
        "worker": {
            "enabled": state.enabled,
            "running": state.running,
            "workerId": state.workerId,
            "taskApiBaseUrl": state.taskApiBaseUrl,
        },
    }


@app.get("/worker/status")
def worker_status() -> Dict[str, Any]:
    return snapshot_worker_state().model_dump()


@app.post("/worker/run-once")
def worker_run_once() -> Dict[str, Any]:
    return process_next_task_once()


@app.post("/contracts/rank")
def rank_contract(payload: RankRequest) -> Dict[str, Any]:
    return {
        "accepted": True,
        "resume_count": len(payload.resumes),
        "job_title": payload.jobProfile.title,
    }


@app.post("/contracts/verify")
def verify_contract(payload: VerifierRequest) -> Dict[str, Any]:
    return {
        "accepted": True,
        "job_title": payload.jobProfile.title,
        "patch_keys": sorted(payload.patch.keys()),
    }
