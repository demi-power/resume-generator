# Tailor

Tailor is a local-first resume and job-application workspace. This repository contains a Next.js backend for storage, auth, PDF rendering, and AI endpoints, plus an Electron desktop client that provides the main day-to-day UI.

## What Is In This Repo

- `app/` Next.js 14 app and API routes
- `desktop/` Electron + Vite desktop client
- `lib/` SQLite, auth, PDF, templates, and shared app logic
- `data/` runtime data such as `app.db`, WAL files, and template style overrides
- `scripts/` helper scripts for PDF export and JSON-to-SQLite migration
- `doc/` implementation notes and product docs

## Current Feature Set

- Resume profiles stored in local SQLite at `data/app.db`
- Job application tracking tied to profiles and generated resume filenames
- Four resume templates: `format1` through `format4`
- PDF preview and export routes
- Template style overrides stored locally in development
- Admin/user auth with assigned-profile access control
- AI prompt management and DeepSeek-powered resume content generation
- Desktop-first workflow with a landing page on the public web entrypoint

## Run Locally

Use a current Node.js LTS release.

### 1. Start the Next.js backend

```bash
npm install
npm run dev
```

The server starts on `http://localhost:3000`.

Notes:

- Visiting `http://localhost:3000` shows the landing page.
- The interactive app is primarily used through the desktop client.
- If you need to inspect embedded routes directly in a browser during development, use URLs such as `http://localhost:3000/profile?embedded=1`.

### 2. Start the desktop client

```bash
cd desktop
npm install
npm run dev
```

When the desktop app opens:

1. Connect it to `127.0.0.1:3000` or another reachable host running the Next.js server.
2. If no users exist yet, create the first admin account.
3. Copy the generated one-time password when it is shown. It is not displayed again.

## Useful Commands

### Root App

- `npm run dev` starts the Next.js backend on `0.0.0.0:3000`
- `npm run build` creates a production build
- `npm run start` runs the production server
- `npm run lint` runs Next.js ESLint checks
- `npm run export:pdf` exports a resume PDF through the helper script
- `npm run migrate:json-to-sqlite` migrates older JSON-backed data into SQLite

### Desktop App

From `desktop/`:

- `npm run dev` builds and launches Electron locally
- `npm run build` builds the desktop assets
- `npm run pack` creates an unpacked Electron build
- `npm run dist` builds Windows distributables
- `npm run dist:portable` builds the portable Windows executable

## Configuration

Copy [.env.example](/media/demi0/New%20Volume/Projects/Real/resume-generator/.env.example) to `.env.local` or export the same variables before starting the Next.js server.

Optional environment variables used by the backend:

- `JWT_SECRET` for signing auth tokens
- `DEEPSEEK_API_KEY` default API key for AI generation
- `DEEPSEEK_MODEL` overrides the AI model, default `deepseek-chat`
- `DEEPSEEK_API_BASE` overrides the DeepSeek API base URL
- `DEEPSEEK_TEMPERATURE` overrides AI temperature
- `DEEPSEEK_MAX_TOKENS` overrides AI max tokens
- `DEEPSEEK_SYSTEM_MESSAGE` overrides the default AI system prompt
- `PDF_BASE_URL` base URL used by server-side PDF/export helpers
- `CRON_SECRET` optional secret for `/api/cron/clear-pdf-cache`
- `UNIFIED_WORKER_TOKEN` shared token that lets the private Python worker poll internal task APIs
- `UNIFIED_AI_WORKER_BASE_URL` private base URL for Next.js to call the Python worker directly
- `UNIFIED_AI_WORKER_TOKEN` optional private token for Next.js to authenticate direct worker pipeline calls
- `UNIFIED_AI_WORKER_STRICT` set to `1` to fail fast when the direct worker path is configured but unavailable

## Data And Persistence

- Main app data is stored in `data/app.db`
- SQLite WAL files are created next to the database during runtime
- Template style overrides are stored in `data/template-styles/*.json`
- Template style writes are allowed in development and blocked in production

## Notes

- The repository and package names still use `resume-builder`, but the product/UI name is `Tailor`.
- Windows packaging details for the desktop client are in `desktop/BUILD-EXE.md`.
- The `doc/` folder contains additional design and implementation notes.
