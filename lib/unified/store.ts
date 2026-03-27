import {
  buildJobApplicationResumeFileName,
  getJobApplicationByUnifiedJobId,
  getProfile,
  rawDb,
  syncJobApplicationForUnifiedJob,
  updateJobApplication,
  upsertJobApplicationForUnifiedJob,
} from "@/lib/db";
import { saveJobApplicationPdf } from "@/lib/job-application-pdf";
import { derivePdfBaseUrl, renderResumePdfFromFormat } from "@/lib/pdf-render";
import { formatIdToTemplateId } from "@/lib/template-style-file";
import {
  buildInteractiveTailorGenerationPrompt,
  buildInteractiveVerifierPrompt,
  buildTailoredResume,
  extractJobProfile,
  fetchJobContent,
  generateTailoredPatch,
  rankResumeDocuments,
  verifyTailoredPatch,
} from "@/lib/unified/engine";
import { extractJobProfileFromWorker, generateTailoredPatchFromWorker, rankResumeDocumentsFromWorker, verifyTailoredPatchFromWorker } from "@/lib/unified/worker-client";
import { parseImportedResumeHtml } from "@/lib/unified/resume-parser";
import { readUnifiedArtifact, readUnifiedArtifactText, writeStagingHtml, writeUnifiedArtifact } from "@/lib/unified/storage";
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
  VerifierProviderId,
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
  verifier_provider TEXT NOT NULL DEFAULT 'local_ollama',
  status TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  requested_by TEXT,
  claimed_by TEXT,
  verifier_claimed_by TEXT,
  gpt_chat_url TEXT,
  verifier_chat_url TEXT,
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

function ensureStoreColumn(tableName: string, columnName: string, definition: string): void {
  const columns = rawDb.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  if (columns.some((column) => column.name === columnName)) return;
  rawDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

ensureStoreColumn("tailor_tasks", "verifier_provider", "TEXT NOT NULL DEFAULT 'local_ollama'");
ensureStoreColumn("tailor_tasks", "verifier_claimed_by", "TEXT");
ensureStoreColumn("tailor_tasks", "verifier_chat_url", "TEXT");
ensureStoreColumn("jobs", "resume_format_id", "TEXT NOT NULL DEFAULT 'format1'");
ensureStoreColumn("jobs", "published_snapshot_id", "TEXT");
ensureStoreColumn("jobs", "published_at", "TEXT");

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

function normalizeResumeFormatId(value: string | null | undefined): string {
  return formatIdToTemplateId(value ?? "") ? String(value) : "format1";
}

function updateJobPresentation(jobId: string, updates: {
  resumeFormatId?: string | null;
  publishedSnapshotId?: string | null;
  publishedAt?: string | null;
}): void {
  rawDb.prepare(
    "UPDATE jobs SET resume_format_id = COALESCE(?, resume_format_id), published_snapshot_id = ?, published_at = ?, updated_at = ? WHERE id = ?"
  ).run(
    updates.resumeFormatId != null ? normalizeResumeFormatId(updates.resumeFormatId) : null,
    updates.publishedSnapshotId ?? null,
    updates.publishedAt ?? null,
    nowIso(),
    jobId
  );
}

function getLinkedApplication(jobId: string): Record<string, unknown> | null {
  const application = getJobApplicationByUnifiedJobId(jobId);
  return application ? ({ ...application } as unknown as Record<string, unknown>) : null;
}

function getResumeDataForSnapshot(snapshot: SnapshotRow): ImportedResumeDocument["resumeData"] {
  const structured = safeJsonParse(snapshot.structured_json, {} as ImportedResumeDocument & { resumeData?: ImportedResumeDocument["resumeData"] });
  if (structured.resumeData) return structured.resumeData;
  return safeJsonParse(snapshot.text_content, {} as ImportedResumeDocument["resumeData"]);
}

function getPublishedPdfArtifact(snapshotId: string | null | undefined): Record<string, unknown> | null {
  if (!snapshotId) return null;
  return (
    rawDb.prepare(
      "SELECT * FROM artifact_records WHERE owner_type = 'resume_snapshot' AND owner_id = ? AND artifact_kind = 'resume_pdf' ORDER BY created_at DESC LIMIT 1"
    ).get(snapshotId) as Record<string, unknown> | undefined
  ) ?? null;
}

function getLatestMatchRun(jobId: string): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM match_runs WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
}

