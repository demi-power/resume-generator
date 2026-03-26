import importlib.util
import json
import logging
import math
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=getattr(logging, os.getenv("UNIFIED_WORKER_LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("unified_ai_worker")

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the",
    "to", "with", "you", "your", "our", "we", "will", "this", "these", "those", "their", "them", "they", "about", "into",
    "who", "what", "when", "where", "why", "how", "over", "under", "using", "used", "use", "can", "should", "must", "have",
    "has", "had", "within", "across", "per", "plus", "than", "then", "also", "ability", "strong", "excellent", "highly",
}

KNOWN_TECH_TERMS = [
    "AWS", "Azure", "GCP", "Terraform", "Kubernetes", "Docker", "Python", "TypeScript", "JavaScript", "Java", "Go", "React",
    "Next.js", "Node.js", "FastAPI", "Django", "Flask", "Spring", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka",
    "RabbitMQ", "GraphQL", "REST", "SQL", "NoSQL", "Spark", "Airflow", "Databricks", "Snowflake", "BigQuery", "LangChain",
    "OpenAI", "HuggingFace", "Pandas", "NumPy", "PyTorch", "TensorFlow", "GitHub Actions", "CircleCI", "Jenkins", "Linux",
    "Bash", "Tailwind", "HTML", "CSS", "Playwright", "Cypress", "S3", "EC2", "Lambda", "CloudFront", "Kinesis", "SQS",
    "SNS", "RDS", "Elasticsearch", "OpenSearch",
]

ALLOWED_WORK_MODELS = {"remote", "hybrid", "onsite", "unknown"}
ALLOWED_SENIORITY = {"junior", "mid", "senior", "staff", "principal", "unknown"}
ALLOWED_VIOLATION_TYPES = {
    "unsupported_claim",
    "invented_metric",
    "invented_tool",
    "missing_required_keyword",
    "format_violation",
    "keyword_stuffing",
}


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


class ExtractJobProfileRequest(BaseModel):
    pageTitle: str = ""
    descriptionText: str = ""
    titleHint: Optional[str] = None
    companyHint: Optional[str] = None


class GenerateTailorRequest(BaseModel):
    baseDocument: Dict[str, Any]
    jobProfile: JobProfile
    match: Dict[str, Any]
    providerId: str = "local_ollama"


class WorkerRuntimeState(BaseModel):
    enabled: bool = False
    running: bool = False
    workerId: str = "python-worker"
    taskApiBaseUrl: str = ""
    taskTypes: List[str] = Field(default_factory=list)
    pollIntervalMs: int = 3000
    ollamaBaseUrl: str = ""
    ollamaModel: str = ""
    ollamaExtractModel: str = ""
    ollamaGenerationModel: str = ""
    ollamaVerifierModel: str = ""
    ollamaEmbedModel: str = ""
    fastembedModel: str = ""
    fastembedAvailable: bool = False
    useOllamaExtraction: bool = False
    useOllamaRanking: bool = False
    useFastembedRanking: bool = False
    useOllamaGeneration: bool = False
    useOllamaVerifier: bool = False
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
_fastembed_model = None
_fastembed_model_name: Optional[str] = None


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def fastembed_available() -> bool:
    return importlib.util.find_spec("fastembed") is not None


def load_worker_config() -> Dict[str, Any]:
    task_types = [item.strip() for item in os.getenv("UNIFIED_WORKER_TASK_TYPES", "").split(",") if item.strip()]
    return {
        "enabled": env_flag("UNIFIED_WORKER_ENABLED", False),
        "worker_id": os.getenv("UNIFIED_WORKER_ID", "python-worker").strip() or "python-worker",
        "task_api_base_url": os.getenv("UNIFIED_TASK_API_BASE_URL", "http://127.0.0.1:3000").strip().rstrip("/"),
        "worker_token": os.getenv("UNIFIED_WORKER_TOKEN", "").strip(),
        "api_token": os.getenv("UNIFIED_AI_WORKER_TOKEN", "").strip(),
        "poll_interval_ms": max(250, int(os.getenv("UNIFIED_WORKER_POLL_INTERVAL_MS", "3000"))),
        "task_types": task_types,
        "ollama_base_url": os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip().rstrip("/"),
        "ollama_extract_model": os.getenv("LOCAL_OLLAMA_EXTRACT_MODEL", os.getenv("LOCAL_OLLAMA_MODEL", "qwen3:8b")).strip() or os.getenv("LOCAL_OLLAMA_MODEL", "qwen3:8b").strip() or "qwen3:8b",
        "ollama_generation_model": os.getenv("LOCAL_OLLAMA_GENERATION_MODEL", os.getenv("LOCAL_OLLAMA_MODEL", "qwen3:8b")).strip() or os.getenv("LOCAL_OLLAMA_MODEL", "qwen3:8b").strip() or "qwen3:8b",
        "ollama_verifier_model": os.getenv("LOCAL_OLLAMA_VERIFIER_MODEL", os.getenv("LOCAL_OLLAMA_MODEL", "deepseek-r1:8b")).strip() or os.getenv("LOCAL_OLLAMA_MODEL", "deepseek-r1:8b").strip() or "deepseek-r1:8b",
        "ollama_model": os.getenv("LOCAL_OLLAMA_GENERATION_MODEL", os.getenv("LOCAL_OLLAMA_MODEL", "qwen3:8b")).strip() or os.getenv("LOCAL_OLLAMA_MODEL", "qwen3:8b").strip() or "qwen3:8b",
        "ollama_embed_model": os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text").strip() or "nomic-embed-text",
        "ollama_timeout_seconds": max(10, int(os.getenv("OLLAMA_TIMEOUT_SECONDS", "120"))),
        "fastembed_model": os.getenv("FASTEMBED_MODEL", "BAAI/bge-small-en-v1.5").strip() or "BAAI/bge-small-en-v1.5",
        "fastembed_available": fastembed_available(),
        "use_ollama_extraction": env_flag("UNIFIED_WORKER_USE_OLLAMA_EXTRACTION", False),
        "use_ollama_ranking": env_flag("UNIFIED_WORKER_USE_OLLAMA_RANKING", False),
        "use_fastembed_ranking": env_flag("UNIFIED_WORKER_USE_FASTEMBED_RANKING", False),
        "use_ollama_generation": env_flag("UNIFIED_WORKER_USE_OLLAMA_GENERATION", False),
        "use_ollama_verifier": env_flag("UNIFIED_WORKER_USE_OLLAMA_VERIFIER", False),
    }


def get_stage_model(stage: str, config: Optional[Dict[str, Any]] = None) -> str:
    config = config or load_worker_config()
    if stage == "extract":
        return str(config["ollama_extract_model"])
    if stage == "verifier":
        return str(config["ollama_verifier_model"])
    if stage == "generation":
        return str(config["ollama_generation_model"])
    return str(config["ollama_model"])


def snapshot_worker_state() -> WorkerRuntimeState:
    config = load_worker_config()
    with worker_lock:
        worker_state.enabled = bool(config["enabled"])
        worker_state.workerId = str(config["worker_id"])
        worker_state.taskApiBaseUrl = str(config["task_api_base_url"])
        worker_state.taskTypes = list(config["task_types"])
        worker_state.pollIntervalMs = int(config["poll_interval_ms"])
        worker_state.ollamaBaseUrl = str(config["ollama_base_url"])
        worker_state.ollamaModel = str(config["ollama_model"])
        worker_state.ollamaExtractModel = str(config["ollama_extract_model"])
        worker_state.ollamaGenerationModel = str(config["ollama_generation_model"])
        worker_state.ollamaVerifierModel = str(config["ollama_verifier_model"])
        worker_state.ollamaEmbedModel = str(config["ollama_embed_model"])
        worker_state.fastembedModel = str(config["fastembed_model"])
        worker_state.fastembedAvailable = bool(config["fastembed_available"])
        worker_state.useOllamaExtraction = bool(config["use_ollama_extraction"])
        worker_state.useOllamaRanking = bool(config["use_ollama_ranking"])
        worker_state.useFastembedRanking = bool(config["use_fastembed_ranking"])
        worker_state.useOllamaGeneration = bool(config["use_ollama_generation"])
        worker_state.useOllamaVerifier = bool(config["use_ollama_verifier"])
        return worker_state.model_copy(deep=True)


def update_worker_state(**updates: Any) -> WorkerRuntimeState:
    with worker_lock:
        for key, value in updates.items():
            setattr(worker_state, key, value)
        return worker_state.model_copy(deep=True)


def require_api_token(x_unified_ai_worker_token: Optional[str]) -> None:
    expected = load_worker_config()["api_token"]
    if not expected:
        return
    if (x_unified_ai_worker_token or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def normalize_whitespace(value: str) -> str:
    value = value.replace("\r", "\n")
    value = re.sub(r"[\t\f\v ]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def tokenize_text(value: str) -> List[str]:
    normalized = normalize_whitespace(value).lower()
    tokens = re.split(r"[^a-z0-9.+#-]+", normalized)
    return [token for token in (item.strip() for item in tokens) if len(token) > 1 and token not in STOPWORDS]


def unique_tokens(value: str) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for token in tokenize_text(value):
        if token not in seen:
            seen.add(token)
            ordered.append(token)
    return ordered


def sentence_split(value: str) -> List[str]:
    normalized = normalize_whitespace(value)
    return [item.strip() for item in re.split(r"(?<=[.!?])\s+", normalized) if item.strip()]


def clamp_score(value: float) -> float:
    if not isinstance(value, (int, float)):
        return 0.0
    return max(0.0, min(1.0, float(value)))


def extract_likely_technologies(value: str) -> List[str]:
    haystack = " " + value.lower() + " "
    matches: List[str] = []
    for term in KNOWN_TECH_TERMS:
        lower = term.lower()
        if (" " + lower + " ") in haystack or lower.replace(".", "") in haystack:
            if term not in matches:
                matches.append(term)
    return matches


def pick_top(items: List[Any], limit: int) -> List[Any]:
    return items[: max(0, limit)]


def extract_title_from_title_tag(page_title: str) -> Dict[str, str]:
    trimmed = page_title.strip()
    if not trimmed:
        return {"title": "", "company": ""}
    for separator in [" at ", " - ", " | "]:
        parts = trimmed.split(separator)
        if len(parts) >= 2:
            return {"title": parts[0].strip(), "company": parts[1].strip()}
    return {"title": trimmed, "company": ""}


def infer_work_model(text: str) -> str:
    haystack = text.lower()
    if "hybrid" in haystack:
        return "hybrid"
    if "remote" in haystack or "work from home" in haystack or "distributed" in haystack:
        return "remote"
    if "onsite" in haystack or "on-site" in haystack or "in office" in haystack:
        return "onsite"
    return "unknown"


def infer_seniority(text: str) -> str:
    haystack = text.lower()
    if "principal" in haystack:
        return "principal"
    if "staff" in haystack:
        return "staff"
    if "senior" in haystack:
        return "senior"
    if "junior" in haystack or "entry level" in haystack:
        return "junior"
    if "mid" in haystack or "intermediate" in haystack:
        return "mid"
    return "unknown"


def infer_domain(text: str) -> List[str]:
    haystack = text.lower()
    domains: List[str] = []
    if "frontend" in haystack or "ui" in haystack or "browser" in haystack:
        domains.append("frontend")
    if "backend" in haystack or "api" in haystack or "distributed systems" in haystack:
        domains.append("backend")
    if "data" in haystack or "etl" in haystack or "analytics" in haystack:
        domains.append("data")
    if "machine learning" in haystack or "llm" in haystack or "ai" in haystack:
        domains.append("ai")
    if "devops" in haystack or "infrastructure" in haystack or "platform" in haystack:
        domains.append("platform")
    return domains


def overlap_ratio(left: List[str], right: List[str]) -> float:
    if not left or not right:
        return 0.0
    right_set = set(right)
    matches = sum(1 for item in left if item in right_set)
    return matches / max(len(left), 1)


def score_alignment(job: Dict[str, Any], resume_data: Dict[str, Any]) -> float:
    profile = resume_data.get("profile") or {}
    experience = resume_data.get("experience") or []
    title = ((profile.get("title") or "") + " " + (profile.get("summary") or "")).lower()
    domains = infer_domain(
        (profile.get("title") or "")
        + "\n"
        + (profile.get("summary") or "")
        + "\n"
        + "\n".join(str(item.get("description") or "") for item in experience)
    )
    score = 0.0
    if job.get("seniority") != "unknown" and str(job.get("seniority") or "") in title:
        score += 0.4
    if any(domain in domains for domain in job.get("domain") or []):
        score += 0.4
    if job.get("workModel") != "unknown" and str(job.get("workModel") or "") in title:
        score += 0.2
    return clamp_score(score)


def build_job_text(job_profile: Dict[str, Any]) -> str:
    return normalize_whitespace(
        (job_profile.get("title") or "")
        + "\n"
        + (job_profile.get("company") or "")
        + "\n"
        + (job_profile.get("summary") or "")
        + "\n"
        + " ".join(job_profile.get("primaryStack") or [])
        + "\n"
        + " ".join(job_profile.get("secondaryStack") or [])
        + "\n"
        + " ".join(job_profile.get("tools") or [])
        + "\n"
        + " ".join(job_profile.get("keywords") or [])
    )


def build_resume_text(document: Dict[str, Any]) -> str:
    resume_data = document.get("resumeData") or {}
    profile = resume_data.get("profile") or {}
    skills = resume_data.get("skills") or []
    experience = resume_data.get("experience") or []
    return normalize_whitespace(
        str(profile.get("title") or "")
        + "\n"
        + str(profile.get("summary") or "")
        + "\n"
        + " ".join(str(item.get("name") or "") for item in skills)
        + "\n"
        + "\n".join(
            (
                str(item.get("company") or "")
                + " "
                + str(item.get("role") or "")
                + "\n"
                + str(item.get("description") or "")
            ).strip()
            for item in experience
        )
    )


def chunk_support_score(job_tokens: List[str], document: Dict[str, Any]) -> Dict[str, Any]:
    ranked = []
    for chunk in document.get("chunks") or []:
        ranked.append(
            {
                "id": str(chunk.get("id") or ""),
                "score": overlap_ratio(job_tokens, [str(item) for item in (chunk.get("keywords") or [])]),
            }
        )
    ranked.sort(key=lambda item: item["score"], reverse=True)
    top = pick_top(ranked, 5)
    support_score = clamp_score(sum(item["score"] for item in top) / max(len(top), 1))
    chunk_ids = [item["id"] for item in top if item["score"] > 0 and item["id"]]
    return {"score": support_score, "chunkIds": chunk_ids}


def normalize_string_list(value: Any) -> List[str]:
    if isinstance(value, str):
        parts = re.split(r"[,\n;|]+", value)
    elif isinstance(value, list):
        parts = value
    else:
        parts = []
    seen = set()
    out: List[str] = []
    for item in parts:
        text = normalize_whitespace(str(item)) if item is not None else ""
        if not text:
            continue
        lower = text.lower()
        if lower in seen:
            continue
        seen.add(lower)
        out.append(text)
    return out


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def parse_json_like(value: str) -> Optional[Dict[str, Any]]:
    text = value.strip()
    if not text:
        return None
    candidates = [text]
    match = re.search(r"\{[\s\S]*\}", text)
    if match:
        candidates.insert(0, match.group(0))
    for candidate in candidates:
        try:
            loaded = json.loads(candidate)
        except Exception:
            continue
        if isinstance(loaded, dict):
            return loaded
    return None


def post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout_seconds: int = 60) -> Dict[str, Any]:
    req = urllib_request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
        body = response.read().decode("utf-8").strip()
        if not body:
            return {}
        return json.loads(body)


def get_json(url: str, headers: Dict[str, str], timeout_seconds: int = 30) -> Dict[str, Any]:
    req = urllib_request.Request(url, headers=headers, method="GET")
    with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
        body = response.read().decode("utf-8").strip()
        if not body:
            return {}
        return json.loads(body)


def ollama_post_json(endpoint: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    config = load_worker_config()
    base_url = str(config["ollama_base_url"])
    if not base_url:
        return None
    try:
        return post_json(base_url + endpoint, payload, {}, int(config["ollama_timeout_seconds"]))
    except Exception as error:
        logger.warning("ollama request failed for %s: %s", endpoint, error)
        return None


def get_ranking_embedding_provider(config: Optional[Dict[str, Any]] = None) -> str:
    config = config or load_worker_config()
    if config.get("use_fastembed_ranking") and config.get("fastembed_available"):
        return "fastembed"
    if config.get("use_ollama_ranking"):
        return "ollama"
    return "heuristic"


def load_fastembed_model():
    global _fastembed_model, _fastembed_model_name
    config = load_worker_config()
    if not config.get("fastembed_available"):
        return None
    model_name = str(config["fastembed_model"])
    if _fastembed_model is not None and _fastembed_model_name == model_name:
        return _fastembed_model
    try:
        from fastembed import TextEmbedding  # type: ignore
    except Exception as error:
        logger.warning("fastembed import failed: %s", error)
        return None
    try:
        _fastembed_model = TextEmbedding(model_name=model_name)
        _fastembed_model_name = model_name
        return _fastembed_model
    except Exception as error:
        logger.warning("fastembed model init failed for %s: %s", model_name, error)
        return None


def embed_inputs_fastembed(inputs: List[str]) -> Optional[List[List[float]]]:
    model = load_fastembed_model()
    if model is None:
        return None
    clean_inputs = [normalize_whitespace(item) for item in inputs if normalize_whitespace(item)]
    if not clean_inputs:
        return []
    try:
        vectors = list(model.embed(clean_inputs))
    except Exception as error:
        logger.warning("fastembed inference failed: %s", error)
        return None
    results: List[List[float]] = []
    for vector in vectors:
        if hasattr(vector, "tolist"):
            vector = vector.tolist()
        if not isinstance(vector, list):
            vector = list(vector)
        results.append([float(item) for item in vector])
    return results


def get_fastembed_status() -> Dict[str, Any]:
    config = load_worker_config()
    available = bool(config.get("fastembed_available"))
    return {
        "available": available,
        "model": str(config["fastembed_model"]),
        "enabledForRanking": bool(config.get("use_fastembed_ranking")),
    }


def get_ollama_status() -> Dict[str, Any]:
    config = load_worker_config()
    base_url = str(config["ollama_base_url"])
    extract_model = get_stage_model("extract", config)
    generation_model = get_stage_model("generation", config)
    verifier_model = get_stage_model("verifier", config)
    embed_model = str(config["ollama_embed_model"])
    if not base_url:
        return {
            "reachable": False,
            "baseUrl": "",
            "model": generation_model,
            "extractModel": extract_model,
            "generationModel": generation_model,
            "verifierModel": verifier_model,
            "embedModel": embed_model,
            "availableModels": [],
            "modelAvailable": False,
            "extractModelAvailable": False,
            "generationModelAvailable": False,
            "verifierModelAvailable": False,
            "embedModelAvailable": False,
            "error": "OLLAMA_BASE_URL is not configured",
        }
    try:
        response = get_json(base_url + "/api/tags", {}, int(config["ollama_timeout_seconds"]))
        names: List[str] = []
        for item in response.get("models") or []:
            if not isinstance(item, dict):
                continue
            name = normalize_whitespace(str(item.get("name") or ""))
            if name:
                names.append(name)
        return {
            "reachable": True,
            "baseUrl": base_url,
            "model": generation_model,
            "extractModel": extract_model,
            "generationModel": generation_model,
            "verifierModel": verifier_model,
            "embedModel": embed_model,
            "availableModels": names[:20],
            "modelAvailable": generation_model in names,
            "extractModelAvailable": extract_model in names,
            "generationModelAvailable": generation_model in names,
            "verifierModelAvailable": verifier_model in names,
            "embedModelAvailable": embed_model in names,
            "error": None,
        }
    except Exception as error:
        return {
            "reachable": False,
            "baseUrl": base_url,
            "model": generation_model,
            "extractModel": extract_model,
            "generationModel": generation_model,
            "verifierModel": verifier_model,
            "embedModel": embed_model,
            "availableModels": [],
            "modelAvailable": False,
            "extractModelAvailable": False,
            "generationModelAvailable": False,
            "verifierModelAvailable": False,
            "embedModelAvailable": False,
            "error": str(error),
        }


def embed_inputs(inputs: List[str]) -> Optional[List[List[float]]]:
    clean_inputs = [normalize_whitespace(item) for item in inputs if normalize_whitespace(item)]
    if not clean_inputs:
        return []
    config = load_worker_config()
    provider = get_ranking_embedding_provider(config)
    if provider == "fastembed":
        embeddings = embed_inputs_fastembed(clean_inputs)
        if embeddings is not None:
            return embeddings
    model = str(config["ollama_embed_model"])
    response = ollama_post_json("/api/embed", {"model": model, "input": clean_inputs})
    if response and isinstance(response.get("embeddings"), list):
        embeddings = response.get("embeddings") or []
        if len(embeddings) == len(clean_inputs):
            return embeddings  # type: ignore[return-value]
    single_prompt_embeddings: List[List[float]] = []
    for item in clean_inputs:
        legacy = ollama_post_json("/api/embeddings", {"model": model, "prompt": item})
        if not legacy:
            return None
        embedding = legacy.get("embedding")
        if not isinstance(embedding, list):
            return None
        single_prompt_embeddings.append(embedding)
    return single_prompt_embeddings


def dot(left: List[float], right: List[float]) -> float:
    return sum(float(a) * float(b) for a, b in zip(left, right))


def cosine_similarity(left: List[float], right: List[float]) -> float:
    if not left or not right:
        return 0.0
    left_norm = math.sqrt(sum(float(item) * float(item) for item in left))
    right_norm = math.sqrt(sum(float(item) * float(item) for item in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot(left, right) / (left_norm * right_norm)


def normalized_cosine(left: List[float], right: List[float]) -> float:
    return clamp_score((cosine_similarity(left, right) + 1.0) / 2.0)


def ollama_chat_json(system_prompt: str, user_payload: Dict[str, Any], temperature: float = 0.1, model: Optional[str] = None) -> Optional[Dict[str, Any]]:
    config = load_worker_config()
    model = normalize_whitespace(model or get_stage_model("generation", config)) or get_stage_model("generation", config)
    payload = {
        "model": model,
        "stream": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
        "options": {
            "temperature": temperature,
        },
    }
    response = ollama_post_json("/api/chat", payload)
    content = None
    if response:
        message = response.get("message") or {}
        if isinstance(message, dict):
            content = message.get("content")
    if isinstance(content, str):
        parsed = parse_json_like(content)
        if parsed is not None:
            return parsed
    fallback_prompt = system_prompt + "\n\nReturn JSON only for this payload:\n" + json.dumps(user_payload, ensure_ascii=False)
    fallback = ollama_post_json(
        "/api/generate",
        {
            "model": model,
            "stream": False,
            "format": "json",
            "prompt": fallback_prompt,
            "options": {"temperature": temperature},
        },
    )
    if fallback and isinstance(fallback.get("response"), str):
        return parse_json_like(str(fallback.get("response")))
    return None


def sanitize_job_profile_candidate(candidate: Dict[str, Any], fallback: Dict[str, Any]) -> Dict[str, Any]:
    work_model = normalize_whitespace(
        str(candidate.get("workModel") or candidate.get("work_model") or fallback.get("workModel") or "unknown")
    ).lower()
    seniority = normalize_whitespace(str(candidate.get("seniority") or fallback.get("seniority") or "unknown")).lower()
    out = {
        "title": normalize_whitespace(str(candidate.get("title") or fallback.get("title") or "Unknown Role")),
        "company": normalize_whitespace(str(candidate.get("company") or fallback.get("company") or "")),
        "location": normalize_whitespace(str(candidate.get("location") or fallback.get("location") or "")),
        "workModel": work_model if work_model in ALLOWED_WORK_MODELS else str(fallback.get("workModel") or "unknown"),
        "seniority": seniority if seniority in ALLOWED_SENIORITY else str(fallback.get("seniority") or "unknown"),
        "primaryStack": normalize_string_list(candidate.get("primaryStack") or candidate.get("primary_stack") or fallback.get("primaryStack") or []),
        "secondaryStack": normalize_string_list(
            candidate.get("secondaryStack") or candidate.get("secondary_stack") or fallback.get("secondaryStack") or []
        ),
        "tools": normalize_string_list(candidate.get("tools") or fallback.get("tools") or []),
        "keywords": normalize_string_list(candidate.get("keywords") or fallback.get("keywords") or []),
        "domain": normalize_string_list(candidate.get("domain") or fallback.get("domain") or []),
        "summary": normalize_whitespace(str(candidate.get("summary") or fallback.get("summary") or "")),
        "hardStops": normalize_string_list(candidate.get("hardStops") or candidate.get("hard_stops") or fallback.get("hardStops") or []),
        "confidence": clamp_score(safe_float(candidate.get("confidence"), safe_float(fallback.get("confidence"), 0.0))),
    }
    if not out["primaryStack"]:
        out["primaryStack"] = normalize_string_list(fallback.get("primaryStack") or [])
    if not out["secondaryStack"]:
        out["secondaryStack"] = normalize_string_list(fallback.get("secondaryStack") or [])
    if not out["keywords"]:
        out["keywords"] = normalize_string_list(fallback.get("keywords") or [])
    if not out["domain"]:
        out["domain"] = normalize_string_list(fallback.get("domain") or [])
    return out


def extract_job_profile_local(payload: ExtractJobProfileRequest) -> Dict[str, Any]:
    lines = [line.strip() for line in re.split(r"\n+", payload.descriptionText) if line.strip()]
    title_parts = extract_title_from_title_tag(payload.pageTitle)
    title = (payload.titleHint or "").strip() or title_parts["title"] or (lines[0] if lines else "Unknown Role")
    company = (payload.companyHint or "").strip() or title_parts["company"]
    technologies = extract_likely_technologies(payload.descriptionText)
    keywords = pick_top(unique_tokens(title + " " + payload.descriptionText), 30)
    primary_stack = technologies[:8]
    secondary_stack = technologies[8:16]
    tools = [
        item
        for item in technologies
        if item in {"AWS", "Azure", "GCP", "Docker", "Kubernetes", "Terraform", "GitHub Actions", "CircleCI", "Jenkins"}
    ]
    hard_stops: List[str] = []
    haystack = payload.descriptionText.lower()
    if "clearance" in haystack:
        hard_stops.append("clearance")
    if "u.s. citizens" in haystack or "us citizens" in haystack:
        hard_stops.append("us_only")
    if "must be onsite" in haystack or "5 days onsite" in haystack:
        hard_stops.append("onsite_required")
    return {
        "title": title,
        "company": company,
        "location": next((line for line in lines if re.search(r"remote|hybrid|onsite|on-site|[A-Z]{2}", line)), ""),
        "workModel": infer_work_model(title + "\n" + payload.descriptionText),
        "seniority": infer_seniority(title + "\n" + payload.descriptionText),
        "primaryStack": primary_stack,
        "secondaryStack": secondary_stack,
        "tools": tools,
        "keywords": keywords,
        "domain": infer_domain(title + "\n" + payload.descriptionText),
        "summary": " ".join(sentence_split(payload.descriptionText)[:3]),
        "hardStops": hard_stops,
        "confidence": clamp_score((0.45 if primary_stack else 0.2) + (0.25 if title else 0.0) + (0.15 if company else 0.0) + (0.15 if len(keywords) > 10 else 0.05)),
    }


def extract_job_profile_with_ollama(payload: ExtractJobProfileRequest) -> Optional[Dict[str, Any]]:
    if not load_worker_config()["use_ollama_extraction"]:
        return None
    fallback = extract_job_profile_local(payload)
    system_prompt = (
        "You extract structured software-job metadata. Return JSON only with keys: "
        "title, company, location, workModel, seniority, primaryStack, secondaryStack, tools, keywords, domain, summary, hardStops, confidence. "
        "Use workModel in {remote, hybrid, onsite, unknown}. Use seniority in {junior, mid, senior, staff, principal, unknown}. "
        "Do not hallucinate company or requirements not supported by the description."
    )
    candidate = ollama_chat_json(
        system_prompt,
        {
            "pageTitle": payload.pageTitle,
            "titleHint": payload.titleHint,
            "companyHint": payload.companyHint,
            "descriptionText": payload.descriptionText,
            "knownTechTerms": KNOWN_TECH_TERMS,
        },
        model=get_stage_model("extract"),
    )
    if not candidate:
        return None
    return sanitize_job_profile_candidate(candidate, fallback)


def semantic_chunk_support_score(job_embedding: List[float], document: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    chunk_entries = []
    chunk_texts = []
    for chunk in (document.get("chunks") or [])[:6]:
        text = normalize_whitespace(str(chunk.get("text") or ""))
        chunk_id = str(chunk.get("id") or "")
        if not text or not chunk_id:
            continue
        chunk_entries.append({"id": chunk_id, "text": text})
        chunk_texts.append(text)
    embeddings = embed_inputs(chunk_texts)
    if embeddings is None or len(embeddings) != len(chunk_entries):
        return None
    ranked = []
    for entry, embedding in zip(chunk_entries, embeddings):
        ranked.append({"id": entry["id"], "score": normalized_cosine(job_embedding, embedding)})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    top = pick_top(ranked, 3)
    score = clamp_score(sum(item["score"] for item in top) / max(len(top), 1))
    chunk_ids = [item["id"] for item in top if item["score"] >= 0.45]
    return {"score": score, "chunkIds": chunk_ids}


def rank_resumes_local(job_profile: Dict[str, Any], resumes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    job_tokens = unique_tokens(build_job_text(job_profile))
    results: List[Dict[str, Any]] = []
    for resume in resumes:
        document = resume.get("document") or {}
        resume_data = document.get("resumeData") or {}
        resume_text = build_resume_text(document)
        resume_tokens = unique_tokens(resume_text)
        similarity_score = clamp_score(overlap_ratio(job_tokens, resume_tokens))
        resume_skills = [str(item.get("name") or "").lower() for item in (resume_data.get("skills") or [])]
        must_have_coverage = overlap_ratio([str(item).lower() for item in (job_profile.get("primaryStack") or [])], resume_skills)
        secondary_coverage = overlap_ratio(
            [str(item).lower() for item in ((job_profile.get("secondaryStack") or []) + (job_profile.get("tools") or []))],
            resume_skills,
        )
        alignment_score = score_alignment(job_profile, resume_data)
        chunk_support = chunk_support_score(job_tokens, document)
        rule_score = clamp_score((0.45 * must_have_coverage) + (0.2 * secondary_coverage) + (0.2 * alignment_score) + (0.15 * chunk_support["score"]))
        rerank_score = clamp_score((similarity_score + must_have_coverage + chunk_support["score"]) / 3.0)
        hybrid_score = clamp_score((0.35 * similarity_score) + (0.25 * must_have_coverage) + (0.15 * secondary_coverage) + (0.15 * alignment_score) + (0.10 * chunk_support["score"]))
        matched_requirements = [item for item in (job_profile.get("primaryStack") or []) if str(item).lower() in resume_skills]
        missing_requirements = [item for item in (job_profile.get("primaryStack") or []) if str(item).lower() not in resume_skills]
        decision = "need_tailor"
        if "clearance" in (job_profile.get("hardStops") or []) and "clearance" not in resume_text.lower():
            decision = "not_eligible"
        elif len(matched_requirements) >= max(1, int((len(job_profile.get("primaryStack") or []) * 0.7) + 0.9999)) and hybrid_score >= 0.65:
            decision = "use_as_is"
        elif len(matched_requirements) >= max(1, int((len(job_profile.get("primaryStack") or []) * 0.5) + 0.9999)) or hybrid_score >= 0.5:
            decision = "review"
        reason = (
            "Matched %s core requirements and %s strong evidence chunks." % (len(matched_requirements), len(chunk_support["chunkIds"]))
            if matched_requirements
            else "Low must-have overlap; tailoring or manual review is required."
        )
        results.append(
            {
                "resumeSnapshotId": str(resume.get("snapshotId") or ""),
                "resumeVariantId": str(resume.get("variantId") or ""),
                "profileName": str(resume.get("profileName") or ""),
                "variantName": str(resume.get("variantName") or ""),
                "similarityScore": similarity_score,
                "ruleScore": rule_score,
                "rerankScore": rerank_score,
                "hybridScore": hybrid_score,
                "decision": decision,
                "reason": reason,
                "matchedRequirements": matched_requirements,
                "missingRequirements": missing_requirements,
                "supportingChunkIds": chunk_support["chunkIds"],
            }
        )
    results.sort(key=lambda item: item["hybridScore"], reverse=True)
    return results


def rank_resumes_with_ollama(job_profile: Dict[str, Any], resumes: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    config = load_worker_config()
    if not config["use_ollama_ranking"] and not config["use_fastembed_ranking"]:
        return None
    heuristic_results = rank_resumes_local(job_profile, resumes)
    if not resumes:
        return heuristic_results
    job_text = build_job_text(job_profile)
    resume_texts = [build_resume_text((resume.get("document") or {})) for resume in resumes]
    embeddings = embed_inputs([job_text] + resume_texts)
    if embeddings is None or len(embeddings) != len(resume_texts) + 1:
        return None
    job_embedding = embeddings[0]
    resume_embeddings = embeddings[1:]
    results: List[Dict[str, Any]] = []
    for resume, heuristic, resume_embedding in zip(resumes, heuristic_results, resume_embeddings):
        document = resume.get("document") or {}
        resume_data = document.get("resumeData") or {}
        resume_text = build_resume_text(document)
        similarity_score = normalized_cosine(job_embedding, resume_embedding)
        resume_skills = [str(item.get("name") or "").lower() for item in (resume_data.get("skills") or [])]
        must_have_coverage = overlap_ratio([str(item).lower() for item in (job_profile.get("primaryStack") or [])], resume_skills)
        secondary_coverage = overlap_ratio(
            [str(item).lower() for item in ((job_profile.get("secondaryStack") or []) + (job_profile.get("tools") or []))],
            resume_skills,
        )
        alignment_score = score_alignment(job_profile, resume_data)
        semantic_chunk_support = semantic_chunk_support_score(job_embedding, document)
        if semantic_chunk_support is None:
            semantic_chunk_support = chunk_support_score(unique_tokens(job_text), document)
        rule_score = clamp_score(
            (0.45 * must_have_coverage)
            + (0.2 * secondary_coverage)
            + (0.2 * alignment_score)
            + (0.15 * semantic_chunk_support["score"])
        )
        rerank_score = clamp_score((0.55 * similarity_score) + (0.25 * semantic_chunk_support["score"]) + (0.20 * must_have_coverage))
        hybrid_score = clamp_score(
            (0.35 * similarity_score)
            + (0.25 * must_have_coverage)
            + (0.15 * secondary_coverage)
            + (0.15 * alignment_score)
            + (0.10 * semantic_chunk_support["score"])
        )
        matched_requirements = [item for item in (job_profile.get("primaryStack") or []) if str(item).lower() in resume_skills]
        missing_requirements = [item for item in (job_profile.get("primaryStack") or []) if str(item).lower() not in resume_skills]
        decision = heuristic.get("decision") or "need_tailor"
        if "clearance" in (job_profile.get("hardStops") or []) and "clearance" not in resume_text.lower():
            decision = "not_eligible"
        elif len(matched_requirements) >= max(1, int((len(job_profile.get("primaryStack") or []) * 0.7) + 0.9999)) and hybrid_score >= 0.65:
            decision = "use_as_is"
        elif len(matched_requirements) >= max(1, int((len(job_profile.get("primaryStack") or []) * 0.5) + 0.9999)) or hybrid_score >= 0.5:
            decision = "review"
        reason = (
            "Embedding-ranked fit with %s matched core requirements and %s supporting chunks."
            % (len(matched_requirements), len(semantic_chunk_support["chunkIds"]))
            if matched_requirements
            else "Embedding fit is low on must-have requirements; tailoring or review is required."
        )
        results.append(
            {
                "resumeSnapshotId": str(resume.get("snapshotId") or ""),
                "resumeVariantId": str(resume.get("variantId") or ""),
                "profileName": str(resume.get("profileName") or ""),
                "variantName": str(resume.get("variantName") or ""),
                "similarityScore": similarity_score,
                "ruleScore": rule_score,
                "rerankScore": rerank_score,
                "hybridScore": hybrid_score,
                "decision": decision,
                "reason": reason,
                "matchedRequirements": matched_requirements,
                "missingRequirements": missing_requirements,
                "supportingChunkIds": semantic_chunk_support["chunkIds"],
            }
        )
    results.sort(key=lambda item: item["hybridScore"], reverse=True)
    return results


def build_default_patch(base_document: Dict[str, Any], job_profile: Dict[str, Any], match: Dict[str, Any], provider_id: str) -> Dict[str, Any]:
    resume_data = base_document.get("resumeData") or {}
    skills = resume_data.get("skills") or []
    experience = resume_data.get("experience") or []
    matched_requirements = [str(item) for item in (match.get("matchedRequirements") or [])]
    matched_skill_names = []
    for skill in skills:
        name = str(skill.get("name") or "")
        if any(req.lower() == name.lower() for req in matched_requirements):
            matched_skill_names.append(name)
    remaining_skill_names = [str(skill.get("name") or "") for skill in skills if str(skill.get("name") or "") not in matched_skill_names]
    prioritized_skills = (matched_skill_names + remaining_skill_names)[:20]
    experience_edits = []
    for item in experience[:3]:
        experience_edits.append(
            {
                "experienceId": str(item.get("id") or ""),
                "originalText": str(item.get("description") or ""),
                "tailoredText": str(item.get("description") or ""),
            }
        )
    if matched_requirements:
        summary_prefix = "Targeting %s work emphasizing %s." % (job_profile.get("title") or "the role", ", ".join(matched_requirements[:4]))
    else:
        summary_prefix = "Targeting %s." % (job_profile.get("title") or "the role")
    base_summary = str(((resume_data.get("profile") or {}).get("summary")) or "")
    coverage_notes = ["Requirement not yet evidenced in source resume: %s" % item for item in (match.get("missingRequirements") or [])]
    return {
        "summary": (summary_prefix + " " + base_summary).strip(),
        "skillsOrder": prioritized_skills,
        "experienceEdits": experience_edits,
        "removedItems": [],
        "coverageNotes": coverage_notes,
        "providerMetadata": {
            "requested_provider": provider_id,
            "effective_provider": "worker-heuristic",
            "configured_model": get_stage_model("generation"),
        },
    }


def sanitize_resume_patch(candidate: Dict[str, Any], base_document: Dict[str, Any], provider_id: str, effective_provider: str) -> Dict[str, Any]:
    fallback = build_default_patch(base_document, {}, {"matchedRequirements": [], "missingRequirements": []}, provider_id)
    resume_data = base_document.get("resumeData") or {}
    base_profile = resume_data.get("profile") or {}
    base_skills = [str(item.get("name") or "") for item in (resume_data.get("skills") or []) if str(item.get("name") or "")]
    skill_lookup = {name.lower(): name for name in base_skills}
    base_experience = {str(item.get("id") or ""): item for item in (resume_data.get("experience") or []) if str(item.get("id") or "")}
    summary = normalize_whitespace(str(candidate.get("summary") or fallback.get("summary") or base_profile.get("summary") or ""))
    raw_skills = candidate.get("skillsOrder") or candidate.get("skills_order") or fallback.get("skillsOrder") or []
    ordered_skills: List[str] = []
    seen_skills = set()
    for item in normalize_string_list(raw_skills):
        canonical = skill_lookup.get(item.lower())
        if canonical and canonical.lower() not in seen_skills:
            seen_skills.add(canonical.lower())
            ordered_skills.append(canonical)
    for name in base_skills:
        lower = name.lower()
        if lower not in seen_skills:
            seen_skills.add(lower)
            ordered_skills.append(name)
    experience_edits: List[Dict[str, str]] = []
    raw_edits = candidate.get("experienceEdits") or candidate.get("experience_edits") or []
    if isinstance(raw_edits, list):
        for item in raw_edits[:6]:
            if not isinstance(item, dict):
                continue
            experience_id = str(item.get("experienceId") or item.get("experience_id") or "")
            if experience_id not in base_experience:
                continue
            base_item = base_experience[experience_id]
            original_text = str(base_item.get("description") or "")
            tailored_text = normalize_whitespace(str(item.get("tailoredText") or item.get("tailored_text") or original_text)) or original_text
            experience_edits.append(
                {
                    "experienceId": experience_id,
                    "originalText": original_text,
                    "tailoredText": tailored_text,
                }
            )
    if not experience_edits:
        experience_edits = fallback.get("experienceEdits") or []
    removed_items = normalize_string_list(candidate.get("removedItems") or candidate.get("removed_items") or [])
    coverage_notes = normalize_string_list(candidate.get("coverageNotes") or candidate.get("coverage_notes") or [])
    metadata = dict(candidate.get("providerMetadata") or candidate.get("provider_metadata") or {})
    metadata.update(
        {
            "requested_provider": provider_id,
            "effective_provider": effective_provider,
            "configured_model": get_stage_model("generation"),
        }
    )
    return {
        "summary": summary,
        "skillsOrder": ordered_skills[:20],
        "experienceEdits": experience_edits,
        "removedItems": removed_items,
        "coverageNotes": coverage_notes,
        "providerMetadata": metadata,
    }


def generate_tailored_patch_local(base_document: Dict[str, Any], job_profile: Dict[str, Any], match: Dict[str, Any], provider_id: str) -> Dict[str, Any]:
    return sanitize_resume_patch(build_default_patch(base_document, job_profile, match, provider_id), base_document, provider_id, "worker-heuristic")


def generate_tailored_patch_with_ollama(base_document: Dict[str, Any], job_profile: Dict[str, Any], match: Dict[str, Any], provider_id: str) -> Optional[Dict[str, Any]]:
    if not load_worker_config()["use_ollama_generation"]:
        return None
    resume_data = base_document.get("resumeData") or {}
    system_prompt = (
        "You tailor resumes for ATS and recruiter review. Return JSON only with keys: summary, skillsOrder, experienceEdits, removedItems, coverageNotes. "
        "Use only facts already present in the base resume. Do not invent employers, dates, metrics, technologies, or achievements. "
        "skillsOrder must only contain existing resume skill names. experienceEdits must reference existing experienceId values and provide tailoredText."
    )
    payload = {
        "jobProfile": job_profile,
        "match": match,
        "baseResume": {
            "profile": resume_data.get("profile") or {},
            "skills": resume_data.get("skills") or [],
            "experience": resume_data.get("experience") or [],
        },
    }
    candidate = ollama_chat_json(system_prompt, payload, temperature=0.2, model=get_stage_model("generation"))
    if not candidate:
        return None
    if isinstance(candidate.get("patch"), dict):
        candidate = candidate.get("patch")
    return sanitize_resume_patch(candidate, base_document, provider_id, "ollama")


def find_invented_numbers(base_resume: Dict[str, Any], patch: Dict[str, Any]) -> List[str]:
    base_numbers = set(re.findall(r"\d+(?:\.\d+)?", json.dumps(base_resume)))
    patch_numbers = set(re.findall(r"\d+(?:\.\d+)?", json.dumps(patch)))
    return [item for item in patch_numbers if item not in base_numbers]


def verify_tailored_patch_local(base_document: Dict[str, Any], patch: Dict[str, Any], job_profile: Dict[str, Any]) -> Dict[str, Any]:
    violations: List[Dict[str, str]] = []
    resume_data = base_document.get("resumeData") or {}
    skills = resume_data.get("skills") or []
    base_skills = {str(item.get("name") or "").lower() for item in skills}
    allowed_technologies = {
        str(item).lower()
        for item in ([skill.get("name") for skill in skills] + list(job_profile.get("primaryStack") or []) + list(job_profile.get("secondaryStack") or []) + list(job_profile.get("tools") or []))
        if item
    }
    summary = str(patch.get("summary") or "").strip()
    if not summary:
        violations.append({"type": "format_violation", "message": "Tailored summary is empty."})
    for skill in patch.get("skillsOrder") or []:
        if str(skill).lower() not in base_skills:
            violations.append({"type": "format_violation", "message": "Tailored skills contain an unknown skill ordering entry: %s" % skill})
    for tech in extract_likely_technologies(json.dumps(patch)):
        if tech.lower() not in allowed_technologies:
            violations.append({"type": "invented_tool", "message": "Patch introduced unsupported technology: %s" % tech})
    for number in find_invented_numbers(resume_data, patch):
        violations.append({"type": "invented_metric", "message": "Patch introduced unsupported numeric claim: %s" % number})
    summary_tokens = tokenize_text(summary)
    for keyword in list(job_profile.get("primaryStack") or [])[:4]:
        keyword_lower = str(keyword).lower()
        if (job_profile.get("primaryStack") or []) and keyword_lower not in summary_tokens and not any(str(item).lower() == keyword_lower for item in (patch.get("skillsOrder") or [])):
            violations.append({"type": "missing_required_keyword", "message": "Tailored output still does not foreground %s." % keyword})
    repeated: Dict[str, int] = {}
    for token in summary_tokens:
        repeated[token] = repeated.get(token, 0) + 1
    for token, count in repeated.items():
        if count >= 6:
            violations.append({"type": "keyword_stuffing", "message": "Summary repeats '%s' too many times." % token})
    unique_violations: List[Dict[str, str]] = []
    seen = set()
    for item in violations:
        key = item["type"] + item["message"]
        if key in seen:
            continue
        seen.add(key)
        unique_violations.append(item)
    return {
        "pass": len(unique_violations) == 0,
        "violations": unique_violations,
        "retryInstructions": [item["message"] for item in unique_violations],
        "qualityScore": clamp_score(1 - (len(unique_violations) * 0.18)),
        "humanReviewReason": "Verifier blocked the tailored output." if unique_violations else None,
        "providerMetadata": {
            "verifier": "worker-heuristic",
            "configured_model": get_stage_model("verifier"),
        },
    }


def sanitize_verifier_result(candidate: Dict[str, Any], fallback: Dict[str, Any], effective_provider: str) -> Dict[str, Any]:
    raw_violations = candidate.get("violations") or []
    violations: List[Dict[str, str]] = []
    if isinstance(raw_violations, list):
        for item in raw_violations:
            if isinstance(item, dict):
                violation_type = normalize_whitespace(str(item.get("type") or "format_violation")).lower()
                message = normalize_whitespace(str(item.get("message") or ""))
            else:
                violation_type = "format_violation"
                message = normalize_whitespace(str(item))
            if not message:
                continue
            if violation_type not in ALLOWED_VIOLATION_TYPES:
                violation_type = "format_violation"
            violations.append({"type": violation_type, "message": message})
    unique_violations: List[Dict[str, str]] = []
    seen = set()
    for item in violations:
        key = item["type"] + item["message"]
        if key in seen:
            continue
        seen.add(key)
        unique_violations.append(item)
    retry_instructions = normalize_string_list(candidate.get("retryInstructions") or candidate.get("retry_instructions") or [item["message"] for item in unique_violations])
    quality_score = clamp_score(
        safe_float(
            candidate.get("qualityScore") if "qualityScore" in candidate else candidate.get("quality_score"),
            safe_float(fallback.get("qualityScore"), 0.0),
        )
    )
    passed = bool(candidate.get("pass")) if "pass" in candidate else len(unique_violations) == 0
    provider_metadata = dict(fallback.get("providerMetadata") or {})
    provider_metadata.update(candidate.get("providerMetadata") or candidate.get("provider_metadata") or {})
    provider_metadata.update(
        {
            "verifier": effective_provider,
            "configured_model": get_stage_model("verifier"),
        }
    )
    human_review_reason = candidate.get("humanReviewReason") if "humanReviewReason" in candidate else candidate.get("human_review_reason")
    if human_review_reason is None and unique_violations:
        human_review_reason = "Verifier blocked the tailored output."
    return {
        "pass": passed and len(unique_violations) == 0,
        "violations": unique_violations,
        "retryInstructions": retry_instructions,
        "qualityScore": quality_score,
        "humanReviewReason": str(human_review_reason) if human_review_reason is not None else None,
        "providerMetadata": provider_metadata,
    }


def verify_tailored_patch_with_ollama(base_document: Dict[str, Any], patch: Dict[str, Any], job_profile: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not load_worker_config()["use_ollama_verifier"]:
        return None
    heuristic = verify_tailored_patch_local(base_document, patch, job_profile)
    system_prompt = (
        "You are a strict resume verifier. Return JSON only with keys: pass, violations, retryInstructions, qualityScore, humanReviewReason. "
        "Each violation must be an object with type and message. Allowed types: unsupported_claim, invented_metric, invented_tool, missing_required_keyword, format_violation, keyword_stuffing. "
        "Block invented facts, unsupported technologies, unsupported metrics, schema violations, and weak coverage of primary requirements."
    )
    candidate = ollama_chat_json(
        system_prompt,
        {
            "jobProfile": job_profile,
            "baseResume": base_document.get("resumeData") or {},
            "patch": patch,
        },
        temperature=0.0,
        model=get_stage_model("verifier"),
    )
    if not candidate:
        return None
    if isinstance(candidate.get("verifier"), dict):
        candidate = candidate.get("verifier")
    merged_violations = list(heuristic.get("violations") or [])
    for item in candidate.get("violations") or []:
        merged_violations.append(item)
    merged_candidate = dict(candidate)
    merged_candidate["violations"] = merged_violations
    return sanitize_verifier_result(merged_candidate, heuristic, "ollama+heuristic")


def process_next_task_once() -> Dict[str, Any]:
    config = load_worker_config()
    state = update_worker_state(
        enabled=bool(config["enabled"]),
        workerId=str(config["worker_id"]),
        taskApiBaseUrl=str(config["task_api_base_url"]),
        taskTypes=list(config["task_types"]),
        pollIntervalMs=int(config["poll_interval_ms"]),
        ollamaBaseUrl=str(config["ollama_base_url"]),
        ollamaModel=str(config["ollama_model"]),
        ollamaExtractModel=str(config["ollama_extract_model"]),
        ollamaGenerationModel=str(config["ollama_generation_model"]),
        ollamaVerifierModel=str(config["ollama_verifier_model"]),
        ollamaEmbedModel=str(config["ollama_embed_model"]),
        fastembedModel=str(config["fastembed_model"]),
        fastembedAvailable=bool(config["fastembed_available"]),
        useOllamaExtraction=bool(config["use_ollama_extraction"]),
        useOllamaRanking=bool(config["use_ollama_ranking"]),
        useFastembedRanking=bool(config["use_fastembed_ranking"]),
        useOllamaGeneration=bool(config["use_ollama_generation"]),
        useOllamaVerifier=bool(config["use_ollama_verifier"]),
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
            str(config["task_api_base_url"]) + "/api/unified/tasks/process-next",
            payload,
            headers={
                "x-unified-worker-token": str(config["worker_token"]),
                "x-unified-worker-id": str(config["worker_id"]),
            },
            timeout_seconds=int(config["ollama_timeout_seconds"]),
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


app = FastAPI(title="Unified Tailor AI Worker", version="0.4.0")


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
    ollama = get_ollama_status()
    return {
        "status": "ok",
        "service": "unified-ai-worker",
        "worker": {
            "enabled": state.enabled,
            "running": state.running,
            "workerId": state.workerId,
            "taskApiBaseUrl": state.taskApiBaseUrl,
            "ollamaBaseUrl": state.ollamaBaseUrl,
            "ollamaModel": state.ollamaModel,
            "ollamaExtractModel": state.ollamaExtractModel,
            "ollamaGenerationModel": state.ollamaGenerationModel,
            "ollamaVerifierModel": state.ollamaVerifierModel,
            "ollamaEmbedModel": state.ollamaEmbedModel,
            "fastembedModel": state.fastembedModel,
            "fastembedAvailable": state.fastembedAvailable,
            "useOllamaExtraction": state.useOllamaExtraction,
            "useOllamaRanking": state.useOllamaRanking,
            "useFastembedRanking": state.useFastembedRanking,
            "useOllamaGeneration": state.useOllamaGeneration,
            "useOllamaVerifier": state.useOllamaVerifier,
        },
        "providers": {
            "extraction": "ollama" if state.useOllamaExtraction else "heuristic",
            "ranking": get_ranking_embedding_provider(),
            "generation": "ollama" if state.useOllamaGeneration else "heuristic",
            "verifier": "ollama" if state.useOllamaVerifier else "heuristic",
            "fallbacksEnabled": True,
        },
        "ollama": ollama,
        "fastembed": get_fastembed_status(),
    }


@app.get("/worker/status")
def worker_status() -> Dict[str, Any]:
    state = snapshot_worker_state().model_dump()
    state["providers"] = {
        "extraction": "ollama" if state.get("useOllamaExtraction") else "heuristic",
        "ranking": get_ranking_embedding_provider(),
        "generation": "ollama" if state.get("useOllamaGeneration") else "heuristic",
        "verifier": "ollama" if state.get("useOllamaVerifier") else "heuristic",
        "fallbacksEnabled": True,
    }
    state["ollama"] = get_ollama_status()
    state["fastembed"] = get_fastembed_status()
    return state


@app.post("/worker/run-once")
def worker_run_once() -> Dict[str, Any]:
    return process_next_task_once()


@app.post("/pipeline/extract-job-profile")
def pipeline_extract_job_profile(
    payload: ExtractJobProfileRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    job_profile = extract_job_profile_with_ollama(payload) or extract_job_profile_local(payload)
    return {"jobProfile": job_profile}


@app.post("/pipeline/rank")
def pipeline_rank(
    payload: RankRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    results = rank_resumes_with_ollama(payload.jobProfile.model_dump(), payload.resumes) or rank_resumes_local(payload.jobProfile.model_dump(), payload.resumes)
    return {"results": results}


@app.post("/pipeline/generate-tailor")
def pipeline_generate_tailor(
    payload: GenerateTailorRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    patch = generate_tailored_patch_with_ollama(payload.baseDocument, payload.jobProfile.model_dump(), payload.match, payload.providerId)
    if patch is None:
        patch = generate_tailored_patch_local(payload.baseDocument, payload.jobProfile.model_dump(), payload.match, payload.providerId)
    return {"patch": patch}


@app.post("/pipeline/verify-tailor")
def pipeline_verify_tailor(
    payload: VerifierRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    verifier = verify_tailored_patch_with_ollama(payload.baseResume, payload.patch, payload.jobProfile.model_dump())
    if verifier is None:
        verifier = verify_tailored_patch_local(payload.baseResume, payload.patch, payload.jobProfile.model_dump())
    return {"verifier": verifier}


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
