# Unified AI Worker

This service is the Python-side worker for the unified tailor platform.

Current role:
- polls the Next.js task API in the background when enabled
- drains queued `job_extract`, `job_rank`, and `tailor_local` tasks through the private worker token path
- exposes private pipeline endpoints for job-profile extraction, ranking, tailored-patch generation, and verification
- keeps a runtime status surface at `/worker/status`

Current limitation:
- task orchestration and persistence still live in the Next.js unified store/runtime
- the worker now supports local provider-backed extraction, ranking, generation, and verification, but it still falls back to heuristics and does not yet own persistence or job orchestration

Private deployment model:
- run on the same host or private network as the Next.js server
- do not expose it publicly
- use one private token for `worker -> Next` task polling and one optional private token for `Next -> worker` pipeline calls

## Environment

Copy [.env.example](/media/demi0/New%20Volume/Projects/Real/resume-generator/services/ai-worker/.env.example) to `.env` in this folder or export the same variables before starting the worker.

Worker queue polling:

```bash
UNIFIED_WORKER_ENABLED=1
UNIFIED_WORKER_TOKEN=replace-me
UNIFIED_TASK_API_BASE_URL=http://127.0.0.1:3000
```

Worker runtime options:

```bash
UNIFIED_WORKER_ID=python-worker
UNIFIED_WORKER_POLL_INTERVAL_MS=3000
UNIFIED_WORKER_TASK_TYPES=job_extract,job_rank,tailor_local
UNIFIED_WORKER_LOG_LEVEL=INFO
```

Optional local model settings for the private pipeline endpoints:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
LOCAL_OLLAMA_MODEL=qwen3:8b
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_TIMEOUT_SECONDS=120
UNIFIED_WORKER_USE_OLLAMA_EXTRACTION=1
UNIFIED_WORKER_USE_OLLAMA_RANKING=1
UNIFIED_WORKER_USE_OLLAMA_GENERATION=1
UNIFIED_WORKER_USE_OLLAMA_VERIFIER=1

FASTEMBED_MODEL=BAAI/bge-small-en-v1.5
UNIFIED_WORKER_USE_FASTEMBED_RANKING=0
```

Current provider behavior:
- extraction can use Ollama JSON prompting with heuristic fallback
- ranking uses FastEmbed/BGE when `fastembed` is installed and `UNIFIED_WORKER_USE_FASTEMBED_RANKING=1`
- ranking otherwise falls back to Ollama embeddings if `UNIFIED_WORKER_USE_OLLAMA_RANKING=1`
- tailored-patch generation can use Ollama JSON prompting with heuristic fallback
- verifier can use Ollama JSON prompting merged with heuristic guardrails
- on this machine right now `fastembed` is not installed, so the active local embedding path remains Ollama or heuristics

Optional worker API token for private pipeline calls from Next.js:

```bash
UNIFIED_AI_WORKER_TOKEN=replace-me
```

The Next.js app should use matching worker-call settings:

```bash
UNIFIED_AI_WORKER_BASE_URL=http://127.0.0.1:8100
UNIFIED_AI_WORKER_TOKEN=replace-me
UNIFIED_AI_WORKER_STRICT=1
```

`UNIFIED_WORKER_TOKEN` is for worker-to-Next task polling.
`UNIFIED_AI_WORKER_TOKEN` is for Next-to-worker pipeline requests.

## Run locally

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

Useful endpoints:
- `GET /health`
- `GET /worker/status`
- `POST /worker/run-once`
- `POST /pipeline/extract-job-profile`
- `POST /pipeline/rank`
- `POST /pipeline/generate-tailor`
- `POST /pipeline/verify-tailor`
- `POST /contracts/rank`
- `POST /contracts/verify`

`GET /health` and `GET /worker/status` now include provider mode and Ollama reachability details so you can tell whether the worker is actually using the configured local model runtime or falling back to heuristics.