function getVerifierResult(id: string | null | undefined): Record<string, unknown> | undefined {
  if (!id) return undefined;
  return rawDb.prepare("SELECT * FROM verifier_results WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function hydrateVerifierResultRecord(row: Record<string, unknown> | null | undefined): VerifierResult | null {
  if (!row) return null;
  return {
    pass: Number(row.pass || 0) === 1,
    qualityScore: Number(row.quality_score || 0),
    violations: safeJsonParse(String(row.violations_json || "[]"), [] as VerifierResult["violations"]),
    retryInstructions: safeJsonParse(String(row.retry_instructions_json || "[]"), [] as string[]),
    humanReviewReason: row.human_review_reason ? String(row.human_review_reason) : null,
    providerMetadata: {},
  };
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
  const basePath = ["workspace", "default", "jobs", params.jobId, "tailored", snapshotId];
  const resumeArtifact = writeUnifiedArtifact(basePath, "resume.json", JSON.stringify(tailoredResume, null, 2));
  const patchArtifact = writeUnifiedArtifact(basePath, "resume_patch.json", JSON.stringify(params.patch, null, 2));
  const jobArtifact = writeUnifiedArtifact(basePath, "job.json", JSON.stringify(params.jobProfile, null, 2));
  const matchArtifact = writeUnifiedArtifact(basePath, "match.json", JSON.stringify(params.match, null, 2));
  const verifyArtifact = writeUnifiedArtifact(basePath, "verify.json", JSON.stringify(params.verifier, null, 2));
  insertArtifact("resume_snapshot", snapshotId, "resume_json", resumeArtifact.relativePath, "application/json", resumeArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "resume_patch_json", patchArtifact.relativePath, "application/json", patchArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "job_json", jobArtifact.relativePath, "application/json", jobArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "match_json", matchArtifact.relativePath, "application/json", matchArtifact.sizeBytes);
  insertArtifact("resume_snapshot", snapshotId, "verify_json", verifyArtifact.relativePath, "application/json", verifyArtifact.sizeBytes);
  return snapshotId;
}

async function publishTailoredSnapshotForJob(params: {
  jobId: string;
  snapshotId: string;
  pdfBaseUrl?: string | null;
  resumeFormatId?: string | null;
}): Promise<{
  resumeFormatId: string;
  linkedApplication: Record<string, unknown>;
  pdfArtifact: Record<string, unknown> | null;
}> {
  const job = getJob(params.jobId);
  if (!job) throw new Error("Job not found");
  const snapshot = getSnapshot(params.snapshotId);
  if (!snapshot) throw new Error("Tailored snapshot not found");
  const resumeFormatId = normalizeResumeFormatId(params.resumeFormatId ?? String(job.resume_format_id || "format1"));
  const linkedApplication =
    syncJobApplicationForUnifiedJob(params.jobId, {
      company_name: String(job.company || ""),
      title: String(job.title || ""),
      job_url: String(job.raw_url || job.canonical_url || ""),
      job_description: String(job.description_text || ""),
      resume_format_id: resumeFormatId,
    }) ??
    upsertJobApplicationForUnifiedJob({
      unified_job_id: params.jobId,
      date: nowIso().slice(0, 10),
      company_name: String(job.company || ""),
      title: String(job.title || ""),
      job_url: String(job.raw_url || job.canonical_url || ""),
      job_description: String(job.description_text || ""),
      resume_format_id: resumeFormatId,
    });
  if (!linkedApplication) throw new Error("Failed to link application for publish");

  const resumeData = getResumeDataForSnapshot(snapshot);
  const renderResult = await renderResumePdfFromFormat({
    data: resumeData,
    formatId: resumeFormatId,
    baseUrl: derivePdfBaseUrl({ baseUrl: params.pdfBaseUrl ?? null }),
  });

  saveJobApplicationPdf(String(linkedApplication.id), renderResult.pdfBuffer);
  const profileName =
    linkedApplication.profile_id && typeof linkedApplication.profile_id === "string"
      ? getProfile(linkedApplication.profile_id)?.name ?? null
      : null;
  const fileName = buildJobApplicationResumeFileName({
    profileName,
    companyName: String(linkedApplication.company_name || job.company || ""),
    title: String(linkedApplication.title || job.title || ""),
    date: String(linkedApplication.date || nowIso().slice(0, 10)),
    formatId: resumeFormatId,
  });
  updateJobApplication(String(linkedApplication.id), {
    resume_file_name: fileName,
    resume_format_id: resumeFormatId,
  });

  const basePath = ["workspace", "default", "jobs", params.jobId, "tailored", params.snapshotId];
  const pdfArtifact = writeUnifiedArtifact(basePath, "resume.pdf", renderResult.pdfBuffer);
  replaceArtifactRecord("resume_snapshot", params.snapshotId, "resume_pdf", pdfArtifact.relativePath, "application/pdf", pdfArtifact.sizeBytes);
  const presentationPayload = {
    resume_format_id: resumeFormatId,
    templateId: renderResult.templateId,
    style: renderResult.effectiveStyle,
  };
  const presentationArtifact = writeUnifiedArtifact(basePath, "presentation.json", JSON.stringify(presentationPayload, null, 2));
  replaceArtifactRecord(
    "resume_snapshot",
    params.snapshotId,
    "presentation_json",
    presentationArtifact.relativePath,
    "application/json",
    presentationArtifact.sizeBytes,
    presentationPayload
  );
  const publishedAt = nowIso();
  updateJobPresentation(params.jobId, {
    resumeFormatId,
    publishedSnapshotId: params.snapshotId,
    publishedAt,
  });
  return {
    resumeFormatId,
    linkedApplication: (getLinkedApplication(params.jobId) ?? linkedApplication) as unknown as Record<string, unknown>,
    pdfArtifact: getPublishedPdfArtifact(params.snapshotId),
  };
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

function replaceArtifactRecord(ownerType: string, ownerId: string, artifactKind: string, relativePath: string, mimeType: string, sizeBytes: number, metadata: Record<string, unknown> = {}): void {
  rawDb.prepare("DELETE FROM artifact_records WHERE owner_type = ? AND owner_id = ? AND artifact_kind = ?").run(ownerType, ownerId, artifactKind);
  insertArtifact(ownerType, ownerId, artifactKind, relativePath, mimeType, sizeBytes, metadata);
}

function getJobIntakeItem(job: Record<string, unknown>): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM job_intake_items WHERE id = ?").get(job.intake_item_id) as Record<string, unknown> | undefined;
}

function updateIntakeItemForJob(jobId: string, status: string, errorCode?: string | null, errorMessage?: string | null): void {
  const job = getJob(jobId);
  if (!job) return;
  rawDb.prepare("UPDATE job_intake_items SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
    status,
    errorCode ?? null,
    errorMessage ?? null,
    nowIso(),
    job.intake_item_id
  );
}

function hydrateRankedCandidate(matchRow: Record<string, unknown>): RankedResumeCandidate {
  return {
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
  };
}

function getMatchResult(matchResultId: string): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM match_results WHERE id = ?").get(matchResultId) as Record<string, unknown> | undefined;
}

function updateJobStatusAndStage(jobId: string, status: JobStatus, processingStage: string, extras: {
  title?: string | null;
  company?: string | null;
  location?: string | null;
  workModel?: string | null;
  seniority?: string | null;
  descriptionText?: string | null;
  fetchMethod?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  jobProfileJson?: string | null;
} = {}): void {
  rawDb.prepare(
    "UPDATE jobs SET status = ?, processing_stage = ?, title = COALESCE(?, title), company = COALESCE(?, company), location = COALESCE(?, location), work_model = COALESCE(?, work_model), seniority = COALESCE(?, seniority), description_text = COALESCE(?, description_text), fetch_method = COALESCE(?, fetch_method), error_code = ?, error_message = ?, job_profile_json = COALESCE(?, job_profile_json), updated_at = ? WHERE id = ?"
  ).run(
    status,
    processingStage,
    extras.title ?? null,
    extras.company ?? null,
    extras.location ?? null,
    extras.workModel ?? null,
    extras.seniority ?? null,
    extras.descriptionText ?? null,
    extras.fetchMethod ?? null,
    extras.errorCode ?? null,
    extras.errorMessage ?? null,
    extras.jobProfileJson ?? null,
    nowIso(),
    jobId
  );
}

export function enqueueJobFetch(jobId: string, requestedBy?: string | null): Record<string, unknown> | null {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const status = String(job.status || "queued") as JobStatus;
  if (["fetched", "extracting", "extracted", "ranking", "ranked", "tailoring", "verifying", "completed"].includes(status)) {
    return null;
  }
  updateJobStatusAndStage(jobId, "queued", "queued_fetch", { errorCode: null, errorMessage: null });
  updateIntakeItemForJob(jobId, "queued", null, null);
  return enqueueUnifiedTask({ taskType: "job_fetch", requestedBy: requestedBy ?? null, jobId, payload: { jobId }, priority: 100 }) as unknown as Record<string, unknown>;
}

export function enqueueJobExtraction(jobId: string, requestedBy?: string | null): Record<string, unknown> | null {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const status = String(job.status || "queued") as JobStatus;
  if (["extracting", "extracted", "ranking", "ranked", "tailoring", "verifying", "completed"].includes(status)) {
    return null;
  }
  updateJobStatusAndStage(jobId, status === "failed" || status === "manual_review_required" ? "queued" : status, "queued_extract", { errorCode: null, errorMessage: null });
  return enqueueUnifiedTask({ taskType: "job_extract", requestedBy: requestedBy ?? null, jobId, payload: { jobId }, priority: 200 }) as unknown as Record<string, unknown>;
}

