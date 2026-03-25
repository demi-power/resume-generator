import { rawDb } from "@/lib/db";
import { buildTailoredResume, extractJobProfile, fetchJobContent, generateTailoredPatch, rankResumeDocuments, verifyTailoredPatch } from "@/lib/unified/engine";
import { extractJobProfileFromWorker, generateTailoredPatchFromWorker, rankResumeDocumentsFromWorker, verifyTailoredPatchFromWorker } from "@/lib/unified/worker-client";
import { parseImportedResumeHtml } from "@/lib/unified/resume-parser";
import { renderResumeDataToHtml, renderResumePdfBuffer } from "@/lib/unified/render";
import { readUnifiedArtifactText, writeStagingHtml, writeUnifiedArtifact } from "@/lib/unified/storage";
import type {
  GenerationProviderId,
  ImportedResumeDocument,
  JobProfile,
  JobStatus,
  RankedResumeCandidate,
  ResumePatch,
  ResumeSyncManifestFile,
  ResumeSyncPrepareResult,
  TailorTaskStatus,
  VerifierResult,
} from "@/lib/unified/types";
import { canonicalizeJobUrl, createId, nowIso, safeJsonParse, sanitizeRelativePath } from "@/lib/unified/utils";
import { enqueueUnifiedTask, listUnifiedTasks } from "@/lib/unified/queue";

rawDb.exec(`
CREATE TABLE IF NOT EXISTS resume_sync_runs (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL,
  is_full_sync INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS resume_sync_files (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  compare_status TEXT NOT NULL,
  upload_status TEXT NOT NULL,
  staging_path TEXT,
  snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_variants (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  source_relative_path TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  current_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_snapshots (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  parent_snapshot_id TEXT,
  source_content_hash TEXT,
  job_id TEXT,
  status TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  text_content TEXT NOT NULL,
  summary_text TEXT,
  skills_json TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  chunks_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_records (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_intake_items (
  id TEXT PRIMARY KEY,
  submitted_by TEXT,
  source_type TEXT NOT NULL,
  raw_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title_hint TEXT,
  company_hint TEXT,
  batch_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  existing_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  intake_item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  processing_stage TEXT NOT NULL,
  raw_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT,
  company TEXT,
  location TEXT,
  work_model TEXT,
  seniority TEXT,
  description_text TEXT,
  fetch_method TEXT,
  error_code TEXT,
  error_message TEXT,
  job_profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_fetch_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  method TEXT NOT NULL,
  result_code TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  excerpt TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_results (
  id TEXT PRIMARY KEY,
  match_run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  resume_snapshot_id TEXT NOT NULL,
  resume_variant_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  similarity_score REAL NOT NULL,
  rule_score REAL NOT NULL,
  rerank_score REAL NOT NULL,
  hybrid_score REAL NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  matched_requirements_json TEXT NOT NULL,
  missing_requirements_json TEXT NOT NULL,
  supporting_chunk_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tailor_tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  match_run_id TEXT NOT NULL,
  match_result_id TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  requested_by TEXT,
  claimed_by TEXT,
  gpt_chat_url TEXT,
  resume_patch_json TEXT,
  verifier_result_id TEXT,
  tailored_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifier_results (
  id TEXT PRIMARY KEY,
  tailor_task_id TEXT NOT NULL,
  pass INTEGER NOT NULL,
  quality_score REAL NOT NULL,
  violations_json TEXT NOT NULL,
  retry_instructions_json TEXT NOT NULL,
  human_review_reason TEXT,
  created_at TEXT NOT NULL
);
`);

interface VariantRow {
  id: string;
  profile_name: string;
  variant_name: string;
  source_relative_path: string;
  archived: number;
  current_snapshot_id: string | null;
}

interface SnapshotRow {
  id: string;
  variant_id: string;
  snapshot_kind: "imported" | "tailored";
  parent_snapshot_id: string | null;
  source_content_hash: string | null;
  job_id: string | null;
  status: string;
  is_current: number;
  text_content: string;
  summary_text: string | null;
  skills_json: string;
  structured_json: string;
  chunks_json: string;
  created_at: string;
  updated_at: string;
}

