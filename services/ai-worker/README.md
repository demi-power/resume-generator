# Unified AI Worker

This service is the Python-side scaffold for the unified tailor platform.

Current state:
- exposes health and contract endpoints only
- mirrors the request/response shapes used by the Next.js unified-platform routes
- intended future home for resume sync parsing, job extraction, ranking, and verifier execution

Intended deployment:
- private-only service on the same host or private network as the Next.js server
- backed by local Ollama / embedding runtime in hosted environments

Run locally once dependencies are installed:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```