export function enqueueJobRanking(jobId: string, requestedBy?: string | null): Record<string, unknown> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const status = String(job.status || "queued") as JobStatus;
  updateJobStatusAndStage(jobId, status === "failed" ? "queued" : status, "queued_rank", { errorCode: null, errorMessage: null });
  return enqueueUnifiedTask({ taskType: "job_rank", requestedBy: requestedBy ?? null, jobId, payload: { jobId }, priority: 300 }) as unknown as Record<string, unknown>;
}

function enqueueTailorGeneration(jobId: string, tailorTaskId: string, requestedBy?: string | null): Record<string, unknown> {
  updateJobStatusAndStage(jobId, "tailoring", "queued_generate", { errorCode: null, errorMessage: null });
  return enqueueUnifiedTask({
    taskType: "tailor_generate",
    requestedBy: requestedBy ?? null,
    jobId,
    tailorTaskId,
    payload: { taskId: tailorTaskId },
    priority: 400,
  }) as unknown as Record<string, unknown>;
}

export function enqueueTailorVerify(jobId: string, tailorTaskId: string, requestedBy?: string | null): Record<string, unknown> {
  updateJobStatusAndStage(jobId, "verifying", "queued_verify", { errorCode: null, errorMessage: null });
  return enqueueUnifiedTask({
    taskType: "tailor_verify",
    requestedBy: requestedBy ?? null,
    jobId,
    tailorTaskId,
    payload: { taskId: tailorTaskId },
    priority: 450,
  }) as unknown as Record<string, unknown>;
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
      upsertJobApplicationForUnifiedJob({
        unified_job_id: String(existingJob.id),
        date: now.slice(0, 10),
        company_name: String(existingJob.company || entry.companyHint || ""),
        title: String(existingJob.title || entry.titleHint || ""),
        job_url: String(existingJob.raw_url || existingJob.canonical_url || normalized.rawUrl),
        job_description: String(existingJob.description_text || ""),
        resume_format_id: normalizeResumeFormatId(String(existingJob.resume_format_id || "format1")),
      });
      rawDb.prepare(
        "INSERT INTO job_intake_items (id, submitted_by, source_type, raw_url, canonical_url, title_hint, company_hint, batch_id, status, error_code, error_message, existing_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deduped', NULL, NULL, ?, ?, ?)"
      ).run(intakeId, params.submittedBy ?? null, params.sourceType, normalized.rawUrl, normalized.canonicalUrl, entry.titleHint ?? null, entry.companyHint ?? null, entry.batchId ?? null, existingJob.id, now, now);
      created.push({
        ...existingJob,
        batchId: entry.batchId ?? null,
        linkedApplication: getLinkedApplication(String(existingJob.id)),
      });
      continue;
    }
    rawDb.prepare(
      "INSERT INTO job_intake_items (id, submitted_by, source_type, raw_url, canonical_url, title_hint, company_hint, batch_id, status, error_code, error_message, existing_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)"
    ).run(intakeId, params.submittedBy ?? null, params.sourceType, normalized.rawUrl, normalized.canonicalUrl, entry.titleHint ?? null, entry.companyHint ?? null, entry.batchId ?? null, now, now);
    const jobId = createId();
    rawDb.prepare(
      "INSERT INTO jobs (id, intake_item_id, status, processing_stage, raw_url, canonical_url, title, company, location, work_model, seniority, description_text, fetch_method, error_code, error_message, job_profile_json, resume_format_id, published_snapshot_id, published_at, created_at, updated_at) VALUES (?, ?, 'queued', 'queued_fetch', ?, ?, ?, ?, '', '', '', '', NULL, NULL, NULL, '{}', 'format1', NULL, NULL, ?, ?)"
    ).run(jobId, intakeId, normalized.rawUrl, normalized.canonicalUrl, entry.titleHint ?? null, entry.companyHint ?? null, now, now);
    upsertJobApplicationForUnifiedJob({
      unified_job_id: jobId,
      date: now.slice(0, 10),
      company_name: entry.companyHint ?? "",
      title: entry.titleHint ?? "",
      job_url: normalized.rawUrl,
      job_description: "",
      resume_format_id: "format1",
    });
    const jobRecord = getJob(jobId);
    if (jobRecord) {
      created.push({
        ...jobRecord,
        batchId: entry.batchId ?? null,
        linkedApplication: getLinkedApplication(jobId),
      });
    }
  }
  return created;
}

export function getUnifiedJobSummary(jobId: string): Record<string, unknown> | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  const intakeItem = getJobIntakeItem(job);
  const latestMatchRun = getLatestMatchRun(jobId);
  const latestTailorTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
  const latestVerifierResult = getVerifierResult((latestTailorTask?.verifier_result_id as string | null | undefined) ?? null);
  const publishedSnapshotId = job.published_snapshot_id ? String(job.published_snapshot_id) : null;
  return {
    ...job,
    batchId: intakeItem?.batch_id ?? null,
    latestMatchRun: latestMatchRun ?? null,
    latestTailorTask: latestTailorTask ?? null,
    latestVerifierResult: latestVerifierResult ?? null,
    publishedPdfArtifact: getPublishedPdfArtifact(publishedSnapshotId),
    linkedApplication: getLinkedApplication(jobId),
  };
}

export function getJobStatus(jobId: string): Record<string, unknown> | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  const summary = getUnifiedJobSummary(jobId) ?? job;
  const intakeItem = getJobIntakeItem(job);
  const fetchAttempts = rawDb.prepare("SELECT * FROM job_fetch_attempts WHERE job_id = ? ORDER BY created_at ASC").all(jobId);
  const latestMatchRun = getLatestMatchRun(jobId);
  const latestTailorTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
  const latestVerifierResult = getVerifierResult((latestTailorTask?.verifier_result_id as string | null | undefined) ?? null);
  const matchResults = listMatchResults(jobId);
  const unifiedTasks = listUnifiedTasks({ jobId, limit: 50 }) as unknown as Array<Record<string, unknown>>;
  const jobArtifacts = rawDb.prepare("SELECT * FROM artifact_records WHERE owner_type = 'job' AND owner_id = ? ORDER BY created_at ASC").all(jobId) as Array<Record<string, unknown>>;
  const latestTailoredArtifacts = latestTailorTask?.tailored_snapshot_id
    ? getTailoredArtifacts(String(latestTailorTask.tailored_snapshot_id))
    : [];
  const publishedSnapshotId = summary.published_snapshot_id ? String(summary.published_snapshot_id) : null;
  const publishedArtifacts = publishedSnapshotId ? getTailoredArtifacts(publishedSnapshotId) : [];
  return {
    ...summary,
    intakeItem,
    batchId: intakeItem?.batch_id ?? null,
    fetchAttempts,
    latestMatchRun,
    latestTailorTask,
    latestVerifierResult,
    matchResults,
    unifiedTasks,
    jobArtifacts,
    publishedArtifacts,
    publishedPdfArtifact: getPublishedPdfArtifact(publishedSnapshotId),
    artifacts: latestTailoredArtifacts,
  };
}