function insertArtifact(ownerType: string, ownerId: string, artifactKind: string, relativePath: string, mimeType: string, sizeBytes: number, metadata: Record<string, unknown> = {}): void {
  rawDb.prepare(
    "INSERT INTO artifact_records (id, owner_type, owner_id, artifact_kind, relative_path, mime_type, size_bytes, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(createId(), ownerType, ownerId, artifactKind, relativePath, mimeType, sizeBytes, JSON.stringify(metadata), nowIso());
}

function getVariantBySourcePath(relativePath: string): VariantRow | undefined {
  return rawDb.prepare("SELECT id, profile_name, variant_name, source_relative_path, archived, current_snapshot_id FROM resume_variants WHERE source_relative_path = ?").get(relativePath) as VariantRow | undefined;
}

function getSnapshot(id: string): SnapshotRow | undefined {
  return rawDb.prepare("SELECT id, variant_id, snapshot_kind, parent_snapshot_id, source_content_hash, job_id, status, is_current, text_content, summary_text, skills_json, structured_json, chunks_json, created_at, updated_at FROM resume_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
}

function getJob(id: string): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function getLatestMatchRun(jobId: string): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM match_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
}

function getVerifierResult(id: string | null | undefined): Record<string, unknown> | undefined {
  if (!id) return undefined;
  return rawDb.prepare("SELECT * FROM verifier_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function loadImportedDocument(snapshot: SnapshotRow): ImportedResumeDocument {
  return safeJsonParse(snapshot.structured_json, {} as ImportedResumeDocument);
}

function persistImportedSnapshot(variant: VariantRow, sourceHash: string, document: ImportedResumeDocument, html: string): string {
  const snapshotId = createId();
  const now = nowIso();
  rawDb.prepare("UPDATE resume_snapshots SET is_current = 0 WHERE variant_id = ? AND snapshot_kind = 'imported'").run(variant.id);
  rawDb.prepare(
    "INSERT INTO resume_snapshots (id, variant_id, snapshot_kind, parent_snapshot_id, source_content_hash, job_id, status, is_current, text_content, summary_text, skills_json, structured_json, chunks_json, created_at, updated_at) VALUES (?, ?, 'imported', NULL, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    snapshotId,
    variant.id,
    sourceHash,
    "active",
    document.rawText,
    document.resumeData.profile.summary,
    JSON.stringify(document.resumeData.skills),
    JSON.stringify(document),
    JSON.stringify(document.chunks),
    now,
    now
  );
  rawDb.prepare("UPDATE resume_variants SET archived = 0, current_snapshot_id = ?, updated_at = ? WHERE id = ?").run(snapshotId, now, variant.id);

  const basePath = ["workspace", "default", "resumes", variant.id, snapshotId];
  const sourceArtifact = writeUnifiedArtifact(basePath, "source.html", html);
  const resumeArtifact = writeUnifiedArtifact(basePath, "resume.json", JSON.stringify(document, null, 2));
  const chunkArtifact = writeUnifiedArtifact(basePath, "chunks.json", JSON.stringify(document.chunks, null, 2));
  insertArtifact("resume_snapshot", snapshotId, "source_html", sourceArtifact.relativePath, "text/html", sourceArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "resume_json", resumeArtifact.relativePath, "application/json", resumeArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "chunks_json", chunkArtifact.relativePath, "application/json", chunkArtifact.sizeBytes);
  return snapshotId;
}

function persistTailoredSnapshot(params: {
  baseSnapshot: SnapshotRow;
  jobId: string;
  jobProfile: JobProfile;
  match: RankedResumeCandidate;
  patch: ResumePatch;
  verifier: VerifierResult;
}): string {
  const baseDocument = loadImportedDocument(params.baseSnapshot);
  const tailoredResume = buildTailoredResume(baseDocument, params.patch);
  const snapshotId = createId();
  const now = nowIso();
  const status = params.verifier.pass ? "active" : "manual_review_required";
  rawDb.prepare(
    "INSERT INTO resume_snapshots (id, variant_id, snapshot_kind, parent_snapshot_id, source_content_hash, job_id, status, is_current, text_content, summary_text, skills_json, structured_json, chunks_json, created_at, updated_at) VALUES (?, ?, 'tailored', ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    snapshotId,
    params.baseSnapshot.variant_id,
    params.baseSnapshot.id,
    params.jobId,
    status,
    JSON.stringify(tailoredResume),
    tailoredResume.profile.summary,
    JSON.stringify(tailoredResume.skills),
    JSON.stringify({
      ...baseDocument,
      resumeData: tailoredResume,
      appliedPatch: params.patch,
      verifier: params.verifier,
    }),
    JSON.stringify(baseDocument.chunks),
    now,
    now
  );
  const html = renderResumeDataToHtml(tailoredResume, {
    heading: params.jobProfile.company || "Tailored Resume",
    subheading: params.jobProfile.title,
  });
  const basePath = ["workspace", "default", "jobs", params.jobId, "tailored", snapshotId];
  const resumeArtifact = writeUnifiedArtifact(basePath, "resume.json", JSON.stringify(tailoredResume, null, 2));
  const htmlArtifact = writeUnifiedArtifact(basePath, "resume.html", html);
  const jobArtifact = writeUnifiedArtifact(basePath, "job.json", JSON.stringify(params.jobProfile, null, 2));
  const matchArtifact = writeUnifiedArtifact(basePath, "match.json", JSON.stringify(params.match, null, 2));
  const verifyArtifact = writeUnifiedArtifact(basePath, "verify.json", JSON.stringify(params.verifier, null, 2));
  insertArtifact("resume_snapshot", snapshotId, "resume_json", resumeArtifact.relativePath, "application/json", resumeArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "resume_html", htmlArtifact.relativePath, "text/html", htmlArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "job_json", jobArtifact.relativePath, "application/json", jobArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "match_json", matchArtifact.relativePath, "application/json", matchArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "verify_json", verifyArtifact.relativePath, "application/json", verifyArtifact.sizeBytes);
  return snapshotId;
}

async function persistTailoredPdf(snapshotId: string, jobId: string, resumeHtml: string): Promise<void> {
  const pdfBuffer = await renderResumePdfBuffer(resumeHtml);
  const artifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId, "tailored", snapshotId], "resume.pdf", pdfBuffer);
  insertArtifact("resume_snapshot", snapshotId, "resume_pdf", artifact.relativePath, "application/pdf", artifact.sizeBytes);
}

