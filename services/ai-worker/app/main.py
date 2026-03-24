import json
import logging
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
        "api_token": os.getenv("UNIFIED_AI_WORKER_TOKEN", "").strip(),
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
    domains = infer_domain((profile.get("title") or "") + "\n" + (profile.get("summary") or "") + "\n" + "\n".join(str(item.get("description") or "") for item in experience))
    score = 0.0
    if job.get("seniority") != "unknown" and str(job.get("seniority") or "") in title:
        score += 0.4
    if any(domain in domains for domain in job.get("domain") or []):
        score += 0.4
    if job.get("workModel") != "unknown" and str(job.get("workModel") or "") in title:
        score += 0.2
    return clamp_score(score)


def chunk_support_score(job_tokens: List[str], document: Dict[str, Any]) -> Dict[str, Any]:
    ranked = []
    for chunk in document.get("chunks") or []:
        ranked.append({
            "id": str(chunk.get("id") or ""),
            "score": overlap_ratio(job_tokens, [str(item) for item in (chunk.get("keywords") or [])]),
        })
    ranked.sort(key=lambda item: item["score"], reverse=True)
    top = pick_top(ranked, 5)
    support_score = clamp_score(sum(item["score"] for item in top) / max(len(top), 1))
    chunk_ids = [item["id"] for item in top if item["score"] > 0 and item["id"]]
    return {"score": support_score, "chunkIds": chunk_ids}


def extract_job_profile_local(payload: ExtractJobProfileRequest) -> Dict[str, Any]:
    lines = [line.strip() for line in re.split(r"\n+", payload.descriptionText) if line.strip()]
    title_parts = extract_title_from_title_tag(payload.pageTitle)
    title = (payload.titleHint or "").strip() or title_parts["title"] or (lines[0] if lines else "Unknown Role")
    company = (payload.companyHint or "").strip() or title_parts["company"]
    technologies = extract_likely_technologies(payload.descriptionText)
    keywords = pick_top(unique_tokens(title + " " + payload.descriptionText), 30)
    primary_stack = technologies[:8]
    secondary_stack = technologies[8:16]
    tools = [item for item in technologies if item in {"AWS", "Azure", "GCP", "Docker", "Kubernetes", "Terraform", "GitHub Actions", "CircleCI", "Jenkins"}]
    hard_stops: List[str] = []
    haystack = payload.descriptionText.lower()
    if "clearance" in haystack:
        hard_stops.append("clearance")
    if "u.s. citizens" in haystack or "us citizens" in haystack:
        hard_stops.append("us_only")
    if "must be onsite" in haystack or "5 days onsite" in haystack:
        hard_stops.append("onsite_required")
    confidence = clamp_score((0.45 if primary_stack else 0.2) + (0.25 if title else 0.0) + (0.15 if company else 0.0) + (0.15 if len(keywords) > 10 else 0.05))
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
        "confidence": confidence,
    }


def rank_resumes_local(job_profile: Dict[str, Any], resumes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    job_tokens = unique_tokens(
        (job_profile.get("title") or "") + " " +
        (job_profile.get("summary") or "") + " " +
        " ".join(job_profile.get("primaryStack") or []) + " " +
        " ".join(job_profile.get("secondaryStack") or []) + " " +
        " ".join(job_profile.get("tools") or []) + " " +
        " ".join(job_profile.get("keywords") or [])
    )
    results: List[Dict[str, Any]] = []
    for resume in resumes:
        document = resume.get("document") or {}
        resume_data = document.get("resumeData") or {}
        profile = resume_data.get("profile") or {}
        skills = resume_data.get("skills") or []
        experience = resume_data.get("experience") or []
        resume_text = " ".join([
            str(profile.get("title") or ""),
            str(profile.get("summary") or ""),
            " ".join(str(item.get("name") or "") for item in skills),
            " ".join((str(item.get("company") or "") + " " + str(item.get("role") or "") + " " + str(item.get("description") or "")).strip() for item in experience),
        ])
        resume_tokens = unique_tokens(resume_text)
        similarity_score = clamp_score(overlap_ratio(job_tokens, resume_tokens))
        resume_skills = [str(item.get("name") or "").lower() for item in skills]
        must_have_coverage = overlap_ratio([str(item).lower() for item in (job_profile.get("primaryStack") or [])], resume_skills)
        secondary_coverage = overlap_ratio([str(item).lower() for item in ((job_profile.get("secondaryStack") or []) + (job_profile.get("tools") or []))], resume_skills)
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
            if matched_requirements else
            "Low must-have overlap; tailoring or manual review is required."
        )
        results.append({
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
        })
    results.sort(key=lambda item: item["hybridScore"], reverse=True)
    return results


def generate_tailored_patch_local(base_document: Dict[str, Any], job_profile: Dict[str, Any], match: Dict[str, Any], provider_id: str) -> Dict[str, Any]:
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
        experience_edits.append({
            "experienceId": str(item.get("id") or ""),
            "originalText": str(item.get("description") or ""),
            "tailoredText": str(item.get("description") or ""),
        })
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
            "configured_model": os.getenv("LOCAL_OLLAMA_MODEL", "qwen2.5:7b-instruct"),
        },
    }


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
        str(item).lower() for item in (
            [skill.get("name") for skill in skills] +
            list(job_profile.get("primaryStack") or []) +
            list(job_profile.get("secondaryStack") or []) +
            list(job_profile.get("tools") or [])
        ) if item
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
            "configured_model": os.getenv("LOCAL_OLLAMA_MODEL", "qwen2.5:7b-instruct"),
        },
    }


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


app = FastAPI(title="Unified Tailor AI Worker", version="0.3.0")


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


@app.post("/pipeline/extract-job-profile")
def pipeline_extract_job_profile(
    payload: ExtractJobProfileRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    return {"jobProfile": extract_job_profile_local(payload)}


@app.post("/pipeline/rank")
def pipeline_rank(
    payload: RankRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    return {"results": rank_resumes_local(payload.jobProfile.model_dump(), payload.resumes)}


@app.post("/pipeline/generate-tailor")
def pipeline_generate_tailor(
    payload: GenerateTailorRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    return {"patch": generate_tailored_patch_local(payload.baseDocument, payload.jobProfile.model_dump(), payload.match, payload.providerId)}


@app.post("/pipeline/verify-tailor")
def pipeline_verify_tailor(
    payload: VerifierRequest,
    x_unified_ai_worker_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_api_token(x_unified_ai_worker_token)
    return {"verifier": verify_tailored_patch_local(payload.baseResume, payload.patch, payload.jobProfile.model_dump())}


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