export function listJobs(filters: { batchId?: string | null; status?: string | null; limit?: number } = {}): Array<Record<string, unknown>> {
  const clauses = ["1 = 1"];
  const values: Array<string | number> = [];
  if (filters.batchId) {
    clauses.push("i.batch_id = ?");
    values.push(filters.batchId);
  }
  if (filters.status) {
    clauses.push("j.status = ?");
    values.push(filters.status);
  }
  const limit = Number.isFinite(filters.limit) ? Math.max(1, Number(filters.limit)) : 200;
  const rows = rawDb.prepare(
    `SELECT j.*, i.batch_id AS batchId FROM jobs j JOIN job_intake_items i ON i.id = j.intake_item_id WHERE ${clauses.join(" AND ")} ORDER BY j.created_at DESC LIMIT ${limit}`
  ).all(...values) as Array<Record<string, unknown>>;
  return rows.map((job) => {
    const latestTailorTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(String(job.id)) as Record<string, unknown> | undefined;
    return {
      ...job,
      latestMatchRun: getLatestMatchRun(String(job.id)) ?? null,
      latestTailorTask: latestTailorTask ?? null,
      latestVerifierResult: getVerifierResult((latestTailorTask?.verifier_result_id as string | null | undefined) ?? null) ?? null,
      linkedApplication: getLinkedApplication(String(job.id)),
    };
  });
}

export async function updateJobResumeFormat(params: {
  jobId: string;
  resumeFormatId: string;
  pdfBaseUrl?: string | null;
}): Promise<Record<string, unknown>> {
  const job = getJob(params.jobId);
  if (!job) throw new Error("Job not found");
  const resumeFormatId = normalizeResumeFormatId(params.resumeFormatId);
  const publishedSnapshotId = job.published_snapshot_id ? String(job.published_snapshot_id) : null;
  if (publishedSnapshotId) {
    await publishTailoredSnapshotForJob({
      jobId: params.jobId,
      snapshotId: publishedSnapshotId,
      pdfBaseUrl: params.pdfBaseUrl ?? null,
      resumeFormatId,
    });
  } else {
    updateJobPresentation(params.jobId, {
      resumeFormatId,
      publishedSnapshotId: null,
      publishedAt: null,
    });
    syncJobApplicationForUnifiedJob(params.jobId, { resume_format_id: resumeFormatId });
  }
  return getJobStatus(params.jobId) ?? getUnifiedJobSummary(params.jobId) ?? getJob(params.jobId) ?? {};
}

export async function ensureJobExtracted(jobId: string): Promise<Record<string, unknown>> {
  let job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const currentStatus = String(job.status || "queued") as JobStatus;
  if (["extracted", "ranking", "ranked", "tailoring", "verifying", "completed"].includes(currentStatus)) {
    return job;
  }
  if (!String(job.description_text || "").trim() || ["queued", "failed"].includes(currentStatus)) {
    job = await runJobFetchTask(jobId, { autoQueueNext: false });
  }
  const fetchedJob = getJob(jobId) ?? job;
  const fetchedStatus = String(fetchedJob.status || "queued") as JobStatus;
  if (!["fetched", "extracting", "extracted", "manual_review_required", "ranking", "ranked", "tailoring", "verifying", "completed"].includes(fetchedStatus)) {
    return fetchedJob;
  }
  const hasProfile = String(fetchedJob.job_profile_json || "{}").trim() !== "{}";
  if (!hasProfile || fetchedStatus === "fetched" || String(fetchedJob.processing_stage || "") === "fetched") {
    job = await runJobExtractTask(jobId, { autoQueueNext: false });
    return getJob(jobId) ?? job;
  }
  return fetchedJob;
}

export async function runJobFetchTask(jobId: string, options: { requestedBy?: string | null; autoQueueNext?: boolean } = {}): Promise<Record<string, unknown>> {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const currentStatus = String(job.status || "queued") as JobStatus;
  if (["fetched", "extracting", "extracted", "ranking", "ranked", "tailoring", "verifying", "completed"].includes(currentStatus) && String(job.description_text || "").trim()) {
    return job;
  }
  updateJobStatusAndStage(jobId, "fetching", "fetching", { errorCode: null, errorMessage: null });
  updateIntakeItemForJob(jobId, "fetching", null, null);
  const result = await fetchJobContent(String(job.canonical_url));
  rawDb.prepare(
    "INSERT INTO job_fetch_attempts (id, job_id, method, result_code, status_code, error_message, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(createId(), jobId, result.method, result.code, result.statusCode ?? null, result.error ?? null, result.text.slice(0, 1200), nowIso());
  if (result.rawHtml) {
    const sourceArtifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], "source.html", result.rawHtml);
    replaceArtifactRecord("job", jobId, "source_html", sourceArtifact.relativePath, "text/html", sourceArtifact.sizeBytes);
  }
  if (result.code !== "SUCCESS") {
    const manualReviewCodes = new Set(["AUTH_REQUIRED", "CAPTCHA_BLOCKED", "CONTENT_TOO_THIN"]);
    const nextStatus: JobStatus = manualReviewCodes.has(result.code) ? "manual_review_required" : "failed";
    updateJobStatusAndStage(jobId, nextStatus, nextStatus === "failed" ? "failed_fetch" : "fetch_review_required", {
      fetchMethod: result.method,
      descriptionText: result.text,
      errorCode: result.code,
      errorMessage: result.error ?? null,
    });
    updateIntakeItemForJob(jobId, nextStatus, result.code, result.error ?? null);
    syncJobApplicationForUnifiedJob(jobId, {
      job_url: String(job.raw_url || job.canonical_url || ""),
      job_description: result.text || null,
    });
    return getJob(jobId) ?? job;
  }
  updateJobStatusAndStage(jobId, "fetched", "fetched", {
    fetchMethod: result.method,
    descriptionText: result.text,
    errorCode: null,
    errorMessage: null,
  });
  updateIntakeItemForJob(jobId, "fetched", null, null);
  syncJobApplicationForUnifiedJob(jobId, {
    job_url: String(job.raw_url || job.canonical_url || ""),
    job_description: result.text || null,
  });
  if (options.autoQueueNext !== false) {
    enqueueJobExtraction(jobId, options.requestedBy ?? null);
  }
  return getJob(jobId) ?? job;
}