export function prepareResumeSync(params: {
  requestedBy?: string | null;
  rootPath: string;
  isFullSync?: boolean;
  files: ResumeSyncManifestFile[];
}): ResumeSyncPrepareResult {
  const now = nowIso();
  const syncRunId = createId();
  const isFullSync = params.isFullSync !== false;
  rawDb.prepare(
    "INSERT INTO resume_sync_runs (id, root_path, requested_by, status, is_full_sync, manifest_json, summary_json, created_at, updated_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  ).run(syncRunId, params.rootPath.trim(), params.requestedBy ?? null, "prepared", isFullSync ? 1 : 0, JSON.stringify(params.files), JSON.stringify({}), now, now);

  const counts = { new: 0, changed: 0, unchanged: 0, missing: 0 };
  const preparedFiles = params.files.map((file) => {
    const relativePath = sanitizeRelativePath(file.relativePath);
    const variant = getVariantBySourcePath(relativePath);
    const currentSnapshot = variant?.current_snapshot_id ? getSnapshot(variant.current_snapshot_id) : undefined;
    const compareStatus = !variant || !currentSnapshot
      ? "new"
      : currentSnapshot.source_content_hash === file.contentHash
      ? "unchanged"
      : "changed";
    counts[compareStatus] += 1;
    rawDb.prepare(
      "INSERT INTO resume_sync_files (id, sync_run_id, relative_path, content_hash, size_bytes, mtime_ms, compare_status, upload_status, staging_path, snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)"
    ).run(createId(), syncRunId, relativePath, file.contentHash, file.size, file.mtimeMs, compareStatus, compareStatus === "unchanged" ? "skipped" : "pending", now, now);
    return {
      ...file,
      relativePath,
      compareStatus,
      uploadStatus: compareStatus === "unchanged" ? "skipped" : "pending",
    };
  });

  if (isFullSync) {
    const existing = rawDb.prepare("SELECT source_relative_path FROM resume_variants WHERE archived = 0").all() as Array<{ source_relative_path: string }>;
    const incoming = new Set(preparedFiles.map((file) => file.relativePath));
    for (const row of existing) {
      if (!incoming.has(row.source_relative_path)) {
        counts.missing += 1;
        rawDb.prepare(
          "INSERT INTO resume_sync_files (id, sync_run_id, relative_path, content_hash, size_bytes, mtime_ms, compare_status, upload_status, staging_path, snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 'missing', 'skipped', NULL, NULL, ?, ?)"
        ).run(createId(), syncRunId, row.source_relative_path, "", now, now);
      }
    }
  }

  return {
    syncRunId,
    status: "prepared",
    counts,
    files: rawDb.prepare("SELECT relative_path, content_hash, size_bytes, mtime_ms, compare_status, upload_status FROM resume_sync_files WHERE sync_run_id = ? ORDER BY relative_path ASC").all(syncRunId).map((row) => ({
      relativePath: (row as Record<string, string>).relative_path,
      contentHash: (row as Record<string, string>).content_hash,
      size: Number((row as Record<string, number>).size_bytes),
      mtimeMs: Number((row as Record<string, number>).mtime_ms),
      compareStatus: (row as Record<string, string>).compare_status as ResumeSyncPrepareResult["files"][number]["compareStatus"],
      uploadStatus: (row as Record<string, string>).upload_status as ResumeSyncPrepareResult["files"][number]["uploadStatus"],
    })),
  };
}

export function uploadResumeSyncFile(params: { syncRunId: string; relativePath: string; html: string }): { ok: true; relativePath: string } {
  const relativePath = sanitizeRelativePath(params.relativePath);
  const staging = writeStagingHtml(params.syncRunId, relativePath, params.html);
  rawDb.prepare("UPDATE resume_sync_files SET staging_path = ?, upload_status = 'uploaded', updated_at = ? WHERE sync_run_id = ? AND relative_path = ?").run(staging.relativePath, nowIso(), params.syncRunId, relativePath);
  rawDb.prepare("UPDATE resume_sync_runs SET status = 'uploading', updated_at = ? WHERE id = ?").run(nowIso(), params.syncRunId);
  return { ok: true, relativePath };
}

export function getResumeSyncRun(syncRunId: string): Record<string, unknown> | undefined {
  const run = rawDb.prepare("SELECT * FROM resume_sync_runs WHERE id = ?").get(syncRunId) as Record<string, unknown> | undefined;
  if (!run) return undefined;
  const files = rawDb.prepare("SELECT * FROM resume_sync_files WHERE sync_run_id = ? ORDER BY relative_path ASC").all(syncRunId);
  return { ...run, files };
}

export function commitResumeSyncRun(syncRunId: string): Record<string, unknown> {
  const run = getResumeSyncRun(syncRunId);
  if (!run) throw new Error("Sync run not found");
  rawDb.prepare("UPDATE resume_sync_runs SET status = 'processing', updated_at = ? WHERE id = ?").run(nowIso(), syncRunId);
  const files = rawDb.prepare("SELECT * FROM resume_sync_files WHERE sync_run_id = ? ORDER BY relative_path ASC").all(syncRunId) as Array<Record<string, unknown>>;
  let processed = 0;
  let archived = 0;
  let failed = 0;
  for (const file of files) {
    const relativePath = String(file.relative_path);
    const compareStatus = String(file.compare_status);
    if (compareStatus === "missing") {
      rawDb.prepare("UPDATE resume_variants SET archived = 1, updated_at = ? WHERE source_relative_path = ?").run(nowIso(), relativePath);
      archived += 1;
      continue;
    }
    if (compareStatus === "unchanged") continue;
    const stagingPath = String(file.staging_path || "");
    if (!stagingPath) {
      failed += 1;
      continue;
    }
    const html = readUnifiedArtifactText(stagingPath);
    const document = parseImportedResumeHtml(relativePath, html);
    let variant = getVariantBySourcePath(relativePath);
    if (!variant) {
      const now = nowIso();
      variant = {
        id: createId(),
        profile_name: document.source.profileName,
        variant_name: document.source.variantName,
        source_relative_path: relativePath,
        archived: 0,
        current_snapshot_id: null,
      };
      rawDb.prepare(
        "INSERT INTO resume_variants (id, profile_name, variant_name, source_relative_path, archived, current_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)"
      ).run(variant.id, variant.profile_name, variant.variant_name, variant.source_relative_path, now, now);
    }
    const snapshotId = persistImportedSnapshot(variant, String(file.content_hash || ""), document, html);
    rawDb.prepare("UPDATE resume_sync_files SET snapshot_id = ?, updated_at = ? WHERE id = ?").run(snapshotId, nowIso(), file.id);
    processed += 1;
  }
  const finalStatus = failed > 0 ? "partial" : "completed";
  rawDb.prepare("UPDATE resume_sync_runs SET status = ?, summary_json = ?, updated_at = ?, committed_at = ? WHERE id = ?").run(
    finalStatus,
    JSON.stringify({ processed, archived, failed }),
    nowIso(),
    nowIso(),
    syncRunId
  );
  return getResumeSyncRun(syncRunId)!;
}

export function enqueueJobExtraction(jobId: string, requestedBy?: string | null): Record<string, unknown> | null {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const status = String(job.status || "queued") as JobStatus;
  if (["extracted", "ranked", "completed"].includes(status)) return null;
  return enqueueUnifiedTask({ taskType: "job_extract", requestedBy: requestedBy ?? null, jobId, payload: { jobId } }) as unknown as Record<string, unknown>;
}

export function enqueueJobRanking(jobId: string, requestedBy?: string | null): Record<string, unknown> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  rawDb.prepare("UPDATE jobs SET processing_stage = 'ranking', updated_at = ? WHERE id = ?").run(nowIso(), jobId);
  return enqueueUnifiedTask({ taskType: "job_rank", requestedBy: requestedBy ?? null, jobId, payload: { jobId }, priority: 200 }) as unknown as Record<string, unknown>;
}

