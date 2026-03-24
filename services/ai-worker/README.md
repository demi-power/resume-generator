# Unified AI Worker

This service is the Python-side worker for the unified tailor platform.

Current role:
- polls the Next.js task API in the background when enabled
- drains queued `job_extract`, `job_rank`, and `tailor_local` tasks through the private worker token path
- exposes private pipeline endpoints for job-profile extraction, ranking, tailored-patch generation, and verification
- keeps a runtime status surface at `/worker/status`

Current limitation:
- task orchestration and persistence still live in the Next.js unified store/runtime
- ranking, generation, and verification are worker-hosted heuristic implementations today; they are the seam where real model providers should be attached next

Private deployment model:
- run on the same host or private network as the Next.js server
- do not expose it publicly
- use one private token for `worker -> Next` task polling and one optional private token for `Next -> worker` pipeline calls

## Environment

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

Optional worker API token for private pipeline calls from Next.js:

```bash
UNIFIED_AI_WORKER_TOKEN=replace-me
```

The Next.js app should use matching worker-call settings:

```bash
UNIFIED_AI_WORKER_BASE_URL=http://127.0.0.1:8100
UNIFIED_AI_WORKER_TOKEN=replace-me
UNIFIED_AI_WORKER_STRICT=0
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
