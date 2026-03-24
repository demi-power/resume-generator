# Unified AI Worker

This service is the Python-side worker for the unified tailor platform.

Current role:
- exposes health and contract endpoints
- polls the Next.js task API in the background when enabled
- drains queued `job_extract`, `job_rank`, and `tailor_local` tasks through the private worker token path
- keeps a small runtime status surface at `/worker/status`

Current limitation:
- task execution still happens in the Next.js unified store/runtime
- this worker is an unattended queue runner today, not yet the final home of extraction, ranking, and verification logic

Private deployment model:
- run on the same host or private network as the Next.js server
- do not expose it publicly
- configure it with a private worker token shared with the Next.js app

## Environment

Required to enable polling:

```bash
UNIFIED_WORKER_ENABLED=1
UNIFIED_WORKER_TOKEN=replace-me
UNIFIED_TASK_API_BASE_URL=http://127.0.0.1:3000
```

Optional:

```bash
UNIFIED_WORKER_ID=python-worker
UNIFIED_WORKER_POLL_INTERVAL_MS=3000
UNIFIED_WORKER_TASK_TYPES=job_extract,job_rank,tailor_local
UNIFIED_WORKER_LOG_LEVEL=INFO
```

The Next.js app must be started with the same `UNIFIED_WORKER_TOKEN` so `/api/unified/tasks/process-next` accepts the internal worker requests.

## Run locally

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

Useful endpoints:
- `GET /health`
- `GET /worker/status`
- `POST /worker/run-once`
- `POST /contracts/rank`
- `POST /contracts/verify`