export function createJobsFromUrls(params: {
  submittedBy?: string | null;
  sourceType: "url" | "csv";
  urls: Array<{ url: string; titleHint?: string | null; companyHint?: string | null; batchId?: string | null }>;
}): Array<Record<string, unknown>> {
  const created: Array<Record<string, unknown>> = [];
  for (const entry of params.urls) {
    const normalized = canonicalizeJobUrl(entry.url);
    const now = nowIso();
    if (!normalized) {
      rawDb.prepare(
        "INSERT INTO job_intake_items (id, submitted_by, source_type, raw_url, canonical_url, title_hint, company_hint, batch_id, status, error_code, error_message, existing_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'INVALID_URL', 'Invalid URL', NULL, ?, ?)"
      ).run(createId(), params.submittedBy ?? null, params.sourceType, entry.url, entry.url, entry.titleHint ?? null, entry.companyHint ?? null, entry.batchId ?? null, now, now);
      continue;
    }
    const existingJob = rawDb.prepare("SELECT * FROM jobs WHERE canonical_url = ? ORDER BY created_at DESC LIMIT 1").get(normalized.canonicalUrl) as Record<string, unknown> | undefined;
    const intakeId = createId();
    if (existingJob) {
      rawDb.prepare(
        "INSERT INTO job_intake_items (id, submitted_by, source_type, raw_url, canonical_url, title_hint, company_hint, batch_id, status, error_code, error_message, existing_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deduped', NULL, NULL, ?, ?, ?)"
      ).run(intakeId, params.submittedBy ?? null, params.sourceType, normalized.rawUrl, normalized.canonicalUrl, entry.titleHint ?? null, entry.companyHint ?? null, entry.batchId ?? null, existingJob.id, now, now);
      created.push(existingJob);
      continue;
    }
    rawDb.prepare(
      "INSERT INTO job_intake_items (id, submitted_by, source_type, raw_url, canonical_url, title_hint, company_hint, batch_id, status, error_code, error_message, existing_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)"
    ).run(intakeId, params.submittedBy ?? null, params.sourceType, normalized.rawUrl, normalized.canonicalUrl, entry.titleHint ?? null, entry.companyHint ?? null, entry.batchId ?? null, now, now);
    const jobId = createId();
    rawDb.prepare(
      "INSERT INTO jobs (id, intake_item_id, status, processing_stage, raw_url, canonical_url, title, company, location, work_model, seniority, description_text, fetch_method, error_code, error_message, job_profile_json, created_at, updated_at) VALUES (?, ?, 'queued', 'queued', ?, ?, ?, ?, '', '', '', '', '', NULL, NULL, '{}', ?, ?)"
    ).run(jobId, intakeId, normalized.rawUrl, normalized.canonicalUrl, entry.titleHint ?? null, entry.companyHint ?? null, now, now);
    created.push(getJob(jobId)!);
  }
  return created;
}