export async function runJobExtractTask(jobId: string, options: { requestedBy?: string | null; autoQueueNext?: boolean } = {}): Promise<Record<string, unknown>> {
  let job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  const currentStatus = String(job.status || "queued") as JobStatus;
  const hasExistingProfile = String(job.job_profile_json || "{}").trim() !== "{}";
  if (["extracting", "extracted", "ranking", "ranked", "tailoring", "verifying", "completed"].includes(currentStatus) && hasExistingProfile) {
    return job;
  }
  if (!String(job.description_text || "").trim()) {
    job = await runJobFetchTask(jobId, { requestedBy: options.requestedBy ?? null, autoQueueNext: false });
    const fetchedStatus = String(job.status || "queued") as JobStatus;
    if (fetchedStatus !== "fetched") {
      return job;
    }
  }
  const intakeItem = getJobIntakeItem(getJob(jobId) ?? job);
  updateJobStatusAndStage(jobId, "extracting", "extracting", { errorCode: null, errorMessage: null });
  updateIntakeItemForJob(jobId, "extracting", null, null);
  const latestJob = getJob(jobId) ?? job;
  const jobProfileInput = {
    pageTitle: String(latestJob.title || ""),
    descriptionText: String(latestJob.description_text || ""),
    titleHint: intakeItem?.title_hint as string | null | undefined,
    companyHint: intakeItem?.company_hint as string | null | undefined,
  };
  const jobProfile = (await extractJobProfileFromWorker(jobProfileInput)) ?? extractJobProfile(jobProfileInput);
  const extractionLowConfidence = Number(jobProfile.confidence || 0) < 0.35;
  updateJobStatusAndStage(jobId, extractionLowConfidence ? "manual_review_required" : "extracted", "extracted", {
    title: jobProfile.title,
    company: jobProfile.company,
    location: jobProfile.location,
    workModel: jobProfile.workModel,
    seniority: jobProfile.seniority,
    jobProfileJson: JSON.stringify(jobProfile),
    errorCode: extractionLowConfidence ? "EXTRACTION_LOW_CONFIDENCE" : null,
    errorMessage: extractionLowConfidence ? "Extraction confidence below auto-rank threshold" : null,
  });
  const profileArtifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], "job.json", JSON.stringify(jobProfile, null, 2));
  replaceArtifactRecord("job", jobId, "job_json", profileArtifact.relativePath, "application/json", profileArtifact.sizeBytes);
  updateIntakeItemForJob(jobId, extractionLowConfidence ? "manual_review_required" : "extracted", extractionLowConfidence ? "EXTRACTION_LOW_CONFIDENCE" : null, extractionLowConfidence ? "Extraction confidence below auto-rank threshold" : null);
  syncJobApplicationForUnifiedJob(jobId, {
    company_name: jobProfile.company,
    title: jobProfile.title,
    job_url: String(latestJob.raw_url || latestJob.canonical_url || ""),
    job_description: String(latestJob.description_text || ""),
  });
  if (!extractionLowConfidence && options.autoQueueNext !== false) {
    enqueueJobRanking(jobId, options.requestedBy ?? null);
  }
  return getJob(jobId) ?? job;
}

export async function runRankingForJob(jobId: string, options: { autoEnsureExtracted?: boolean; autoChain?: boolean; requestedBy?: string | null } = {}): Promise<Record<string, unknown>> {
  const ensuredJob = options.autoEnsureExtracted === false ? getJob(jobId) : await ensureJobExtracted(jobId);
  const job = ensuredJob ?? getJob(jobId);
  if (!job) throw new Error("Job not found");
  const profileJson = String(job.job_profile_json || "{}");
  if (profileJson.trim() === "{}") {
    return { job: getJob(jobId), matchRun: null, results: [] };
  }
  updateJobStatusAndStage(jobId, "ranking", "ranking", { errorCode: null, errorMessage: null });
  const jobProfile = safeJsonParse(profileJson, {} as JobProfile);
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
  const now = nowIso();
  rawDb.prepare("INSERT INTO match_runs (id, job_id, status, summary_json, created_at, updated_at) VALUES (?, ?, 'completed', ?, ?, ?)").run(
    runId,
    jobId,
    JSON.stringify({ resultCount: results.length }),
    now,
    now
  );
  const insertResult = rawDb.prepare(
    "INSERT INTO match_results (id, match_run_id, job_id, resume_snapshot_id, resume_variant_id, profile_name, variant_name, similarity_score, rule_score, rerank_score, hybrid_score, decision, reason, matched_requirements_json, missing_requirements_json, supporting_chunk_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  let topResultId: string | null = null;
  for (const result of results) {
    const resultId = createId();
    insertResult.run(
      resultId,
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
    if (!topResultId) {
      topResultId = resultId;
    }
  }
  const topResult = results[0] ?? null;
  let nextAction = "ranked";
  let createdTailorTask: Record<string, unknown> | null = null;
  if (topResult && topResultId && options.autoChain !== false) {
    if (topResult.decision === "review" || topResult.decision === "need_tailor") {
      createdTailorTask = await createTailorTask({
        jobId,
        matchResultId: topResultId,
        provider: "local_ollama",
        requestedBy: options.requestedBy ?? null,
      });
      nextAction = "tailor_generate";
    } else if (topResult.decision === "use_as_is") {
      updateJobStatusAndStage(jobId, "completed", "ranked", { errorCode: null, errorMessage: null });
      nextAction = "use_as_is";
    } else if (topResult.decision === "not_eligible") {
      updateJobStatusAndStage(jobId, "manual_review_required", "ranked", { errorCode: "NO_MATCH", errorMessage: topResult.reason });
      nextAction = "not_eligible";
    }
  }
  if (!topResult) {
    updateJobStatusAndStage(jobId, "manual_review_required", "ranked", { errorCode: "NO_MATCH", errorMessage: "No suitable resume snapshots were ranked for this job" });
    nextAction = "not_eligible";
  } else if (nextAction === "ranked") {
    updateJobStatusAndStage(jobId, "ranked", "ranked", { errorCode: null, errorMessage: null });
  }
  rawDb.prepare("UPDATE match_runs SET summary_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify({
      resultCount: results.length,
      topDecision: topResult?.decision ?? null,
      topMatchResultId: topResultId,
      nextAction,
      autoTailorTaskId: createdTailorTask?.id ?? null,
    }),
    nowIso(),
    runId
  );
  const artifact = writeUnifiedArtifact(["workspace", "default", "jobs", jobId], `match-${runId}.json`, JSON.stringify(results, null, 2));
  insertArtifact("match_run", runId, "match_json", artifact.relativePath, "application/json", artifact.sizeBytes);
  return {
    job: getJob(jobId),
    matchRun: rawDb.prepare("SELECT * FROM match_runs WHERE id = ?").get(runId),
    results: listMatchResults(jobId, { matchRunId: runId }),
    tailorTask: createdTailorTask,
  };
}

export function listMatchResults(jobId: string, options: { matchRunId?: string | null } = {}): Array<Record<string, unknown>> {
  const matchRunId = options.matchRunId ?? String(getLatestMatchRun(jobId)?.id ?? "");
  if (matchRunId) {
    return rawDb.prepare(
      "SELECT * FROM match_results WHERE job_id = ? AND match_run_id = ? ORDER BY hybrid_score DESC, created_at ASC"
    ).all(jobId, matchRunId) as Array<Record<string, unknown>>;
  }
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

async function finalizeTailorVerification(params: {
  taskId: string;
  task: Record<string, unknown>;
  baseSnapshot: SnapshotRow;
  jobProfile: JobProfile;
  match: RankedResumeCandidate;
  patch: ResumePatch;
  verifier: VerifierResult;
  verifierChatUrl?: string | null;
  pdfBaseUrl?: string | null;
}): Promise<Record<string, unknown>> {
  const verifierId = createVerifierRecord(params.taskId, params.verifier);
  if (params.verifier.pass) {
    const tailoredSnapshotId = persistTailoredSnapshot({
      baseSnapshot: params.baseSnapshot,
      jobId: String(params.task.job_id),
      jobProfile: params.jobProfile,
      match: params.match,
      patch: params.patch,
      verifier: params.verifier,
    });
    try {
      await publishTailoredSnapshotForJob({
        jobId: String(params.task.job_id),
        snapshotId: tailoredSnapshotId,
        pdfBaseUrl: params.pdfBaseUrl ?? null,
      });
      rawDb
        .prepare("UPDATE tailor_tasks SET status = 'completed', verifier_result_id = ?, verifier_chat_url = COALESCE(?, verifier_chat_url), tailored_snapshot_id = ?, updated_at = ? WHERE id = ?")
        .run(verifierId, params.verifierChatUrl ?? null, tailoredSnapshotId, nowIso(), params.taskId);
      updateJobStatusAndStage(String(params.task.job_id), "completed", "completed", { errorCode: null, errorMessage: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rawDb
        .prepare("UPDATE resume_snapshots SET status = 'manual_review_required', updated_at = ? WHERE id = ?")
        .run(nowIso(), tailoredSnapshotId);
      rawDb
        .prepare("UPDATE tailor_tasks SET status = 'manual_review_required', verifier_result_id = ?, verifier_chat_url = COALESCE(?, verifier_chat_url), tailored_snapshot_id = ?, updated_at = ? WHERE id = ?")
        .run(verifierId, params.verifierChatUrl ?? null, tailoredSnapshotId, nowIso(), params.taskId);
      updateJobStatusAndStage(String(params.task.job_id), "manual_review_required", "publish_failed", {
        errorCode: "PUBLISH_FAILED",
        errorMessage: message,
      });
    }
  } else {
    const retries = Number(params.task.retries || 0);
    const maxRetries = Number(params.task.max_retries || 0);
    if (retries <= maxRetries) {
      const provider = String(params.task.provider || "local_ollama");
      rawDb
        .prepare("UPDATE tailor_tasks SET status = ?, verifier_result_id = ?, verifier_chat_url = COALESCE(?, verifier_chat_url), claimed_by = NULL, verifier_claimed_by = NULL, updated_at = ? WHERE id = ?")
        .run(provider === "deepseek_webview" ? "awaiting_claim" : "queued", verifierId, params.verifierChatUrl ?? null, nowIso(), params.taskId);
      if (provider === "deepseek_webview") {
        updateJobStatusAndStage(String(params.task.job_id), "tailoring", "queued_generate", { errorCode: null, errorMessage: null });
      } else {
        enqueueTailorGeneration(
          String(params.task.job_id),
          params.taskId,
          (params.task.requested_by as string | null | undefined) ?? null
        );
      }
    } else {
      rawDb
        .prepare("UPDATE tailor_tasks SET status = 'manual_review_required', verifier_result_id = ?, verifier_chat_url = COALESCE(?, verifier_chat_url), updated_at = ? WHERE id = ?")
        .run(verifierId, params.verifierChatUrl ?? null, nowIso(), params.taskId);
      updateJobStatusAndStage(String(params.task.job_id), "manual_review_required", "verifying", {
        errorCode: "VERIFIER_FAILED",
        errorMessage: params.verifier.humanReviewReason ?? "Verifier blocked the tailored resume",
      });
    }
  }
  const updatedTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(params.taskId) as Record<string, unknown> | undefined;
  if (!updatedTask) throw new Error("Tailor task not found after verification");
  return updatedTask;
}

export function getTailorTask(taskId: string): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
}

export function getTailorTaskDetails(taskId: string): Record<string, unknown> | undefined {
  const task = getTailorTask(taskId);
  if (!task) return undefined;
  const verifierResult = getVerifierResult((task.verifier_result_id as string | null | undefined) ?? null);
  const artifacts = task.tailored_snapshot_id ? getTailoredArtifacts(String(task.tailored_snapshot_id)) : [];
  return {
    ...task,
    verifierResult: verifierResult ?? null,
    artifacts,
  };
}

export function listTailorTasks(filters: {
  provider?: GenerationProviderId | null;
  verifierProvider?: VerifierProviderId | null;
  statuses?: TailorTaskStatus[];
  limit?: number;
} = {}): Array<Record<string, unknown>> {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters.provider) {
    clauses.push("provider = ?");
    values.push(filters.provider);
  }
  if (filters.verifierProvider) {
    clauses.push("verifier_provider = ?");
    values.push(filters.verifierProvider);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
    values.push(...filters.statuses);
  }
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return rawDb.prepare(`SELECT * FROM tailor_tasks ${where} ORDER BY created_at ASC LIMIT ${limit}`).all(...values) as Array<Record<string, unknown>>;
}

export async function getTailorTaskPrompt(taskId: string, mode: "generation" | "verification"): Promise<string> {
  const task = getTailorTask(taskId);
  if (!task) throw new Error("Tailor task not found");
  const baseSnapshot = getSnapshot(String(task.base_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const baseDocument = loadImportedDocument(baseSnapshot);
  const job = await ensureJobExtracted(String(task.job_id));
  const jobProfile = safeJsonParse(String(job.job_profile_json || "{}"), {} as JobProfile);
  const matchRow = getMatchResult(String(task.match_result_id));
  if (!matchRow) throw new Error("Match result not found");
  const match = hydrateRankedCandidate(matchRow);
  if (mode === "generation") {
    const previousPatchJson = String(task.resume_patch_json || "").trim();
    const previousPatch = previousPatchJson ? safeJsonParse(previousPatchJson, {} as ResumePatch) : null;
    const verifier = hydrateVerifierResultRecord(getVerifierResult((task.verifier_result_id as string | null | undefined) ?? null));
    return buildInteractiveTailorGenerationPrompt(
      baseDocument,
      jobProfile,
      match,
      previousPatch || verifier
        ? {
            previousPatch,
            verifier,
            attempt: Number(task.retries || 0),
            maxAttempts: Number(task.max_retries || 0) + 1,
          }
        : undefined
    );
  }
  const patch = safeJsonParse(String(task.resume_patch_json || "{}"), {} as ResumePatch);
  if (!String(task.resume_patch_json || "").trim()) throw new Error("Tailor task does not have a generated patch yet");
  return buildInteractiveVerifierPrompt(baseDocument, jobProfile, patch);
}

export async function createTailorTask(params: {
  jobId: string;
  matchResultId: string;
  provider: GenerationProviderId;
  verifierProvider?: VerifierProviderId;
  requestedBy?: string | null;
}): Promise<Record<string, unknown>> {
  const matchRow = getMatchResult(params.matchResultId);
  if (!matchRow) throw new Error("Match result not found");
  const baseSnapshot = getSnapshot(String(matchRow.resume_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const existing = rawDb.prepare(
    "SELECT * FROM tailor_tasks WHERE job_id = ? AND match_result_id = ? AND provider = ? AND verifier_provider = ? AND status IN ('queued', 'awaiting_claim', 'claimed', 'awaiting_verifier_claim', 'verifier_claimed', 'generating', 'submitted', 'verifying') ORDER BY created_at DESC LIMIT 1"
  ).get(params.jobId, params.matchResultId, params.provider, params.verifierProvider ?? (params.provider === "deepseek_webview" ? "chatgpt_webview" : "local_ollama")) as Record<string, unknown> | undefined;
  if (existing) {
    return existing;
  }
  const taskId = createId();
  const initialStatus: TailorTaskStatus = params.provider === "deepseek_webview" ? "awaiting_claim" : "queued";
  const verifierProvider = params.verifierProvider ?? (params.provider === "deepseek_webview" ? "chatgpt_webview" : "local_ollama");
  rawDb.prepare(
    "INSERT INTO tailor_tasks (id, job_id, match_run_id, match_result_id, base_snapshot_id, provider, verifier_provider, status, retries, max_retries, requested_by, claimed_by, verifier_claimed_by, gpt_chat_url, verifier_chat_url, resume_patch_json, verifier_result_id, tailored_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 2, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)"
  ).run(taskId, params.jobId, String(matchRow.match_run_id), params.matchResultId, baseSnapshot.id, params.provider, verifierProvider, initialStatus, params.requestedBy ?? null, nowIso(), nowIso());
  if (params.provider === "deepseek_webview") {
    updateJobStatusAndStage(params.jobId, "tailoring", "queued_generate", { errorCode: null, errorMessage: null });
  } else {
    enqueueTailorGeneration(params.jobId, taskId, params.requestedBy ?? null);
  }
  const createdTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!createdTask) throw new Error("Failed to create tailor task");
  return createdTask;
}

export async function runLocalTailorGenerationTask(taskId: string, _payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (String(task.provider) !== "local_ollama") throw new Error("Tailor task is not a local generator task");
  const baseSnapshot = getSnapshot(String(task.base_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const job = await ensureJobExtracted(String(task.job_id));
  const jobProfile = safeJsonParse(String(job.job_profile_json || "{}"), {} as JobProfile);
  const matchRow = getMatchResult(String(task.match_result_id));
  if (!matchRow) throw new Error("Match result not found");
  const match = hydrateRankedCandidate(matchRow);
  updateJobStatusAndStage(String(task.job_id), "tailoring", "generating", { errorCode: null, errorMessage: null });
  rawDb.prepare("UPDATE tailor_tasks SET status = 'generating', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
  const baseDocument = loadImportedDocument(baseSnapshot);
  const patch = (await generateTailoredPatchFromWorker(baseDocument, jobProfile, match, "local_ollama")) ?? generateTailoredPatch(baseDocument, jobProfile, match, "local_ollama");
  rawDb.prepare("UPDATE tailor_tasks SET status = 'submitted', resume_patch_json = ?, retries = retries + 1, updated_at = ? WHERE id = ?").run(
    JSON.stringify(patch),
    nowIso(),
    taskId
  );
  if (String(task.verifier_provider || "local_ollama") === "chatgpt_webview") {
    rawDb.prepare("UPDATE tailor_tasks SET status = 'awaiting_verifier_claim', verifier_claimed_by = NULL, verifier_chat_url = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    updateJobStatusAndStage(String(task.job_id), "verifying", "queued_verify", { errorCode: null, errorMessage: null });
  } else {
    enqueueTailorVerify(String(task.job_id), taskId, (task.requested_by as string | null | undefined) ?? null);
  }
  const updatedTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!updatedTask) throw new Error("Tailor task not found after generation");
  return updatedTask;
}

export async function runTailorVerifyTask(taskId: string, _payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  const baseSnapshot = getSnapshot(String(task.base_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const resumePatchJson = String(task.resume_patch_json || "").trim();
  if (!resumePatchJson) throw new Error("Tailor task does not have a generated resume patch to verify");
  const job = await ensureJobExtracted(String(task.job_id));
  const jobProfile = safeJsonParse(String(job.job_profile_json || "{}"), {} as JobProfile);
  const matchRow = getMatchResult(String(task.match_result_id));
  if (!matchRow) throw new Error("Match result not found");
  const match = hydrateRankedCandidate(matchRow);
  const patch = safeJsonParse(resumePatchJson, {} as ResumePatch);
  const baseDocument = loadImportedDocument(baseSnapshot);
  updateJobStatusAndStage(String(task.job_id), "verifying", "verifying", { errorCode: null, errorMessage: null });
  rawDb.prepare("UPDATE tailor_tasks SET status = 'verifying', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
  const verifier = (await verifyTailoredPatchFromWorker(baseDocument, patch, jobProfile)) ?? verifyTailoredPatch(baseDocument, patch, jobProfile);
  return await finalizeTailorVerification({
    taskId,
    task,
    baseSnapshot,
    jobProfile,
    match,
    patch,
    verifier,
    pdfBaseUrl: typeof _payload?.pdfBaseUrl === "string" ? _payload.pdfBaseUrl : null,
  });
}

export function retryTailorVerifyTask(taskId: string, requestedBy?: string | null): Record<string, unknown> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (!String(task.resume_patch_json || "").trim()) throw new Error("Tailor task does not have a generated patch to verify");
  rawDb.prepare("UPDATE tailor_tasks SET status = 'submitted', updated_at = ? WHERE id = ?").run(nowIso(), taskId);
  if (String(task.verifier_provider || "local_ollama") === "chatgpt_webview") {
    rawDb.prepare("UPDATE tailor_tasks SET status = 'awaiting_verifier_claim', verifier_claimed_by = NULL, verifier_chat_url = NULL, updated_at = ? WHERE id = ?").run(nowIso(), taskId);
    updateJobStatusAndStage(String(task.job_id), "verifying", "queued_verify", { errorCode: null, errorMessage: null });
    const updatedTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!updatedTask) throw new Error("Tailor task not found after verifier retry");
    return updatedTask;
  }
  return enqueueTailorVerify(String(task.job_id), taskId, requestedBy ?? (task.requested_by as string | null | undefined) ?? null);
}

export function claimTailorTask(taskId: string, claimedBy?: string | null): Record<string, unknown> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (String(task.provider) !== "deepseek_webview") throw new Error("Only DeepSeek interactive tasks can be claimed from this lane");
  if (String(task.status) !== "awaiting_claim") throw new Error(`Tailor task is not claimable from status ${String(task.status)}`);
  const activeClaim = rawDb
    .prepare("SELECT id FROM tailor_tasks WHERE provider = ? AND status = 'claimed' AND id != ? ORDER BY created_at DESC LIMIT 1")
    .get(String(task.provider), taskId) as { id: string } | undefined;
  if (activeClaim) throw new Error(`Another ${String(task.provider)} task is already claimed`);
  rawDb.prepare("UPDATE tailor_tasks SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?").run(claimedBy ?? null, nowIso(), taskId);
  updateJobStatusAndStage(String(task.job_id), "tailoring", "generating", { errorCode: null, errorMessage: null });
  const updatedTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!updatedTask) throw new Error("Tailor task not found after claim");
  return updatedTask;
}

export function claimTailorVerifierTask(taskId: string, claimedBy?: string | null): Record<string, unknown> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (String(task.verifier_provider || "local_ollama") !== "chatgpt_webview") throw new Error("Only ChatGPT interactive verifier tasks can be claimed from this lane");
  if (String(task.status) !== "awaiting_verifier_claim") throw new Error(`Verifier task is not claimable from status ${String(task.status)}`);
  const activeClaim = rawDb
    .prepare("SELECT id FROM tailor_tasks WHERE verifier_provider = ? AND status = 'verifier_claimed' AND id != ? ORDER BY created_at DESC LIMIT 1")
    .get(String(task.verifier_provider || "local_ollama"), taskId) as { id: string } | undefined;
  if (activeClaim) throw new Error(`Another ${String(task.verifier_provider || "local_ollama")} verifier task is already claimed`);
  rawDb.prepare("UPDATE tailor_tasks SET status = 'verifier_claimed', verifier_claimed_by = ?, updated_at = ? WHERE id = ?").run(claimedBy ?? null, nowIso(), taskId);
  updateJobStatusAndStage(String(task.job_id), "verifying", "verifying", { errorCode: null, errorMessage: null });
  const updatedTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  if (!updatedTask) throw new Error("Tailor task not found after verifier claim");
  return updatedTask;
}

export async function submitDeepseekTailorTask(params: {
  taskId: string;
  gptChatUrl?: string | null;
  patch: ResumePatch;
}): Promise<Record<string, unknown>> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(params.taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (String(task.provider) !== "deepseek_webview") throw new Error("This task is not assigned to the DeepSeek interactive lane");
  if (String(task.status) !== "claimed") throw new Error(`DeepSeek task is not ready for submission from status ${String(task.status)}`);
  rawDb.prepare("UPDATE tailor_tasks SET status = 'submitted', gpt_chat_url = ?, resume_patch_json = ?, retries = retries + 1, updated_at = ? WHERE id = ?").run(
    params.gptChatUrl ?? null,
    JSON.stringify(params.patch),
    nowIso(),
    params.taskId
  );
  if (String(task.verifier_provider || "local_ollama") === "chatgpt_webview") {
    rawDb.prepare("UPDATE tailor_tasks SET status = 'awaiting_verifier_claim', verifier_claimed_by = NULL, verifier_chat_url = NULL, updated_at = ? WHERE id = ?").run(nowIso(), params.taskId);
    updateJobStatusAndStage(String(task.job_id), "verifying", "queued_verify", { errorCode: null, errorMessage: null });
  } else {
    enqueueTailorVerify(String(task.job_id), params.taskId, (task.requested_by as string | null | undefined) ?? null);
  }
  const updatedTask = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(params.taskId) as Record<string, unknown> | undefined;
  if (!updatedTask) throw new Error("Tailor task not found after DeepSeek submission");
  return updatedTask;
}

export async function submitChatGptVerifierTask(params: {
  taskId: string;
  gptChatUrl?: string | null;
  verifier: VerifierResult;
  pdfBaseUrl?: string | null;
}): Promise<Record<string, unknown>> {
  const task = rawDb.prepare("SELECT * FROM tailor_tasks WHERE id = ?").get(params.taskId) as Record<string, unknown> | undefined;
  if (!task) throw new Error("Tailor task not found");
  if (String(task.verifier_provider || "local_ollama") !== "chatgpt_webview") throw new Error("This task is not assigned to the ChatGPT verifier lane");
  if (String(task.status) !== "verifier_claimed") throw new Error(`ChatGPT verifier task is not ready for submission from status ${String(task.status)}`);
  const baseSnapshot = getSnapshot(String(task.base_snapshot_id));
  if (!baseSnapshot) throw new Error("Base snapshot not found");
  const resumePatchJson = String(task.resume_patch_json || "").trim();
  if (!resumePatchJson) throw new Error("Tailor task does not have a generated resume patch to verify");
  const job = await ensureJobExtracted(String(task.job_id));
  const jobProfile = safeJsonParse(String(job.job_profile_json || "{}"), {} as JobProfile);
  const matchRow = getMatchResult(String(task.match_result_id));
  if (!matchRow) throw new Error("Match result not found");
  const match = hydrateRankedCandidate(matchRow);
  const patch = safeJsonParse(resumePatchJson, {} as ResumePatch);
  rawDb.prepare("UPDATE tailor_tasks SET status = 'verifying', verifier_chat_url = ?, updated_at = ? WHERE id = ?").run(
    params.gptChatUrl ?? null,
    nowIso(),
    params.taskId
  );
  return await finalizeTailorVerification({
    taskId: params.taskId,
    task,
    baseSnapshot,
    jobProfile,
    match,
    patch,
    verifier: params.verifier,
    verifierChatUrl: params.gptChatUrl ?? null,
    pdfBaseUrl: params.pdfBaseUrl ?? null,
  });
}

export function getTailoredArtifacts(snapshotId: string): Array<Record<string, unknown>> {
  return rawDb.prepare("SELECT * FROM artifact_records WHERE owner_type = 'resume_snapshot' AND owner_id = ? ORDER BY created_at ASC").all(snapshotId) as Array<Record<string, unknown>>;
}

export function getArtifactRecord(artifactId: string): Record<string, unknown> | undefined {
  return rawDb.prepare("SELECT * FROM artifact_records WHERE id = ?").get(artifactId) as Record<string, unknown> | undefined;
}

export function readArtifactRecordContents(artifactId: string): { artifact: Record<string, unknown>; contents: Buffer } | undefined {
  const artifact = getArtifactRecord(artifactId);
  if (!artifact) return undefined;
  return {
    artifact,
    contents: readUnifiedArtifact(String(artifact.relative_path || "")),
  };
}