export function getJobStatus(jobId: string): Record<string, unknown> | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  const fetchAttempts = rawDb.prepare("SELECT * FROM job_fetch_attempts WHERE job_id = ? ORDER BY created_at ASC").all(jobId);
  const latestMatchRun = getLatestMatchRun(jobId);
  const latestTailorTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
  const latestVerifierResult = getVerifierResult((latestTailorTask?.verifier_result_id as string | null | undefined) ?? null);
  const matchResults = listMatchResults(jobId);
  const unifiedTasks = listUnifiedTasks({ jobId, limit: 20 }) as unknown as Array<Record<string, unknown>>;
  return { ...job, fetchAttempts, latestMatchRun, latestTailorTask, latestVerifierResult, matchResults, unifiedTasks };
}

export async function ensureJobExtracted(jobId: string): Promise<Record<string, unknown>> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const currentStatus = String(job.status || "queued") as JobStatus;
  if (["extracted", "ranking", "ranked", "tailoring", "completed", "manual_review_required"].includes(currentStatus)) {
    return job;
  }
  rawDb.prepare("UPDATE jobs SET status = 'fetching', processing_stage = 'fetching', updated_at = ? WHERE id = ?").run(nowIso(), jobId);
  const intakeItem = rawDb.prepare("SELECT * FROM job_intake_items WHERE id = ?").get(job.intake_item_id) as Record<string, unknown> | undefined;
  const result = await fetchJobContent(String(job.canonical_url));
  rawDb.prepare(
    "INSERT INTO job_fetch_attempts (id, job_id, method, result_code, status_code, error_message, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(createId(), jobId, result.method, result.code, result.statusCode ?? null, result.error ?? null, result.text.slice(0, 1200), nowIso());
  if (result.code !== "SUCCESS") {
    const status = result.code === "EXPIRED" ? "failed" : result.code === "AUTH_REQUIRED" || result.code === "CAPTCHA_BLOCKED" || result.code === "CONTENT_TOO_THIN" ? "manual_review_required" : "failed";
    rawDb.prepare("UPDATE jobs SET status = ?, processing_stage = 'fetching', fetch_method = ?, error_code = ?, error_message = ?, description_text = ?, updated_at = ? WHERE id = ?").run(
      status,
      result.method,
      result.code,
      result.error ?? null,
      result.text,
      nowIso(),
      jobId
    );
    if (result.rawHtml) {
      const artifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], "source.html", result.rawHtml);
      insertArtifact("job", jobId, "source_html", artifact.relativePath, "text/html", artifact.sizeBytes);
    }
    return getJob(jobId)!;
  }
  rawDb.prepare("UPDATE jobs SET status = 'extracting', processing_stage = 'extracting', fetch_method = ?, description_text = ?, updated_at = ? WHERE id = ?").run(result.method, result.text, nowIso(), jobId);
  const jobProfileInput = {
    pageTitle: result.title,
    descriptionText: result.text,
    titleHint: intakeItem?.title_hint as string | null | undefined,
    companyHint: intakeItem?.company_hint as string | null | undefined,
  };
  const jobProfile = (await extractJobProfileFromWorker(jobProfileInput)) ?? extractJobProfile(jobProfileInput);
  rawDb.prepare(
    "UPDATE jobs SET status = 'extracted', processing_stage = 'extracted', title = ?, company = ?, location = ?, work_model = ?, seniority = ?, job_profile_json = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?"
  ).run(jobProfile.title, jobProfile.company, jobProfile.location, jobProfile.workModel, jobProfile.seniority, JSON.stringify(jobProfile), nowIso(), jobId);
  const htmlArtifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], "source.html", result.rawHtml);
  const profileArtifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], "job.json", JSON.stringify(jobProfile, null, 2));
  insertArtifact("job", jobId, "source_html", htmlArtifact.relativePath, "text/html", htmlArtifact.sizeBytes);
  insertArtifact("job", jobId, "job_json", profileArtifact.relativePath, "application/json", profileArtifact.sizeBytes);
  return getJob(jobId)!;
}

export async function runRankingForJob(jobId: string): Promise<Record<string, unknown>> {
  const job = await ensureJobExtracted(jobId);
  if (String(job.status) !== "extracted" && String(job.status) !== "ranked") {
    return { job: getJob(jobId), matchRun: null, results: [] };
  }
  const jobProfile = safeJsonParse(job.job_profile_json as string, {} as JobProfile);
  const snapshots = rawDb.prepare(
    "SELECT s.id AS snapshot_id, s.variant_id, s.structured_json, v.profile_name, v.variant_name FROM resume_snapshots s JOIN resume_variants v ON v.id = s.variant_id WHERE s.snapshot_kind = 'imported' AND s.is_current = 1 AND v.archived = 0 ORDER BY v.profile_name ASC, v.variant_name ASC"
  ).all() as Array<{ snapshot_id: string; variant_id: string; structured_json: string; profile_name: string; variant_name: string }>;
  const documents = snapshots.map((row) => ({
    snapshotId: row.snapshot_id,
    variantId: row.variant_id,
    profileName: row.profile_name,
    variantName: row.variant_name,
    document: safeJsonParse(row.structured_json, {} as ImportedResumeDocument),
  }));
  const results = (await rankResumeDocumentsFromWorker(jobProfile, documents)) ?? rankResumeDocuments(jobProfile, documents);
  const runId = createId();
  rawDb.prepare("INSERT INTO match_runs (id, job_id, status, summary_json, created_at, updated_at) VALUES (?, ?, 'completed', ?, ?, ?)").run(
    runId,
    jobId,
    JSON.stringify({ resultCount: results.length }),
    nowIso(),
    nowIso()
  );
  rawDb.prepare("UPDATE jobs SET status = 'ranked', processing_stage = 'ranked', updated_at = ? WHERE id = ?").run(nowIso(), jobId);
  const insertResult = rawDb.prepare(
    "INSERT INTO match_results (id, match_run_id, job_id, resume_snapshot_id, resume_variant_id, profile_name, variant_name, similarity_score, rule_score, rerank_score, hybrid_score, decision, reason, matched_requirements_json, missing_requirements_json, supporting_chunk_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const result of results) {
    insertResult.run(
      createId(),
      runId,
      jobId,
      result.resumeSnapshotId,
      result.resumeVariantId,
      result.profileName,
      result.variantName,
      result.similarityScore,
      result.ruleScore,
      result.rerankScore,
      result.hybridScore,
      result.decision,
      result.reason,
      JSON.stringify(result.matchedRequirements),
      JSON.stringify(result.missingRequirements),
      JSON.stringify(result.supportingChunkIds),
      nowIso()
    );
  }
  const artifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], `match-${runId}.json`, JSON.stringify(results, null, 2));
  insertArtifact("match_run", runId, "match_json", artifact.relativePath, "application/json", artifact.sizeBytes);
  return { job: getJob(jobId), matchRun: rawDb.prepare("SELECT * FROM match_runs WHERE id = ?").get(runId), results: listMatchResults(jobId) };
}

export function listMatchResults(jobId: string): Array<Record<string, unknown>> {
  return rawDb.prepare(
    "SELECT * FROM match_results WHERE job_id = ? ORDER BY hybrid_score DESC, created_at ASC"
  ).all(jobId) as Array<Record<string, unknown>>;
}

function createVerifierRecord(taskId: string, verifier: VerifierResult): string {
  const verifierId = createId();
  rawDb.prepare(
    "INSERT INTO verifier_results (id, tailor_task_id, pass, quality_score, violations_json, retry_instructions_json, human_review_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    verifierId,
    taskId,
    verifier.pass ? 1 : 0,
    verifier.qualityScore,
    JSON.stringify(verifier.violations),
    JSON.stringify(verifier.retryInstructions),
    verifier.humanReviewReason,
    nowIso()
  );
  return verifierId;
}

export async function createTailorTask(params: {
  jobId: string;
  matchResultId: string;
  provider: GenerationProviderId;
  requestedBy?: string | null;
}): Promise<Record<string, unknown>> {
  const matchRow = rawDb.prepare("SELECT * FROM match_results WHERE id = ?").get(params.matchResultId) as Record<string, unknown> | undefined;
  if (!matchRow) throw new Error("Match result not found");
  const baseSnapshot = getSnapshot(String(matchRow.resume_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const taskId = createId();
  const initialStatus: TailorTaskStatus = params.provider === "deepseek_webview" ? "awaiting_claim" : "queued";
  rawDb.prepare(
    "INSERT INTO tailor_tasks (id, job_id, match_run_id, match_result_id, base_snapshot_id, provider, status, retries, max_retries, requested_by, claimed_by, gpt_chat_url, resume_patch_json, verifier_result_id, tailored_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 2, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)"
  ).run(taskId, params.jobId, String(matchRow.match_run_id), params.matchResultId, baseSnapshot.id, params.provider, initialStatus, params.requestedBy ?? null, nowIso(), nowIso());
  rawDb.prepare("UPDATE jobs SET status = 'tailoring', processing_stage = 'tailoring', updated_at = ? WHERE id = ?").run(nowIso(), params.jobId);
  if (params.provider !== "deepseek_webview") {
    enqueueUnifiedTask({
      taskType: "tailor_local",
      requestedBy: params.requestedBy ?? null,
      jobId: params.jobId,
      tailorTaskId: taskId,
      payload: { taskId, provider: params.provider },
      priority: 300,
    });
  }
  return rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
}

export async function runLocalTailorTask(taskId: string, _payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (String(task.provider) !== "local_ollama") throw new Error("Tailor task is not a local generator task");
  const baseSnapshot = getSnapshot(String(task.base_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const job = await ensureJobExtracted(String(task.job_id));
  const jobProfile = safeJsonParse(job.job_profile_json as string, {} as JobProfile);
  const matchRow = rawDb.prepare("SELECT * FROM match_results WHERE id = ?").get(task.match_result_id) as Record<string, unknown> | undefined;
  if (!matchRow) throw new Error("Match result not found");
  const match = {
    resumeSnapshotId: String(matchRow.resume_snapshot_id),
    resumeVariantId: String(matchRow.resume_variant_id),
    profileName: String(matchRow.profile_name),
    variantName: String(matchRow.variant_name),
    similarityScore: Number(matchRow.similarity_score),
    ruleScore: Number(matchRow.rule_score),
    rerankScore: Number(matchRow.rerank_score),
    hybridScore: Number(matchRow.hybrid_score),
    decision: String(matchRow.decision) as RankedResumeCandidate["decision"],
    reason: String(matchRow.reason),
    matchedRequirements: safeJsonParse(matchRow.matched_requirements_json as string, [] as string[]),
    missingRequirements: safeJsonParse(matchRow.missing_requirements_json as string, [] as string[]),
    supportingChunkIds: safeJsonParse(matchRow.supporting_chunk_ids_json as string, [] as string[]),
  } satisfies RankedResumeCandidate;
  rawDb.prepare("UPDATE tailor_tasks SET status = 'verifying', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
  const baseDocument = loadImportedDocument(baseSnapshot);
  const patch = (await generateTailoredPatchFromWorker(baseDocument, jobProfile, match, "local_ollama")) ?? generateTailoredPatch(baseDocument, jobProfile, match, "local_ollama");
  const verifier = (await verifyTailoredPatchFromWorker(baseDocument, patch, jobProfile)) ?? verifyTailoredPatch(baseDocument, patch, jobProfile);
  const verifierId = createVerifierRecord(taskId, verifier);
  let status: TailorTaskStatus = verifier.pass ? "completed" : "manual_review_required";
  let tailoredSnapshotId: string | null = null;
  rawDb.prepare("UPDATE tailor_tasks SET status = ?, resume_patch_json = ?, verifier_result_id = ?, retries = retries + 1, updated_at = ? WHERE id = ?").run(
    status,
    JSON.stringify(patch),
    verifierId,
    nowIso(),
    taskId
  );
  if (verifier.pass) {
    tailoredSnapshotId = persistTailoredSnapshot({ baseSnapshot, jobId: String(task.job_id), jobProfile, match, patch, verifier });
    const htmlArtifact = rawDb.prepare("SELECT relative_path FROM artifact_records WHERE owner_type = 'resume_snapshot' AND owner_id = ? AND artifact_kind = 'resume_html' ORDER BY created_at DESC LIMIT 1").get(tailoredSnapshotId) as { relative_path: string } | undefined;
    if (htmlArtifact?.relative_path) {
      await persistTailoredPdf(tailoredSnapshotId, String(task.job_id), readUnifiedArtifactText(htmlArtifact.relative_path));
    }
    rawDb.prepare("UPDATE tailor_tasks SET tailored_snapshot_id = ?, updated_at = ? WHERE id = ?").run(tailoredSnapshotId, nowIso(), taskId);
    rawDb.prepare("UPDATE jobs SET status = 'completed', processing_stage = 'completed', updated_at = ? WHERE id = ?").run(nowIso(), String(task.job_id));
  } else {
    rawDb.prepare("UPDATE jobs SET status = 'manual_review_required', processing_stage = 'tailoring', updated_at = ? WHERE id = ?").run(nowIso(), String(task.job_id));
  }
  return rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
}

export function claimTailorTask(taskId: string, claimedBy?: string | null): Record<string, unknown> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  rawDb.prepare("UPDATE tailor_tasks SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?").run(claimedBy ?? null, nowIso(), taskId);
  return rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
}

export async function submitDeepseekTailorTask(params: {
  taskId: string;
  gptChatUrl?: string | null;
  patch: ResumePatch;
}): Promise<Record<string, unknown>> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(params.taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  const baseSnapshot = getSnapshot(String(task.base_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const job = await ensureJobExtracted(String(task.job_id));
  const jobProfile = safeJsonParse(job.job_profile_json as string, {} as JobProfile);
  const matchRow = rawDb.prepare("SELECT * FROM match_results WHERE id = ?").get(task.match_result_id) as Record<string, unknown>;
  const match = {
    resumeSnapshotId: String(matchRow.resume_snapshot_id),
    resumeVariantId: String(matchRow.resume_variant_id),
    profileName: String(matchRow.profile_name),
    variantName: String(matchRow.variant_name),
    similarityScore: Number(matchRow.similarity_score),
    ruleScore: Number(matchRow.rule_score),
    rerankScore: Number(matchRow.rerank_score),
    hybridScore: Number(matchRow.hybrid_score),
    decision: String(matchRow.decision) as RankedResumeCandidate["decision"],
    reason: String(matchRow.reason),
    matchedRequirements: safeJsonParse(matchRow.matched_requirements_json as string, [] as string[]),
    missingRequirements: safeJsonParse(matchRow.missing_requirements_json as string, [] as string[]),
    supportingChunkIds: safeJsonParse(matchRow.supporting_chunk_ids_json as string, [] as string[]),
  } satisfies RankedResumeCandidate;
  const baseDocument = loadImportedDocument(baseSnapshot);
  const verifier = (await verifyTailoredPatchFromWorker(baseDocument, params.patch, jobProfile)) ?? verifyTailoredPatch(baseDocument, params.patch, jobProfile);
  const verifierId = createVerifierRecord(params.taskId, verifier);
  let status: TailorTaskStatus = verifier.pass ? "completed" : "manual_review_required";
  let tailoredSnapshotId: string | null = null;
  rawDb.prepare("UPDATE tailor_tasks SET status = ?, gpt_chat_url = ?, resume_patch_json = ?, verifier_result_id = ?, retries = retries + 1, updated_at = ? WHERE id = ?").run(
    status,
    params.gptChatUrl ?? null,
    JSON.stringify(params.patch),
    verifierId,
    nowIso(),
    params.taskId
  );
  if (verifier.pass) {
    tailoredSnapshotId = persistTailoredSnapshot({ baseSnapshot, jobId: String(task.job_id), jobProfile, match, patch: params.patch, verifier });
    const htmlArtifact = rawDb.prepare("SELECT relative_path FROM artifact_records WHERE owner_type = 'resume_snapshot' AND owner_id = ? AND artifact_kind = 'resume_html' ORDER BY created_at DESC LIMIT 1").get(tailoredSnapshotId) as { relative_path: string } | undefined;
    if (htmlArtifact?.relative_path) {
      await persistTailoredPdf(tailoredSnapshotId, String(task.job_id), readUnifiedArtifactText(htmlArtifact.relative_path));
    }
    rawDb.prepare("UPDATE tailor_tasks SET tailored_snapshot_id = ?, updated_at = ? WHERE id = ?").run(tailoredSnapshotId, nowIso(), params.taskId);
    rawDb.prepare("UPDATE jobs SET status = 'completed', processing_stage = 'completed', updated_at = ? WHERE id = ?").run(nowIso(), String(task.job_id));
  } else {
    rawDb.prepare("UPDATE jobs SET status = 'manual_review_required', processing_stage = 'tailoring', updated_at = ? WHERE id = ?").run(nowIso(), String(task.job_id));
  }
  return rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(params.taskId) as Record<string, unknown>;
}

export function getTailoredArtifacts(snapshotId: string): Array<Record<string, unknown>> {
  return rawDb.prepare("SELECT * FROM artifact_records WHERE owner_type = 'resume_snapshot' AND owner_id = ? ORDER BY created_at ASC").all(snapshotId) as Array<Record<string, unknown>>;
}
