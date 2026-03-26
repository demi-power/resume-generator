import React, { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, FileSpreadsheet, Link2, Loader2, RefreshCw, Sparkles, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "../lib/auth-context";
import { runProviderPrompt, type ProviderAutomationKind, type WebviewLike } from "../lib/provider-automation";

type ResumeSyncManifestFile = {
  relativePath: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
};

type ResumeSyncPrepareFile = ResumeSyncManifestFile & {
  compareStatus: "new" | "changed" | "unchanged" | "missing";
  uploadStatus: "pending" | "uploaded" | "skipped";
};

type ResumeSyncPrepareResponse = {
  syncRunId: string;
  status: string;
  counts: Record<string, number>;
  files: ResumeSyncPrepareFile[];
};

type ResumeSyncRunResponse = {
  id: string;
  status: string;
  summary_json?: string | null;
  files?: Array<Record<string, unknown>>;
};

type DesktopResumeSyncScan = {
  rootPath: string;
  files: ResumeSyncManifestFile[];
  errors?: string[];
};

type DesktopResumeFilePayload = {
  relativePath: string;
  html: string;
};

type MatchResultRow = {
  id: string;
  profile_name: string;
  variant_name: string;
  hybrid_score: number;
  similarity_score: number;
  rule_score: number;
  rerank_score: number;
  decision: string;
  reason: string;
  matched_requirements_json: string;
  missing_requirements_json: string;
};

type TailorTaskRow = {
  id: string;
  status: string;
  provider: string;
  verifier_provider?: string | null;
  job_id?: string | null;
  match_result_id?: string | null;
  claimed_by?: string | null;
  verifier_claimed_by?: string | null;
  gpt_chat_url?: string | null;
  verifier_chat_url?: string | null;
  tailored_snapshot_id?: string | null;
  verifier_result_id?: string | null;
  base_snapshot_id?: string | null;
  resume_patch_json?: string | null;
  retries?: number;
  max_retries?: number;
  updated_at?: string | null;
};

type TailorTaskDetailRow = TailorTaskRow & {
  verifierResult?: VerifierResultRow | null;
  artifacts?: ArtifactRow[];
};

type VerifierViolation = {
  type: string;
  message: string;
};

type VerifierResultRow = {
  id: string;
  pass: number;
  quality_score: number;
  violations_json: string;
  retry_instructions_json: string;
  human_review_reason?: string | null;
};

type ArtifactRow = {
  id: string;
  artifact_kind: string;
  relative_path: string;
  mime_type?: string | null;
};

type FetchAttemptRow = {
  id: string;
  method: string;
  result_code: string;
  status_code?: number | null;
  error_message?: string | null;
  excerpt?: string | null;
  created_at?: string;
};

type MatchRunRow = {
  id: string;
  status: string;
  summary_json?: string | null;
  created_at?: string;
};

type UnifiedTaskRow = {
  id: string;
  task_type: string;
  status: string;
  job_id?: string | null;
  tailor_task_id?: string | null;
  worker_id?: string | null;
  attempts?: number;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  result_json?: string | null;
  error_json?: string | null;
  payload_json?: string | null;
};

type LinkedApplicationRow = {
  id: string;
  date: string;
  company_name: string;
  title: string;
  job_url?: string | null;
  unified_job_id?: string | null;
  profile_id?: string | null;
  resume_file_name?: string;
  applied_manually?: number;
  created_at?: string;
};

type JobRecord = {
  id: string;
  batchId?: string | null;
  status: string;
  processing_stage?: string;
  canonical_url: string;
  raw_url?: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  work_model?: string | null;
  seniority?: string | null;
  description_text?: string | null;
  fetch_method?: string | null;
  job_profile_json?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  latestMatchRun?: MatchRunRow | null;
  fetchAttempts?: FetchAttemptRow[];
  latestTailorTask?: TailorTaskRow | null;
  latestVerifierResult?: VerifierResultRow | null;
  matchResults?: MatchResultRow[];
  unifiedTasks?: UnifiedTaskRow[];
  jobArtifacts?: ArtifactRow[];
  artifacts?: ArtifactRow[];
  linkedApplication?: LinkedApplicationRow | null;
};

type WorkerProviders = {
  extraction?: string;
  ranking?: string;
  generation?: string;
  verifier?: string;
  fallbacksEnabled?: boolean;
};

type WorkerOllamaStatus = {
  reachable?: boolean;
  baseUrl?: string;
  model?: string;
  extractModel?: string;
  generationModel?: string;
  verifierModel?: string;
  embedModel?: string;
  modelAvailable?: boolean;
  extractModelAvailable?: boolean;
  generationModelAvailable?: boolean;
  verifierModelAvailable?: boolean;
  embedModelAvailable?: boolean;
  error?: string | null;
};

type WorkerFastembedStatus = {
  available?: boolean;
  model?: string;
  enabledForRanking?: boolean;
};

type WorkerStatusSnapshot = {
  running?: boolean;
  workerId?: string;
  enabled?: boolean;
  processedCount?: number;
  idlePollCount?: number;
  lastPollAt?: string | null;
  lastProcessedAt?: string | null;
  lastTaskId?: string | null;
  lastResult?: Record<string, unknown>;
  lastError?: string | null;
  providers?: WorkerProviders;
  ollama?: WorkerOllamaStatus;
  fastembed?: WorkerFastembedStatus;
};

type WorkerStatusResponse = {
  configured: boolean;
  connected: boolean;
  worker: WorkerStatusSnapshot | null;
  error?: string | null;
};

type RequeueStage = "job_fetch" | "job_extract" | "job_rank" | "tailor_verify";

type PromptMode = "generation" | "verification";

type InteractiveProviderKind = ProviderAutomationKind;

type ResumePatchPayload = {
  summary: string;
  skillsOrder: string[];
  experienceEdits: Array<{ experienceId: string; originalText: string; tailoredText: string }>;
  removedItems: string[];
  coverageNotes: string[];
  providerMetadata: Record<string, unknown>;
};

type VerifierResultPayload = {
  pass: boolean;
  violations: Array<{ type: string; message: string }>;
  retryInstructions: string[];
  qualityScore: number;
  humanReviewReason: string | null;
  providerMetadata: Record<string, unknown>;
};

type InteractiveAutomationPhase = "idle" | "loading_session" | "running" | "parsing" | "submitting" | "failed";

type InteractiveAutomationState = {
  taskId: string | null;
  phase: InteractiveAutomationPhase;
  rawText: string;
  jsonText: string;
  error: string | null;
};

type ResumeSyncDesktopApi = {
  showResumeSyncFolderDialog?: () => Promise<string | null>;
  scanResumeSyncFolder?: (rootPath: string) => Promise<DesktopResumeSyncScan>;
  readResumeSyncFile?: (payload: { rootPath: string; relativePath: string }) => Promise<DesktopResumeFilePayload>;
  getDeepSeekCookies?: () => Promise<unknown[]>;
  setDeepSeekCookies?: (cookies: unknown[]) => Promise<unknown>;
  getChatGptCookies?: () => Promise<unknown[]>;
  setChatGptCookies?: (cookies: unknown[]) => Promise<unknown>;
};

function getResumeSyncDesktopApi(): ResumeSyncDesktopApi | null {
  const w = typeof window !== "undefined" ? (window as unknown as { electron?: unknown }) : undefined;
  const electron = w?.electron as ResumeSyncDesktopApi | undefined;
  if (!electron?.showResumeSyncFolderDialog || !electron.scanResumeSyncFolder || !electron.readResumeSyncFile) {
    return null;
  }
  return electron;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return "HTTP " + res.status;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error || text;
  } catch {
    return text;
  }
}

function mergeJobs(previous: JobRecord[], incoming: JobRecord[]): JobRecord[] {
  const byId = new Map<string, JobRecord>();
  for (const job of previous) byId.set(job.id, job);
  for (const job of incoming) {
    const existing = byId.get(job.id);
    byId.set(job.id, {
      ...existing,
      ...job,
      latestMatchRun: job.latestMatchRun ?? existing?.latestMatchRun,
      fetchAttempts: job.fetchAttempts ?? existing?.fetchAttempts,
      latestTailorTask: job.latestTailorTask ?? existing?.latestTailorTask,
      latestVerifierResult: job.latestVerifierResult ?? existing?.latestVerifierResult,
      matchResults: job.matchResults ?? existing?.matchResults,
      unifiedTasks: job.unifiedTasks ?? existing?.unifiedTasks,
      jobArtifacts: job.jobArtifacts ?? existing?.jobArtifacts,
      artifacts: job.artifacts ?? existing?.artifacts,
      linkedApplication: job.linkedApplication ?? existing?.linkedApplication,
    });
  }
  return Array.from(byId.values()).sort((a, b) => (a.id < b.id ? 1 : -1));
}

function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed) === false) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function getTaskOutcomeSummary(task: UnifiedTaskRow): string {
  if (task.status === "failed") {
    const error = parseJsonObject(task.error_json);
    const message = error?.message;
    return typeof message === "string" && message.trim() ? message.trim() : "Task failed";
  }
  const result = parseJsonObject(task.result_json);
  if (!result) return "Completed";
  const reason = result.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  const summary = result.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  const keys = Object.keys(result).filter((key) => key !== "job" && key !== "task");
  if (keys.length > 0) return "Result keys: " + keys.slice(0, 4).join(", ");
  return "Completed";
}

type ParsedJobProfile = {
  title?: string;
  company?: string;
  location?: string;
  workModel?: string;
  seniority?: string;
  primaryStack?: string[];
  secondaryStack?: string[];
  tools?: string[];
  keywords?: string[];
  domain?: string[];
  hardStops?: string[];
  summary?: string;
  confidence?: number;
};

function parseJobProfile(value: string | null | undefined): ParsedJobProfile | null {
  const parsed = parseJsonObject(value);
  return parsed ? (parsed as unknown as ParsedJobProfile) : null;
}

function renderJoinedList(value: string[] | undefined): string {
  return value && value.length > 0 ? value.join(", ") : "—";
}

function parseVerifierViolations(value: string | undefined): VerifierViolation[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        type: String(item.type || "format_violation"),
        message: String(item.message || ""),
      }))
      .filter((item) => item.message.trim().length > 0);
  } catch {
    return [];
  }
}

function summarizePatch(value: string | null | undefined): {
  summary: string;
  skillCount: number;
  experienceEditCount: number;
  removedCount: number;
  coverageNoteCount: number;
} | null {
  const parsed = parseJsonObject(value);
  if (!parsed) return null;
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const skillsOrder = Array.isArray(parsed.skillsOrder) ? parsed.skillsOrder : [];
  const experienceEdits = Array.isArray(parsed.experienceEdits) ? parsed.experienceEdits : [];
  const removedItems = Array.isArray(parsed.removedItems) ? parsed.removedItems : [];
  const coverageNotes = Array.isArray(parsed.coverageNotes) ? parsed.coverageNotes : [];
  return {
    summary,
    skillCount: skillsOrder.length,
    experienceEditCount: experienceEdits.length,
    removedCount: removedItems.length,
    coverageNoteCount: coverageNotes.length,
  };
}

function formatPercent(value: number): string {
  return Math.round(value * 100) + "%";
}

function formatBytes(value: number): string {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function artifactPreviewHref(artifact: ArtifactRow): string {
  return "/api/unified/artifacts/" + artifact.id;
}

function artifactDownloadHref(artifact: ArtifactRow): string {
  return "/api/unified/artifacts/" + artifact.id + "?download=1";
}

function artifactFileName(artifact: ArtifactRow): string {
  const parts = artifact.relative_path.split("/");
  return parts[parts.length - 1] || artifact.artifact_kind;
}

function artifactPreviewMode(artifact: ArtifactRow): "json" | "pdf" | "html" | "other" {
  const mimeType = String(artifact.mime_type || "").toLowerCase();
  const fileName = artifact.relative_path.toLowerCase();
  if (mimeType.includes("json") || fileName.endsWith(".json")) return "json";
  if (mimeType.includes("pdf") || fileName.endsWith(".pdf")) return "pdf";
  if (mimeType.includes("html") || fileName.endsWith(".html")) return "html";
  return "other";
}

function isVerifierBlocked(job: JobRecord): boolean {
  if (job.latestVerifierResult && Number(job.latestVerifierResult.pass) === 0) return true;
  if (job.latestTailorTask?.status === "manual_review_required") return true;
  return job.status === "manual_review_required";
}

function getPrimaryDecision(job: JobRecord): string {
  if (isVerifierBlocked(job)) return "blocked_by_verifier";
  if (job.matchResults && job.matchResults.length > 0) return job.matchResults[0].decision;
  if (job.latestTailorTask?.status) return job.latestTailorTask.status;
  return job.status;
}

function getVerifierViolationCount(job: JobRecord): number {
  if (!job.latestVerifierResult) return 0;
  return parseVerifierViolations(job.latestVerifierResult.violations_json).length;
}

function getVerifierSummary(job: JobRecord): string {
  if (job.latestVerifierResult?.human_review_reason) return job.latestVerifierResult.human_review_reason;
  const violations = job.latestVerifierResult ? parseVerifierViolations(job.latestVerifierResult.violations_json) : [];
  if (violations.length > 0) return violations[0].message;
  if (job.error_message) return job.error_message;
  return "";
}

function getBatchStageKey(job: JobRecord): string {
  const stage = String(job.processing_stage || "");
  if (stage === "queued_fetch") return "queued_fetch";
  if (job.status === "fetching" || stage === "fetching") return "fetching";
  if (stage === "queued_extract") return "queued_extract";
  if (job.status === "extracting" || stage === "extracting") return "extracting";
  if (stage === "queued_rank") return "queued_rank";
  if (job.status === "ranking" || stage === "ranking") return "ranking";
  if (stage === "ranked" && job.status === "ranked") return "ranked";
  if (stage === "queued_generate" || stage === "awaiting_claim") return "queued_generate";
  if (stage === "generating" || stage === "claimed") return "generating";
  if (stage === "queued_verify" || stage === "awaiting_verifier_claim") return "queued_verify";
  if (job.status === "verifying" || stage === "verifying" || stage === "verifier_claimed") return "verifying";
  if (job.status === "completed") return "completed";
  if (job.status === "failed") return "failed";
  if (job.status === "manual_review_required") return "manual_review_required";
  return stage || job.status || "queued";
}

function getLatestFetchAttempt(job: JobRecord): FetchAttemptRow | null {
  const attempts = job.fetchAttempts || [];
  return attempts.length > 0 ? attempts[attempts.length - 1] : null;
}

function getLatestMatchSummary(job: JobRecord): Record<string, unknown> | null {
  return parseJsonObject(job.latestMatchRun?.summary_json || null);
}

function hasExtractedJobProfile(job: JobRecord): boolean {
  return Boolean(parseJobProfile(job.job_profile_json));
}

function isFailedFetchJob(job: JobRecord): boolean {
  return job.status === "failed" && !job.description_text && !hasExtractedJobProfile(job);
}

function isFailedExtractJob(job: JobRecord): boolean {
  return (job.status === "failed" || job.status === "manual_review_required") && Boolean(job.description_text) && !hasExtractedJobProfile(job);
}

function isFailedRankJob(job: JobRecord): boolean {
  return job.status === "failed" && hasExtractedJobProfile(job) && (job.matchResults?.length || 0) === 0;
}

function isRetryableVerifyJob(job: JobRecord): boolean {
  return Boolean(job.latestTailorTask?.id) && (job.latestVerifierResult ? Number(job.latestVerifierResult.pass) === 0 : false);
}

function buildJobSearchText(job: JobRecord): string {
  const parts = [
    job.id,
    job.title || "",
    job.company || "",
    job.canonical_url || "",
    job.status || "",
    job.processing_stage || "",
    getPrimaryDecision(job),
    getVerifierSummary(job),
  ];
  if (job.matchResults) {
    for (const match of job.matchResults) {
      parts.push(match.profile_name, match.variant_name, match.reason);
      parts.push(...parseJsonArray(match.matched_requirements_json));
      parts.push(...parseJsonArray(match.missing_requirements_json));
    }
  }
  return parts.join(" ").toLowerCase();
}

function createVerifierExportRecord(job: JobRecord) {
  const verifyArtifact = (job.artifacts || []).find((artifact) => artifact.artifact_kind === "verify_json");
  const matchedRequirements = job.matchResults?.[0] ? parseJsonArray(job.matchResults[0].matched_requirements_json) : [];
  const missingRequirements = job.matchResults?.[0] ? parseJsonArray(job.matchResults[0].missing_requirements_json) : [];
  return {
    jobId: job.id,
    title: job.title || "",
    company: job.company || "",
    canonicalUrl: job.canonical_url,
    status: job.status,
    processingStage: job.processing_stage || "",
    decision: getPrimaryDecision(job),
    verifierPassed: job.latestVerifierResult ? Number(job.latestVerifierResult.pass) === 1 : false,
    verifierQualityScore: job.latestVerifierResult?.quality_score ?? null,
    verifierReason: job.latestVerifierResult?.human_review_reason || getVerifierSummary(job),
    verifierViolations: job.latestVerifierResult ? parseVerifierViolations(job.latestVerifierResult.violations_json) : [],
    retryInstructions: job.latestVerifierResult ? parseJsonArray(job.latestVerifierResult.retry_instructions_json) : [],
    matchedRequirements,
    missingRequirements,
    verifyArtifactPreviewUrl: verifyArtifact ? artifactPreviewHref(verifyArtifact) : null,
    verifyArtifactDownloadUrl: verifyArtifact ? artifactDownloadHref(verifyArtifact) : null,
    updatedAtHint: job.latestMatchRun?.created_at || null,
  };
}

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildBlockedVerifierCsv(jobs: JobRecord[]): string {
  const headers = [
    "job_id",
    "title",
    "company",
    "status",
    "processing_stage",
    "decision",
    "verifier_quality_score",
    "verifier_reason",
    "violation_count",
    "matched_requirements",
    "missing_requirements",
    "canonical_url",
    "verify_artifact_download_url",
  ];
  const rows = jobs.map((job) => {
    const record = createVerifierExportRecord(job);
    return [
      record.jobId,
      record.title,
      record.company,
      record.status,
      record.processingStage,
      record.decision,
      record.verifierQualityScore ?? "",
      record.verifierReason,
      record.verifierViolations.length,
      record.matchedRequirements.join(" | "),
      record.missingRequirements.join(" | "),
      record.canonicalUrl,
      record.verifyArtifactDownloadUrl || "",
    ].map(escapeCsvCell).join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

function createIdleAutomationState(): InteractiveAutomationState {
  return {
    taskId: null,
    phase: "idle",
    rawText: "",
    jsonText: "",
    error: null,
  };
}

const RESUME_PATCH_SCHEMA_EXAMPLE: ResumePatchPayload = {
  summary: "string",
  skillsOrder: ["string"],
  experienceEdits: [{ experienceId: "string", originalText: "string", tailoredText: "string" }],
  removedItems: ["string"],
  coverageNotes: ["string"],
  providerMetadata: { effective_provider: "deepseek_webview" },
};

const VERIFIER_RESULT_SCHEMA_EXAMPLE: VerifierResultPayload = {
  pass: true,
  violations: [{ type: "unsupported_claim", message: "string" }],
  retryInstructions: ["string"],
  qualityScore: 0.75,
  humanReviewReason: null,
  providerMetadata: { effective_provider: "chatgpt_webview" },
};

function buildJsonRepairPrompt(schemaExample: unknown): string {
  return [
    "Your previous reply was invalid because it was not a single JSON object matching the required schema.",
    "Reply again with JSON only.",
    "Do not include analysis, reasoning, markdown fences, headings, or commentary.",
    "The first character must be { and the last character must be }.",
    "Required schema:",
    JSON.stringify(schemaExample, null, 2),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isResumePatchPayload(value: unknown): value is ResumePatchPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.summary === "string" &&
    isStringArray(value.skillsOrder) &&
    Array.isArray(value.experienceEdits) &&
    value.experienceEdits.every((item) =>
      isRecord(item) &&
      typeof item.experienceId === "string" &&
      typeof item.originalText === "string" &&
      typeof item.tailoredText === "string"
    ) &&
    isStringArray(value.removedItems) &&
    isStringArray(value.coverageNotes) &&
    isRecord(value.providerMetadata)
  );
}

function isVerifierResultPayload(value: unknown): value is VerifierResultPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.pass === "boolean" &&
    Array.isArray(value.violations) &&
    value.violations.every((item) => isRecord(item) && typeof item.type === "string" && typeof item.message === "string") &&
    isStringArray(value.retryInstructions) &&
    typeof value.qualityScore === "number" &&
    (value.humanReviewReason === null || typeof value.humanReviewReason === "string") &&
    isRecord(value.providerMetadata)
  );
}

export function PipelinePage() {
  const { user } = useAuth();
  const desktopApi = getResumeSyncDesktopApi();

  const [folderPath, setFolderPath] = useState("");
  const [isFullSync, setIsFullSync] = useState(true);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const [latestPreparedSync, setLatestPreparedSync] = useState<ResumeSyncPrepareResponse | null>(null);
  const [latestCommittedSync, setLatestCommittedSync] = useState<ResumeSyncRunResponse | null>(null);
  const [lastScan, setLastScan] = useState<DesktopResumeSyncScan | null>(null);

  const [urlsText, setUrlsText] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [busyJobIds, setBusyJobIds] = useState<Record<string, string>>({});
  const [queueItems, setQueueItems] = useState<UnifiedTaskRow[]>([]);
  const [taskHistoryItems, setTaskHistoryItems] = useState<UnifiedTaskRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusResponse | null>(null);
  const [workerStatusLoading, setWorkerStatusLoading] = useState(false);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchJobs, setBatchJobs] = useState<JobRecord[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchHydrating, setBatchHydrating] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactRow | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reviewBulkBusy, setReviewBulkBusy] = useState<string | null>(null);
  const [jobSearch, setJobSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [deepSeekTasks, setDeepSeekTasks] = useState<TailorTaskRow[]>([]);
  const [chatGptVerifierTasks, setChatGptVerifierTasks] = useState<TailorTaskRow[]>([]);
  const [interactiveQueuesLoading, setInteractiveQueuesLoading] = useState(false);
  const [interactiveQueuesError, setInteractiveQueuesError] = useState<string | null>(null);
  const [deepSeekPrompt, setDeepSeekPrompt] = useState("");
  const [chatGptVerifierPrompt, setChatGptVerifierPrompt] = useState("");
  const [deepSeekPatchJson, setDeepSeekPatchJson] = useState("");
  const [chatGptVerifierJson, setChatGptVerifierJson] = useState("");
  const [interactiveActionBusy, setInteractiveActionBusy] = useState<string | null>(null);
  const [interactiveActionError, setInteractiveActionError] = useState<string | null>(null);
  const [deepSeekAutomation, setDeepSeekAutomation] = useState<InteractiveAutomationState>(() => createIdleAutomationState());
  const [chatGptAutomation, setChatGptAutomation] = useState<InteractiveAutomationState>(() => createIdleAutomationState());
  const [deepSeekPanelOpen, setDeepSeekPanelOpen] = useState(true);
  const [chatGptPanelOpen, setChatGptPanelOpen] = useState(true);
  const [deepSeekSrc, setDeepSeekSrc] = useState("about:blank");
  const [chatGptSrc, setChatGptSrc] = useState("about:blank");
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});
  const [tailorTaskDetails, setTailorTaskDetails] = useState<Record<string, TailorTaskDetailRow>>({});
  const [taskDetailLoading, setTaskDetailLoading] = useState<Record<string, boolean>>({});
  const [taskDetailErrors, setTaskDetailErrors] = useState<Record<string, string>>({});
  const deepSeekWebViewRef = useRef<HTMLElement | null>(null);
  const chatGptWebViewRef = useRef<HTMLElement | null>(null);
  const deepSeekLaneRef = useRef<HTMLDivElement | null>(null);
  const chatGptLaneRef = useRef<HTMLDivElement | null>(null);
  const deepSeekInvalidRetryCountRef = useRef(0);
  const claimedDeepSeekTaskRef = useRef<TailorTaskRow | null>(null);
  const claimedChatGptVerifierTaskRef = useRef<TailorTaskRow | null>(null);
  const deepSeekAutoStartedTaskIdRef = useRef<string | null>(null);
  const chatGptAutoStartedTaskIdRef = useRef<string | null>(null);

  const parsedUrlCount = useMemo(() => {
    return urlsText
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean).length;
  }, [urlsText]);

  const availableBatchIds = useMemo(() => {
    return Array.from(new Set([...jobs.map((job) => job.batchId || null), ...batchJobs.map((job) => job.batchId || null)].filter(Boolean) as string[])).sort().reverse();
  }, [jobs, batchJobs]);

  const activeBatchJobs = useMemo(() => {
    if (!activeBatchId) return batchJobs;
    return batchJobs.filter((job) => job.batchId === activeBatchId);
  }, [batchJobs, activeBatchId]);

  const reviewQueueJobs = useMemo(() => jobs.filter((job) => isVerifierBlocked(job)), [jobs]);

  const retryableReviewQueueJobs = useMemo(() => {
    return reviewQueueJobs.filter((job) => Boolean(job.matchResults?.[0]?.id));
  }, [reviewQueueJobs]);

  const filteredJobs = useMemo(() => {
    const normalizedSearch = jobSearch.trim().toLowerCase();
    return jobs.filter((job) => {
      if (activeBatchId && job.batchId !== activeBatchId) return false;
      if (reviewOnly && isVerifierBlocked(job) === false) return false;
      if (statusFilter !== "all" && job.status !== statusFilter) return false;
      if (decisionFilter !== "all" && getPrimaryDecision(job) !== decisionFilter) return false;
      if (normalizedSearch) {
        const haystack = buildJobSearchText(job);
        if (haystack.includes(normalizedSearch) === false) return false;
      }
      return true;
    });
  }, [jobs, activeBatchId, jobSearch, statusFilter, decisionFilter, reviewOnly]);

  const jobSummary = useMemo(() => {
    const scopedJobs = activeBatchId ? jobs.filter((job) => job.batchId === activeBatchId) : jobs;
    return {
      total: scopedJobs.length,
      blocked: scopedJobs.filter((job) => isVerifierBlocked(job)).length,
      retryableBlocked: scopedJobs.filter((job) => isVerifierBlocked(job) && Boolean(job.matchResults?.[0]?.id)).length,
      completed: scopedJobs.filter((job) => job.status === "completed").length,
      ranked: scopedJobs.filter((job) => (job.matchResults || []).length > 0).length,
      visible: filteredJobs.length,
    };
  }, [jobs, activeBatchId, filteredJobs]);

  const batchSummary = useMemo(() => {
    const counts: Record<string, number> = {
      queued_fetch: 0,
      fetching: 0,
      queued_extract: 0,
      extracting: 0,
      queued_rank: 0,
      ranking: 0,
      ranked: 0,
      queued_generate: 0,
      generating: 0,
      queued_verify: 0,
      verifying: 0,
      completed: 0,
      failed: 0,
      manual_review_required: 0,
    };
    for (const job of activeBatchJobs) {
      const key = getBatchStageKey(job);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [activeBatchJobs]);

  const batchRetryGroups = useMemo<Record<RequeueStage, JobRecord[]>>(() => ({
    job_fetch: activeBatchJobs.filter(isFailedFetchJob),
    job_extract: activeBatchJobs.filter(isFailedExtractJob),
    job_rank: activeBatchJobs.filter(isFailedRankJob),
    tailor_verify: activeBatchJobs.filter(isRetryableVerifyJob),
  }), [activeBatchJobs]);

  const claimedDeepSeekTask = useMemo(
    () => deepSeekTasks.find((task) => task.status === "claimed") ?? null,
    [deepSeekTasks]
  );
  const claimedChatGptVerifierTask = useMemo(
    () => chatGptVerifierTasks.find((task) => task.status === "verifier_claimed") ?? null,
    [chatGptVerifierTasks]
  );
  const knownJobsById = useMemo(() => {
    const map = new Map<string, JobRecord>();
    for (const job of batchJobs) map.set(job.id, job);
    for (const job of jobs) map.set(job.id, job);
    return map;
  }, [jobs, batchJobs]);

  const setJobBusy = (jobId: string, value: string | null) => {
    setBusyJobIds((previous) => {
      const next = { ...previous };
      if (value) next[jobId] = value;
      else delete next[jobId];
      return next;
    });
  };

  const refreshQueue = async () => {
    try {
      setQueueLoading(true);
      const [openRes, historyRes] = await Promise.all([
        fetch("/api/unified/tasks?status=queued&status=claimed&limit=20"),
        fetch("/api/unified/tasks?status=completed&status=failed&limit=30"),
      ]);
      if (!openRes.ok) throw new Error(await readError(openRes));
      if (!historyRes.ok) throw new Error(await readError(historyRes));
      const openPayload = (await openRes.json()) as { items: UnifiedTaskRow[] };
      const historyPayload = (await historyRes.json()) as { items: UnifiedTaskRow[] };
      setQueueItems(openPayload.items || []);
      setTaskHistoryItems(historyPayload.items || []);
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to load task queue");
    } finally {
      setQueueLoading(false);
    }
  };

  const refreshWorkerStatus = async () => {
    try {
      setWorkerStatusLoading(true);
      const res = await fetch("/api/unified/worker/status");
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as WorkerStatusResponse;
      setWorkerStatus(payload);
    } catch (error) {
      setWorkerStatus({
        configured: true,
        connected: false,
        worker: null,
        error: error instanceof Error ? error.message : "Failed to load worker status",
      });
    } finally {
      setWorkerStatusLoading(false);
    }
  };

  const refreshInteractiveQueues = async () => {
    try {
      setInteractiveQueuesLoading(true);
      setInteractiveQueuesError(null);
      const [deepSeekRes, chatGptRes] = await Promise.all([
        fetch("/api/tailor-tasks?provider=deepseek_webview&status=awaiting_claim&status=claimed&limit=25"),
        fetch("/api/tailor-tasks?verifierProvider=chatgpt_webview&status=awaiting_verifier_claim&status=verifier_claimed&limit=25"),
      ]);
      if (!deepSeekRes.ok) throw new Error(await readError(deepSeekRes));
      if (!chatGptRes.ok) throw new Error(await readError(chatGptRes));
      const deepSeekPayload = (await deepSeekRes.json()) as { items: TailorTaskRow[] };
      const chatGptPayload = (await chatGptRes.json()) as { items: TailorTaskRow[] };
      setDeepSeekTasks(deepSeekPayload.items || []);
      setChatGptVerifierTasks(chatGptPayload.items || []);
    } catch (error) {
      setInteractiveQueuesError(error instanceof Error ? error.message : "Failed to load interactive provider queues");
    } finally {
      setInteractiveQueuesLoading(false);
    }
  };

  const getInteractiveWebView = (kind: InteractiveProviderKind): WebviewLike | null => {
    const ref = kind === "deepseek" ? deepSeekWebViewRef.current : chatGptWebViewRef.current;
    return (ref as unknown as WebviewLike | null) ?? null;
  };

  const waitForInteractiveWebView = async (kind: InteractiveProviderKind): Promise<WebviewLike> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      const webview = getInteractiveWebView(kind);
      if (typeof webview?.executeJavaScript === "function") return webview;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for the ${kind} webview`);
  };

  const captureInteractiveChatUrl = async (kind: InteractiveProviderKind): Promise<string | null> => {
    const webview = getInteractiveWebView(kind);
    if (typeof webview?.executeJavaScript !== "function") return null;
    try {
      const href = await webview.executeJavaScript("location.href", true);
      return typeof href === "string" && /^https?:\/\//i.test(href.trim()) ? href.trim() : null;
    } catch {
      return null;
    }
  };

  const reloadInteractiveWebView = (kind: InteractiveProviderKind) => {
    const ref = kind === "deepseek" ? deepSeekWebViewRef.current : chatGptWebViewRef.current;
    const webview = ref as unknown as { reload?: () => void } | null;
    if (typeof webview?.reload === "function") {
      webview.reload();
    }
  };

  const applyInteractiveProviderSession = async (kind: InteractiveProviderKind) => {
    const setter = kind === "deepseek" ? desktopApi?.setDeepSeekCookies : desktopApi?.setChatGptCookies;
    const path = kind === "deepseek" ? "/api/deepseek-cookies" : "/api/chatgpt-cookies";
    const src = kind === "deepseek" ? "https://chat.deepseek.com/" : "https://chatgpt.com/";
    if (!setter) {
      if (kind === "deepseek") setDeepSeekSrc(src);
      else setChatGptSrc(src);
      return;
    }
    const res = await fetch(path);
    if (!res.ok) throw new Error(await readError(res));
    const payload = (await res.json()) as { cookies?: unknown[] };
    const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
    if (cookies.length > 0) {
      await setter(cookies);
    }
    if (kind === "deepseek") setDeepSeekSrc(src);
    else setChatGptSrc(src);
    if (cookies.length > 0) {
      setTimeout(() => reloadInteractiveWebView(kind), 50);
    }
  };

  const loadInteractiveProviderSession = async (kind: InteractiveProviderKind, options?: { suppressGlobalError?: boolean }) => {
    try {
      if (!options?.suppressGlobalError) setInteractiveActionError(null);
      await applyInteractiveProviderSession(kind);
    } catch (error) {
      if (options?.suppressGlobalError) throw error;
      setInteractiveActionError(error instanceof Error ? error.message : "Failed to load provider session");
    }
  };

  const focusInteractiveLane = (kind: InteractiveProviderKind) => {
    const src = kind === "deepseek" ? "https://chat.deepseek.com/" : "https://chatgpt.com/";
    if (kind === "deepseek") {
      setDeepSeekPanelOpen(true);
      setDeepSeekSrc((current) => (current === "about:blank" ? src : current));
      deepSeekLaneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setChatGptPanelOpen(true);
    setChatGptSrc((current) => (current === "about:blank" ? src : current));
    chatGptLaneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const saveInteractiveProviderSession = async (kind: InteractiveProviderKind) => {
    try {
      setInteractiveActionError(null);
      const getter = kind === "deepseek" ? desktopApi?.getDeepSeekCookies : desktopApi?.getChatGptCookies;
      if (!getter) throw new Error("Desktop session access is only available in the Electron app.");
      const path = kind === "deepseek" ? "/api/deepseek-cookies" : "/api/chatgpt-cookies";
      const cookies = await getter();
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies }),
      });
      if (!res.ok) throw new Error(await readError(res));
    } catch (error) {
      setInteractiveActionError(error instanceof Error ? error.message : "Failed to save provider session");
    }
  };

  const loadTailorPrompt = async (taskId: string, mode: PromptMode) => {
    const res = await fetch(`/api/tailor-tasks/${taskId}/prompt?mode=${mode}`);
    if (!res.ok) throw new Error(await readError(res));
    const payload = (await res.json()) as { prompt?: string };
    return payload.prompt || "";
  };

  const claimDeepSeekTask = async (taskId: string) => {
    try {
      setInteractiveActionBusy(`claim:${taskId}`);
      setInteractiveActionError(null);
      const res = await fetch(`/api/tailor-tasks/${taskId}/claim-deepseek`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const task = (await res.json()) as TailorTaskRow;
      setDeepSeekPrompt(await loadTailorPrompt(taskId, "generation"));
      setDeepSeekPatchJson("");
      setDeepSeekAutomation(createIdleAutomationState());
      deepSeekAutoStartedTaskIdRef.current = null;
      focusInteractiveLane("deepseek");
      void loadInteractiveProviderSession("deepseek");
      await refreshInteractiveQueues();
      if (task.job_id) await refreshJob(task.job_id);
    } catch (error) {
      setInteractiveActionError(error instanceof Error ? error.message : "Failed to claim DeepSeek task");
    } finally {
      setInteractiveActionBusy(null);
    }
  };

  const claimChatGptVerifierTask = async (taskId: string) => {
    try {
      setInteractiveActionBusy(`claim-verifier:${taskId}`);
      setInteractiveActionError(null);
      const res = await fetch(`/api/tailor-tasks/${taskId}/claim-chatgpt-verifier`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const task = (await res.json()) as TailorTaskRow;
      setChatGptVerifierPrompt(await loadTailorPrompt(taskId, "verification"));
      setChatGptVerifierJson("");
      setChatGptAutomation(createIdleAutomationState());
      chatGptAutoStartedTaskIdRef.current = null;
      focusInteractiveLane("chatgpt");
      void loadInteractiveProviderSession("chatgpt");
      await refreshInteractiveQueues();
      if (task.job_id) await refreshJob(task.job_id);
    } catch (error) {
      setInteractiveActionError(error instanceof Error ? error.message : "Failed to claim ChatGPT verifier task");
    } finally {
      setInteractiveActionBusy(null);
    }
  };

  const submitDeepSeekPatch = async (taskId: string, patchOverride?: ResumePatchPayload) => {
    try {
      setInteractiveActionBusy(`submit:${taskId}`);
      setInteractiveActionError(null);
      const patch = patchOverride ?? (JSON.parse(deepSeekPatchJson) as ResumePatchPayload);
      const gptChatUrl = await captureInteractiveChatUrl("deepseek");
      const res = await fetch(`/api/tailor-tasks/${taskId}/submit-deepseek-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gptChatUrl, patch }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const task = (await res.json()) as TailorTaskRow;
      setDeepSeekPatchJson("");
      setDeepSeekPrompt("");
      setDeepSeekAutomation(createIdleAutomationState());
      await refreshInteractiveQueues();
      if (task.job_id) await refreshJob(task.job_id);
      if (task.status === "awaiting_verifier_claim" && !claimedChatGptVerifierTaskRef.current) {
        void claimChatGptVerifierTask(task.id);
      }
      return task;
    } catch (error) {
      setInteractiveActionError(error instanceof Error ? error.message : "Failed to submit DeepSeek patch");
      return null;
    } finally {
      setInteractiveActionBusy(null);
    }
  };

  const submitChatGptVerifier = async (taskId: string, verifierOverride?: VerifierResultPayload) => {
    try {
      setInteractiveActionBusy(`submit-verifier:${taskId}`);
      setInteractiveActionError(null);
      const verifier = verifierOverride ?? (JSON.parse(chatGptVerifierJson) as VerifierResultPayload);
      const gptChatUrl = await captureInteractiveChatUrl("chatgpt");
      const res = await fetch(`/api/tailor-tasks/${taskId}/submit-chatgpt-verifier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gptChatUrl, verifier }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const task = (await res.json()) as TailorTaskRow;
      setChatGptVerifierJson("");
      setChatGptVerifierPrompt("");
      setChatGptAutomation(createIdleAutomationState());
      await refreshInteractiveQueues();
      if (task.job_id) await refreshJob(task.job_id);
      if (task.status === "awaiting_claim" && !claimedDeepSeekTaskRef.current) {
        void claimDeepSeekTask(task.id);
      }
      return task;
    } catch (error) {
      setInteractiveActionError(error instanceof Error ? error.message : "Failed to submit ChatGPT verifier result");
      return null;
    } finally {
      setInteractiveActionBusy(null);
    }
  };

  async function repairProviderJson<T>(
    kind: InteractiveProviderKind,
    schemaExample: unknown,
    isValid: (value: unknown) => value is T,
    currentResult: { rawText: string; jsonText: string | null; parsedJson: T | null; chatUrl: string | null }
  ) {
    let result = currentResult;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isValid(result.parsedJson)) return result;
      result = await runProviderPrompt<T>({
        kind,
        webview: await waitForInteractiveWebView(kind),
        prompt: buildJsonRepairPrompt(schemaExample),
        startFreshChat: false,
      });
    }
    return result;
  }

  const runDeepSeekAutomation = async (taskId: string, promptText: string) => {
    try {
      setDeepSeekAutomation({
        taskId,
        phase: "loading_session",
        rawText: "",
        jsonText: "",
        error: null,
      });
      focusInteractiveLane("deepseek");
      await waitForInteractiveWebView("deepseek");
      await loadInteractiveProviderSession("deepseek", { suppressGlobalError: true });
      await new Promise((resolve) => setTimeout(resolve, 750));
      setDeepSeekAutomation({
        taskId,
        phase: "running",
        rawText: "",
        jsonText: "",
        error: null,
      });
      let result = await runProviderPrompt<ResumePatchPayload>({
        kind: "deepseek",
        webview: await waitForInteractiveWebView("deepseek"),
        prompt: promptText,
        startFreshChat: true,
      });
      setDeepSeekAutomation({
        taskId,
        phase: "parsing",
        rawText: result.rawText,
        jsonText: result.jsonText || "",
        error: null,
      });
      if (result.jsonText) setDeepSeekPatchJson(result.jsonText);
      if (!isResumePatchPayload(result.parsedJson)) {
        result = await repairProviderJson<ResumePatchPayload>(
          "deepseek",
          RESUME_PATCH_SCHEMA_EXAMPLE,
          isResumePatchPayload,
          result
        );
        setDeepSeekAutomation({
          taskId,
          phase: "parsing",
          rawText: result.rawText,
          jsonText: result.jsonText || "",
          error: null,
        });
        if (result.jsonText) setDeepSeekPatchJson(result.jsonText);
      }
      if (!isResumePatchPayload(result.parsedJson)) {
        throw new Error("DeepSeek did not return a valid ResumePatch JSON payload after the JSON-only retry");
      }
      setDeepSeekAutomation({
        taskId,
        phase: "submitting",
        rawText: result.rawText,
        jsonText: result.jsonText || "",
        error: null,
      });
      const submitted = await submitDeepSeekPatch(taskId, result.parsedJson);
      if (!submitted) {
        throw new Error("DeepSeek automation could not submit the generated patch");
      }
    } catch (error) {
      setDeepSeekAutomation((previous) => ({
        taskId,
        phase: "failed",
        rawText: previous.taskId === taskId ? previous.rawText : "",
        jsonText: previous.taskId === taskId ? previous.jsonText : "",
        error: error instanceof Error ? error.message : "DeepSeek automation failed",
      }));
    }
  };

  const runChatGptAutomation = async (taskId: string, promptText: string) => {
    try {
      setChatGptAutomation({
        taskId,
        phase: "loading_session",
        rawText: "",
        jsonText: "",
        error: null,
      });
      focusInteractiveLane("chatgpt");
      await waitForInteractiveWebView("chatgpt");
      await loadInteractiveProviderSession("chatgpt", { suppressGlobalError: true });
      await new Promise((resolve) => setTimeout(resolve, 750));
      setChatGptAutomation({
        taskId,
        phase: "running",
        rawText: "",
        jsonText: "",
        error: null,
      });
      let result = await runProviderPrompt<VerifierResultPayload>({
        kind: "chatgpt",
        webview: await waitForInteractiveWebView("chatgpt"),
        prompt: promptText,
        startFreshChat: true,
      });
      setChatGptAutomation({
        taskId,
        phase: "parsing",
        rawText: result.rawText,
        jsonText: result.jsonText || "",
        error: null,
      });
      if (result.jsonText) setChatGptVerifierJson(result.jsonText);
      if (!isVerifierResultPayload(result.parsedJson)) {
        result = await repairProviderJson<VerifierResultPayload>(
          "chatgpt",
          VERIFIER_RESULT_SCHEMA_EXAMPLE,
          isVerifierResultPayload,
          result
        );
        setChatGptAutomation({
          taskId,
          phase: "parsing",
          rawText: result.rawText,
          jsonText: result.jsonText || "",
          error: null,
        });
        if (result.jsonText) setChatGptVerifierJson(result.jsonText);
      }
      if (!isVerifierResultPayload(result.parsedJson)) {
        throw new Error("ChatGPT did not return a valid VerifierResult JSON payload after the JSON-only retry");
      }
      setChatGptAutomation({
        taskId,
        phase: "submitting",
        rawText: result.rawText,
        jsonText: result.jsonText || "",
        error: null,
      });
      const submitted = await submitChatGptVerifier(taskId, result.parsedJson);
      if (!submitted) {
        throw new Error("ChatGPT automation could not submit the verifier result");
      }
    } catch (error) {
      setChatGptAutomation((previous) => ({
        taskId,
        phase: "failed",
        rawText: previous.taskId === taskId ? previous.rawText : "",
        jsonText: previous.taskId === taskId ? previous.jsonText : "",
        error: error instanceof Error ? error.message : "ChatGPT automation failed",
      }));
    }
  };

  const refreshBatchJobs = async (selectedBatchId: string | null = activeBatchId) => {
    if (!selectedBatchId) {
      setBatchJobs([]);
      setBatchError(null);
      return;
    }
    try {
      setBatchLoading(true);
      setBatchError(null);
      const res = await fetch("/api/jobs?batchId=" + encodeURIComponent(selectedBatchId) + "&limit=500");
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { items: JobRecord[] };
      const items = payload.items || [];
      setBatchJobs(items);
      setJobs((previous) => mergeJobs(previous, items));
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : "Failed to load batch jobs");
    } finally {
      setBatchLoading(false);
    }
  };

  const hydrateBatchDetails = async (selectedBatchId: string | null = activeBatchId) => {
    if (!selectedBatchId) return;
    const targets = batchJobs.filter((job) => job.batchId === selectedBatchId);
    if (targets.length === 0) return;
    try {
      setBatchHydrating(true);
      setBatchError(null);
      for (const job of targets) {
        await refreshJob(job.id);
      }
      await refreshBatchJobs(selectedBatchId);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : "Failed to hydrate batch job details");
    } finally {
      setBatchHydrating(false);
    }
  };

  const loadArtifactsForSnapshot = async (snapshotId: string): Promise<ArtifactRow[]> => {
    const res = await fetch("/api/tailored/" + snapshotId + "/artifacts");
    if (!res.ok) throw new Error(await readError(res));
    const payload = (await res.json()) as { items: ArtifactRow[] };
    return payload.items || [];
  };

  const closeArtifactPreview = () => {
    setPreviewArtifact(null);
    setPreviewText("");
    setPreviewError(null);
    setPreviewLoading(false);
  };

  const refreshBlockedJobs = async () => {
    const targets = [...reviewQueueJobs];
    if (targets.length === 0) return;
    try {
      setReviewBulkBusy("Refreshing blocked jobs…");
      for (const job of targets) {
        await refreshJob(job.id);
      }
    } finally {
      setReviewBulkBusy(null);
    }
  };

  const retryBlockedJobs = async () => {
    const targets = [...retryableReviewQueueJobs];
    if (targets.length === 0) return;
    try {
      setReviewBulkBusy("Queueing blocked tailoring retries…");
      for (const job of targets) {
        const topMatch = job.matchResults?.[0];
        if (!topMatch) continue;
        await tailorJob(job.id, topMatch.id);
      }
    } finally {
      setReviewBulkBusy(null);
    }
  };

  const exportBlockedVerifierReportsJson = () => {
    if (reviewQueueJobs.length === 0) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      count: reviewQueueJobs.length,
      items: reviewQueueJobs.map(createVerifierExportRecord),
    };
    downloadTextFile("blocked-verifier-reports.json", JSON.stringify(payload, null, 2), "application/json");
  };

  const exportBlockedVerifierReportsCsv = () => {
    if (reviewQueueJobs.length === 0) return;
    downloadTextFile("blocked-verifier-reports.csv", buildBlockedVerifierCsv(reviewQueueJobs), "text/csv;charset=utf-8");
  };

  const clearJobFilters = () => {
    setJobSearch("");
    setStatusFilter("all");
    setDecisionFilter("all");
    setReviewOnly(false);
  };

  const focusReviewJob = (job: JobRecord) => {
    setJobSearch((job.title || job.company || job.id || "").trim());
    setStatusFilter("all");
    setDecisionFilter("blocked_by_verifier");
    setReviewOnly(true);
  };

  const openArtifactPreview = async (artifact: ArtifactRow) => {
    setPreviewArtifact(artifact);
    setPreviewText("");
    setPreviewError(null);
    const mode = artifactPreviewMode(artifact);
    if (mode !== "json") {
      setPreviewLoading(false);
      return;
    }
    try {
      setPreviewLoading(true);
      const res = await fetch(artifactPreviewHref(artifact));
      if (!res.ok) throw new Error(await readError(res));
      setPreviewText(await res.text());
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Failed to load artifact preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  const refreshJob = async (jobId: string) => {
    try {
      setJobBusy(jobId, "Refreshing…");
      const res = await fetch("/api/jobs/" + jobId + "/status");
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as JobRecord & {
        latestTailorTask?: TailorTaskRow | null;
        latestVerifierResult?: VerifierResultRow | null;
        matchResults?: MatchResultRow[];
      };
      let artifacts: ArtifactRow[] | undefined;
      if (payload.latestTailorTask?.tailored_snapshot_id) {
        artifacts = await loadArtifactsForSnapshot(payload.latestTailorTask.tailored_snapshot_id);
      }
      const nextJob = { ...payload, artifacts };
      setJobs((previous) => mergeJobs(previous, [nextJob]));
      setBatchJobs((previous) => mergeJobs(previous, [nextJob]));
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to refresh job");
    } finally {
      setJobBusy(jobId, null);
    }
  };

  const loadTaskContext = async (task: UnifiedTaskRow) => {
    try {
      setTaskDetailLoading((previous) => ({ ...previous, [task.id]: true }));
      setTaskDetailErrors((previous) => {
        const next = { ...previous };
        delete next[task.id];
        return next;
      });

      if (task.job_id) {
        const res = await fetch("/api/jobs/" + task.job_id + "/status");
        if (!res.ok) throw new Error(await readError(res));
        const payload = (await res.json()) as JobRecord;
        let artifacts: ArtifactRow[] | undefined;
        if (payload.latestTailorTask?.tailored_snapshot_id) {
          artifacts = await loadArtifactsForSnapshot(payload.latestTailorTask.tailored_snapshot_id);
        }
        const nextJob = { ...payload, artifacts };
        setJobs((previous) => mergeJobs(previous, [nextJob]));
        setBatchJobs((previous) => mergeJobs(previous, [nextJob]));
      }

      if (task.tailor_task_id) {
        const res = await fetch("/api/tailor-tasks/" + task.tailor_task_id);
        if (!res.ok) throw new Error(await readError(res));
        const payload = (await res.json()) as TailorTaskDetailRow;
        setTailorTaskDetails((previous) => ({ ...previous, [task.tailor_task_id as string]: payload }));
      }
    } catch (error) {
      setTaskDetailErrors((previous) => ({
        ...previous,
        [task.id]: error instanceof Error ? error.message : "Failed to load task details",
      }));
    } finally {
      setTaskDetailLoading((previous) => ({ ...previous, [task.id]: false }));
    }
  };

  const toggleTaskDetails = async (task: UnifiedTaskRow) => {
    const nextOpen = !expandedTaskIds[task.id];
    setExpandedTaskIds((previous) => ({ ...previous, [task.id]: nextOpen }));
    if (nextOpen) {
      await loadTaskContext(task);
    }
  };

  const requeueJobStage = async (jobId: string, stage: RequeueStage) => {
    const labels: Record<RequeueStage, string> = {
      job_fetch: "Queueing fetch retry…",
      job_extract: "Queueing extract retry…",
      job_rank: "Queueing rank retry…",
      tailor_verify: "Queueing verify retry…",
    };
    try {
      setJobBusy(jobId, labels[stage]);
      const res = await fetch("/api/jobs/" + jobId + "/requeue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { job?: JobRecord };
      const nextJob = payload.job;
      if (nextJob) {
        setJobs((previous) => mergeJobs(previous, [nextJob]));
        setBatchJobs((previous) => mergeJobs(previous, [nextJob]));
      }
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to requeue job stage");
    } finally {
      setJobBusy(jobId, null);
    }
  };

  const retryBatchStage = async (stage: RequeueStage) => {
    const targets = batchRetryGroups[stage];
    if (!targets || targets.length === 0) return;
    const labels: Record<RequeueStage, string> = {
      job_fetch: "Retrying failed fetch tasks…",
      job_extract: "Retrying failed extract tasks…",
      job_rank: "Retrying failed rank tasks…",
      tailor_verify: "Retrying failed verify tasks…",
    };
    try {
      setReviewBulkBusy(labels[stage]);
      for (const job of targets) {
        await requeueJobStage(job.id, stage);
      }
      await refreshBatchJobs(activeBatchId);
    } finally {
      setReviewBulkBusy(null);
    }
  };

  const processNextQueueTask = async (): Promise<boolean> => {
    try {
      setQueueLoading(true);
      const res = await fetch("/api/unified/tasks/process-next", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { processed: boolean; item?: UnifiedTaskRow | null };
      if (!payload.processed || !payload.item) {
        await refreshQueue();
        await refreshWorkerStatus();
        return false;
      }
      await refreshQueue();
      await refreshWorkerStatus();
      if (payload.item.job_id) {
        await refreshJob(payload.item.job_id);
      }
      return true;
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to process next task");
      return false;
    } finally {
      setQueueLoading(false);
    }
  };

  const drainQueue = async () => {
    for (let count = 0; count < 25; count += 1) {
      const processed = await processNextQueueTask();
      if (!processed) break;
    }
  };

  useEffect(() => {
    void refreshQueue();
    void refreshWorkerStatus();
    void refreshInteractiveQueues();
  }, []);

  useEffect(() => {
    if (activeBatchId) {
      void refreshBatchJobs(activeBatchId);
    }
  }, [activeBatchId]);

  useEffect(() => {
    claimedDeepSeekTaskRef.current = claimedDeepSeekTask;
  }, [claimedDeepSeekTask]);

  useEffect(() => {
    claimedChatGptVerifierTaskRef.current = claimedChatGptVerifierTask;
  }, [claimedChatGptVerifierTask]);

  useEffect(() => {
    if (deepSeekPanelOpen) {
      void loadInteractiveProviderSession("deepseek");
    }
  }, [deepSeekPanelOpen]);

  useEffect(() => {
    if (chatGptPanelOpen) {
      void loadInteractiveProviderSession("chatgpt");
    }
  }, [chatGptPanelOpen]);

  useEffect(() => {
    const element = deepSeekWebViewRef.current;
    if (!element || !deepSeekPanelOpen || !desktopApi?.setDeepSeekCookies) return;
    const webview = element as unknown as {
      addEventListener?: (name: string, listener: () => void) => void;
      removeEventListener?: (name: string, listener: () => void) => void;
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
      reload?: () => void;
      setZoomFactor?: (factor: number) => void;
    };
    const onLoad = () => {
      if (typeof webview.setZoomFactor === "function") {
        webview.setZoomFactor(0.6);
      }
      if (typeof webview.executeJavaScript !== "function") return;
      webview.executeJavaScript(
        `(function(){
          var body = document.body;
          if (!body) return false;
          var text = (body.innerText || '').toLowerCase();
          return text.indexOf('log in') !== -1 || text.indexOf('login') !== -1 || !!document.querySelector('form[action*="login"], [data-testid*="login"], a[href*="login"]');
        })();`,
        true
      ).then((loginRequired) => {
        if (loginRequired !== true) return;
        if (deepSeekInvalidRetryCountRef.current >= 2) return;
        deepSeekInvalidRetryCountRef.current += 1;
        (async () => {
          try {
            await applyInteractiveProviderSession("deepseek");
            if (typeof webview.reload === "function") webview.reload();
          } catch {
            // keep the existing lane state; automation will surface the failure
          }
        })();
      }).catch(() => {});
    };
    webview.addEventListener?.("did-finish-load", onLoad);
    return () => {
      webview.removeEventListener?.("did-finish-load", onLoad);
    };
  }, [deepSeekPanelOpen, desktopApi?.setDeepSeekCookies]);

  useEffect(() => {
    if (claimedDeepSeekTask && !deepSeekPrompt) {
      void loadTailorPrompt(claimedDeepSeekTask.id, "generation").then(setDeepSeekPrompt).catch(() => {});
    }
    if (!claimedDeepSeekTask && deepSeekPrompt) {
      setDeepSeekPrompt("");
    }
  }, [claimedDeepSeekTask?.id, deepSeekPrompt]);

  useEffect(() => {
    if (claimedChatGptVerifierTask && !chatGptVerifierPrompt) {
      void loadTailorPrompt(claimedChatGptVerifierTask.id, "verification").then(setChatGptVerifierPrompt).catch(() => {});
    }
    if (!claimedChatGptVerifierTask && chatGptVerifierPrompt) {
      setChatGptVerifierPrompt("");
    }
  }, [claimedChatGptVerifierTask?.id, chatGptVerifierPrompt]);

  useEffect(() => {
    if (!claimedDeepSeekTask) {
      deepSeekAutoStartedTaskIdRef.current = null;
      if (deepSeekAutomation.taskId) setDeepSeekAutomation(createIdleAutomationState());
      return;
    }
    if (!deepSeekPrompt.trim()) return;
    if (deepSeekAutomation.phase !== "idle") return;
    if (deepSeekAutoStartedTaskIdRef.current === claimedDeepSeekTask.id) return;
    deepSeekAutoStartedTaskIdRef.current = claimedDeepSeekTask.id;
    void runDeepSeekAutomation(claimedDeepSeekTask.id, deepSeekPrompt);
  }, [claimedDeepSeekTask?.id, deepSeekPrompt, deepSeekAutomation.phase]);

  useEffect(() => {
    if (!claimedChatGptVerifierTask) {
      chatGptAutoStartedTaskIdRef.current = null;
      if (chatGptAutomation.taskId) setChatGptAutomation(createIdleAutomationState());
      return;
    }
    if (!chatGptVerifierPrompt.trim()) return;
    if (chatGptAutomation.phase !== "idle") return;
    if (chatGptAutoStartedTaskIdRef.current === claimedChatGptVerifierTask.id) return;
    chatGptAutoStartedTaskIdRef.current = claimedChatGptVerifierTask.id;
    void runChatGptAutomation(claimedChatGptVerifierTask.id, chatGptVerifierPrompt);
  }, [claimedChatGptVerifierTask?.id, chatGptVerifierPrompt, chatGptAutomation.phase]);

  if (user?.role !== "admin") {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">You don’t have access to this page.</p>
      </div>
    );
  }

  const chooseFolder = async () => {
    if (!desktopApi?.showResumeSyncFolderDialog) {
      setSyncError("Desktop folder access is only available in the Electron app.");
      return;
    }
    setSyncError(null);
    const selected = await desktopApi.showResumeSyncFolderDialog();
    if (selected) setFolderPath(selected);
  };

  const runResumeSync = async () => {
    if (!desktopApi?.scanResumeSyncFolder || !desktopApi.readResumeSyncFile) {
      setSyncError("Desktop folder scanning is only available in the Electron app.");
      return;
    }
    if (!folderPath.trim()) {
      setSyncError("Choose a resume folder first.");
      return;
    }

    try {
      setSyncLoading(true);
      setSyncError(null);
      setSyncProgress("Scanning folder…");
      const scan = await desktopApi.scanResumeSyncFolder(folderPath.trim());
      setLastScan(scan);

      setSyncProgress("Preparing sync for " + scan.files.length + " HTML files…");
      const prepareRes = await fetch("/api/resume-sync/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: scan.rootPath, isFullSync, files: scan.files }),
      });
      if (!prepareRes.ok) throw new Error(await readError(prepareRes));
      const prepared = (await prepareRes.json()) as ResumeSyncPrepareResponse;
      setLatestPreparedSync(prepared);

      const uploadTargets = prepared.files.filter((file) => file.compareStatus === "new" || file.compareStatus === "changed");
      for (let index = 0; index < uploadTargets.length; index += 1) {
        const file = uploadTargets[index];
        setSyncProgress("Uploading " + (index + 1) + "/" + uploadTargets.length + ": " + file.relativePath);
        const payload = await desktopApi.readResumeSyncFile({ rootPath: scan.rootPath, relativePath: file.relativePath });
        const uploadRes = await fetch("/api/resume-sync/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ syncRunId: prepared.syncRunId, relativePath: file.relativePath, html: payload.html }),
        });
        if (!uploadRes.ok) throw new Error(await readError(uploadRes));
      }

      setSyncProgress("Committing sync…");
      const commitRes = await fetch("/api/resume-sync/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncRunId: prepared.syncRunId }),
      });
      if (!commitRes.ok) throw new Error(await readError(commitRes));
      const committed = (await commitRes.json()) as ResumeSyncRunResponse;
      setLatestCommittedSync(committed);
      setSyncProgress(null);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Resume sync failed");
      setSyncProgress(null);
    } finally {
      setSyncLoading(false);
    }
  };

  const submitUrls = async () => {
    const urls = Array.from(new Set(urlsText.split(/\s+/).map((value) => value.trim()).filter(Boolean)));
    if (urls.length === 0) {
      setIntakeError("Paste at least one job URL.");
      return;
    }

    try {
      setIntakeLoading(true);
      setIntakeError(null);
      const batchId = crypto.randomUUID();
      const res = await fetch("/api/jobs/intake/urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, batchId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { items: JobRecord[] };
      setActiveBatchId(batchId);
      setJobs((previous) => mergeJobs(previous, payload.items || []));
      await refreshBatchJobs(batchId);
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Job intake failed");
    } finally {
      setIntakeLoading(false);
    }
  };

  const submitCsv = async () => {
    if (!csvText.trim()) {
      setIntakeError("Choose or paste a CSV file first.");
      return;
    }
    try {
      setIntakeLoading(true);
      setIntakeError(null);
      const batchId = crypto.randomUUID();
      const res = await fetch("/api/jobs/intake/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText, batchId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { items: JobRecord[] };
      setActiveBatchId(batchId);
      setJobs((previous) => mergeJobs(previous, payload.items || []));
      await refreshBatchJobs(batchId);
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "CSV intake failed");
    } finally {
      setIntakeLoading(false);
    }
  };

  const rankJob = async (jobId: string) => {
    try {
      setJobBusy(jobId, "Queueing ranking…");
      const res = await fetch("/api/jobs/" + jobId + "/rank", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { job?: JobRecord };
      const nextJob = payload.job;
      if (nextJob) {
        setJobs((previous) => mergeJobs(previous, [nextJob]));
        setBatchJobs((previous) => mergeJobs(previous, [nextJob]));
      }
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to queue ranking");
    } finally {
      setJobBusy(jobId, null);
    }
  };

  const tailorJob = async (
    jobId: string,
    matchResultId: string,
    provider: "local_ollama" | "deepseek_webview" = "local_ollama",
    verifierProvider?: "local_ollama" | "chatgpt_webview"
  ) => {
    try {
      setJobBusy(jobId, "Queueing tailor task…");
      const res = await fetch("/api/jobs/" + jobId + "/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchResultId, provider, verifierProvider }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { job?: JobRecord; task?: TailorTaskRow };
      const nextJob = payload.job ? { ...payload.job, latestTailorTask: payload.task ?? payload.job.latestTailorTask } : ({ id: jobId, latestTailorTask: payload.task } as JobRecord);
      setJobs((previous) => mergeJobs(previous, [nextJob]));
      setBatchJobs((previous) => mergeJobs(previous, [nextJob]));
      await refreshQueue();
      await refreshWorkerStatus();
      await refreshInteractiveQueues();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to queue tailoring");
    } finally {
      setJobBusy(jobId, null);
    }
  };

  const renderTaskInspector = (task: UnifiedTaskRow) => {
    const job = task.job_id ? knownJobsById.get(task.job_id) : undefined;
    const exactTailorTask =
      task.tailor_task_id
        ? tailorTaskDetails[task.tailor_task_id] ||
          (job?.latestTailorTask?.id === task.tailor_task_id ? (job.latestTailorTask as TailorTaskDetailRow) : undefined)
        : undefined;
    const latestFetchAttempt = job ? getLatestFetchAttempt(job) : null;
    const extractedProfile = job ? parseJobProfile(job.job_profile_json) : null;
    const patchSummary = summarizePatch(exactTailorTask?.resume_patch_json);
    const topMatch = job?.matchResults?.[0];
    const payload = parseJsonObject(task.payload_json || null);
    const verifierResult = exactTailorTask?.verifierResult ?? (job?.latestVerifierResult && job.latestTailorTask?.id === task.tailor_task_id ? job.latestVerifierResult : null);
    const violations = verifierResult ? parseVerifierViolations(verifierResult.violations_json) : [];

    return (
      <div className="rounded-md border bg-muted/10 p-3 text-xs text-muted-foreground space-y-3">
        <div className="grid gap-2 lg:grid-cols-3">
          <div>
            <div className="font-medium text-foreground">Task context</div>
            <div>Task id: <span className="font-mono">{task.id}</span></div>
            <div>Type: {task.task_type}</div>
            <div>Status: {task.status}</div>
            {task.job_id && <div>Job: <span className="font-mono">{task.job_id}</span></div>}
            {task.tailor_task_id && <div>Tailor task: <span className="font-mono">{task.tailor_task_id}</span></div>}
          </div>
          <div>
            <div className="font-medium text-foreground">Current linked result</div>
            {task.task_type === "job_fetch" && (
              <>
                <div>Fetch status: {latestFetchAttempt?.result_code || "pending"}</div>
                <div>Method: {latestFetchAttempt?.method || job?.fetch_method || "—"}</div>
                <div>Error: {job?.error_code || "—"}</div>
              </>
            )}
            {task.task_type === "job_extract" && (
              <>
                <div>Profile ready: {job ? (hasExtractedJobProfile(job) ? "yes" : "no") : "no"}</div>
                <div>Description length: {job?.description_text ? job.description_text.length : 0}</div>
                <div>Extraction confidence: {typeof extractedProfile?.confidence === "number" ? formatPercent(extractedProfile.confidence || 0) : "—"}</div>
              </>
            )}
            {task.task_type === "job_rank" && (
              <>
                <div>Top decision: {topMatch?.decision || "pending"}</div>
                <div>Top score: {topMatch ? formatPercent(topMatch.hybrid_score) : "—"}</div>
                <div>Top match: {topMatch ? `${topMatch.profile_name} / ${topMatch.variant_name}` : "—"}</div>
              </>
            )}
            {(task.task_type === "tailor_generate" || task.task_type === "tailor_verify") && (
              <>
                <div>Base snapshot: <span className="font-mono">{exactTailorTask?.base_snapshot_id || "—"}</span></div>
                <div>Provider: {exactTailorTask?.provider || "—"}</div>
                <div>Verifier: {exactTailorTask?.verifier_provider || "—"}</div>
                <div>Current tailored snapshot: <span className="font-mono">{exactTailorTask?.tailored_snapshot_id || "—"}</span></div>
              </>
            )}
          </div>
          <div>
            <div className="font-medium text-foreground">Payload / outcome</div>
            {payload ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(payload, null, 2)}</pre>
            ) : (
              <div>Payload not stored</div>
            )}
          </div>
        </div>

        {patchSummary && (
          <div className="rounded-md border bg-background/60 p-3 space-y-1">
            <div className="font-medium text-foreground">Current resume patch version</div>
            <div>Summary length: {patchSummary.summary.length}</div>
            <div>Skills reordered: {patchSummary.skillCount}</div>
            <div>Experience edits: {patchSummary.experienceEditCount}</div>
            <div>Removed items: {patchSummary.removedCount}</div>
            <div>Coverage notes: {patchSummary.coverageNoteCount}</div>
            {patchSummary.summary && <div className="line-clamp-4">Summary preview: {patchSummary.summary}</div>}
          </div>
        )}

        {verifierResult && (
          <div className="rounded-md border bg-background/60 p-3 space-y-1">
            <div className="font-medium text-foreground">Verifier state</div>
            <div>Pass: {Number(verifierResult.pass) === 1 ? "yes" : "no"}</div>
            <div>Quality: {formatPercent(verifierResult.quality_score || 0)}</div>
            <div>Violations: {violations.length}</div>
            {verifierResult.human_review_reason && <div>Reason: {verifierResult.human_review_reason}</div>}
          </div>
        )}

        {taskDetailErrors[task.id] && <div className="text-destructive">{taskDetailErrors[task.id]}</div>}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="container mx-auto max-w-7xl px-4 py-8 space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Unified Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            The desktop app now runs a staged pipeline across fetch, extract, rank, tailor generation, and verify. The cards below show queue state, batch progress, and whether the private Python worker is actually connected, running, and using local model providers.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Worker Status</CardTitle>
            <CardDescription>
              Private worker connectivity, provider mode, and local model readiness as seen from the Next.js server.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => void refreshWorkerStatus()} disabled={workerStatusLoading}>
                {workerStatusLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh worker
              </Button>
              <span className="text-sm text-muted-foreground">Configured: <strong>{workerStatus?.configured ? "yes" : "no"}</strong></span>
              <span className="text-sm text-muted-foreground">Connected: <strong>{workerStatus?.connected ? "yes" : "no"}</strong></span>
              <span className="text-sm text-muted-foreground">Running: <strong>{workerStatus?.worker?.running ? "yes" : "no"}</strong></span>
            </div>

            {workerStatus?.error && <p className="text-sm text-destructive">{workerStatus.error}</p>}

            {workerStatus?.worker ? (
              <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Worker</div>
                  <div><strong>ID:</strong> {workerStatus.worker.workerId || "—"}</div>
                  <div><strong>Processed:</strong> {workerStatus.worker.processedCount ?? 0}</div>
                  <div><strong>Idle polls:</strong> {workerStatus.worker.idlePollCount ?? 0}</div>
                </div>
                <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Providers</div>
                  <div><strong>Extract:</strong> {workerStatus.worker.providers?.extraction || "—"}</div>
                  <div><strong>Rank:</strong> {workerStatus.worker.providers?.ranking || "—"}</div>
                  <div><strong>Generate:</strong> {workerStatus.worker.providers?.generation || "—"}</div>
                  <div><strong>Verify:</strong> {workerStatus.worker.providers?.verifier || "—"}</div>
                </div>
                <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Ollama</div>
                  <div><strong>Reachable:</strong> {workerStatus.worker.ollama?.reachable ? "yes" : "no"}</div>
                  <div><strong>Extract model:</strong> {(workerStatus.worker.ollama?.extractModel || workerStatus.worker.ollama?.model || "—")} · ready {(workerStatus.worker.ollama?.extractModelAvailable ?? workerStatus.worker.ollama?.modelAvailable) ? "yes" : "no"}</div>
                  <div><strong>Generation model:</strong> {(workerStatus.worker.ollama?.generationModel || workerStatus.worker.ollama?.model || "—")} · ready {(workerStatus.worker.ollama?.generationModelAvailable ?? workerStatus.worker.ollama?.modelAvailable) ? "yes" : "no"}</div>
                  <div><strong>Verifier model:</strong> {(workerStatus.worker.ollama?.verifierModel || "—")} · ready {(workerStatus.worker.ollama?.verifierModelAvailable ?? workerStatus.worker.ollama?.modelAvailable) ? "yes" : "no"}</div>
                  <div><strong>Embed model:</strong> {workerStatus.worker.ollama?.embedModel || "—"} · ready {workerStatus.worker.ollama?.embedModelAvailable ? "yes" : "no"}</div>
                </div>
                <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-1">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">FastEmbed</div>
                  <div><strong>Available:</strong> {workerStatus.worker.fastembed?.available ? "yes" : "no"}</div>
                  <div><strong>Enabled for rank:</strong> {workerStatus.worker.fastembed?.enabledForRanking ? "yes" : "no"}</div>
                  <div><strong>Model:</strong> {workerStatus.worker.fastembed?.model || "—"}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">The server could not retrieve a worker status snapshot yet.</p>
            )}

            {workerStatus?.worker && (
              <div className="rounded-md border bg-muted/10 px-4 py-3 text-sm space-y-1">
                <div><strong>Last poll:</strong> {workerStatus.worker.lastPollAt || "—"}</div>
                <div><strong>Last processed task:</strong> {workerStatus.worker.lastProcessedAt || "—"}</div>
                <div><strong>Last task id:</strong> {workerStatus.worker.lastTaskId || "—"}</div>
                {workerStatus.worker.lastError && <div className="text-destructive"><strong>Last error:</strong> {workerStatus.worker.lastError}</div>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Interactive Providers</CardTitle>
            <CardDescription>
              DeepSeek generation and ChatGPT verification run as one-at-a-time interactive lanes. Use these queues to claim work, open the shared webview session, and submit structured JSON back into the staged pipeline.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => void refreshInteractiveQueues()} disabled={interactiveQueuesLoading}>
                {interactiveQueuesLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh interactive queues
              </Button>
              <span className="text-sm text-muted-foreground">DeepSeek waiting: <strong>{deepSeekTasks.filter((task) => task.status === "awaiting_claim").length}</strong></span>
              <span className="text-sm text-muted-foreground">DeepSeek active: <strong>{claimedDeepSeekTask ? 1 : 0}</strong></span>
              <span className="text-sm text-muted-foreground">ChatGPT waiting: <strong>{chatGptVerifierTasks.filter((task) => task.status === "awaiting_verifier_claim").length}</strong></span>
              <span className="text-sm text-muted-foreground">ChatGPT active: <strong>{claimedChatGptVerifierTask ? 1 : 0}</strong></span>
            </div>

            {interactiveQueuesError && <p className="text-sm text-destructive">{interactiveQueuesError}</p>}
            {interactiveActionError && <p className="text-sm text-destructive">{interactiveActionError}</p>}

            <div className="grid gap-6 xl:grid-cols-2">
              <div ref={deepSeekLaneRef} className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">DeepSeek Generator</div>
                    <div className="text-xs text-muted-foreground">Processes one claimed generation task at a time.</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setDeepSeekPanelOpen((value) => !value)}>
                      {deepSeekPanelOpen ? "Hide webview" : "Show webview"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void loadInteractiveProviderSession("deepseek")}>
                      Load session
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void saveInteractiveProviderSession("deepseek")}>
                      Save session
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => reloadInteractiveWebView("deepseek")}>
                      Refresh
                    </Button>
                  </div>
                </div>

                {claimedDeepSeekTask ? (
                  <div className="rounded-md border bg-muted/10 p-3 space-y-3">
                    <div className="text-sm">
                      <strong>Claimed task:</strong> {claimedDeepSeekTask.id}
                      {claimedDeepSeekTask.job_id && <span className="text-muted-foreground"> · {jobs.find((job) => job.id === claimedDeepSeekTask.job_id)?.title || claimedDeepSeekTask.job_id}</span>}
                      {typeof claimedDeepSeekTask.retries === "number" && typeof claimedDeepSeekTask.max_retries === "number" && (
                        <span className="text-muted-foreground"> · attempt {claimedDeepSeekTask.retries + 1} / {claimedDeepSeekTask.max_retries + 1}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Automation status: <strong>{deepSeekAutomation.taskId === claimedDeepSeekTask.id ? deepSeekAutomation.phase : "idle"}</strong>
                    </div>
                    {deepSeekAutomation.taskId === claimedDeepSeekTask.id && deepSeekAutomation.error && (
                      <p className="text-sm text-destructive">{deepSeekAutomation.error}</p>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="deepseek-generation-prompt">Generation prompt</Label>
                      <Textarea id="deepseek-generation-prompt" value={deepSeekPrompt} readOnly className="min-h-40 font-mono text-xs" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="deepseek-generation-result">Submit DeepSeek patch JSON</Label>
                      <Textarea
                        id="deepseek-generation-result"
                        value={deepSeekPatchJson}
                        onChange={(event) => setDeepSeekPatchJson(event.target.value)}
                        className="min-h-40 font-mono text-xs"
                        placeholder='{"summary":"...","skillsOrder":[],"experienceEdits":[],"removedItems":[],"coverageNotes":[],"providerMetadata":{"effective_provider":"deepseek_webview"}}'
                      />
                    </div>
                    {deepSeekAutomation.taskId === claimedDeepSeekTask.id && deepSeekAutomation.rawText ? (
                      <div className="space-y-2">
                        <Label htmlFor="deepseek-raw-output">DeepSeek raw output</Label>
                        <Textarea id="deepseek-raw-output" value={deepSeekAutomation.rawText} readOnly className="min-h-32 font-mono text-xs" />
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        onClick={() => void submitDeepSeekPatch(claimedDeepSeekTask.id)}
                        disabled={!deepSeekPatchJson.trim() || interactiveActionBusy === `submit:${claimedDeepSeekTask.id}`}
                      >
                        {interactiveActionBusy === `submit:${claimedDeepSeekTask.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                        Submit generation result
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void runDeepSeekAutomation(claimedDeepSeekTask.id, deepSeekPrompt)}
                        disabled={!deepSeekPrompt.trim() || (deepSeekAutomation.taskId === claimedDeepSeekTask.id && ["loading_session", "running", "parsing", "submitting"].includes(deepSeekAutomation.phase))}
                      >
                        Retry automation
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No DeepSeek generation task is currently claimed.</p>
                )}

                {deepSeekTasks.length > 0 ? (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Pos</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Job</TableHead>
                          <TableHead>Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deepSeekTasks.map((task, index) => {
                          const job = jobs.find((item) => item.id === task.job_id) || batchJobs.find((item) => item.id === task.job_id);
                          return (
                            <TableRow key={task.id}>
                              <TableCell>{index + 1}</TableCell>
                              <TableCell>{task.status}</TableCell>
                              <TableCell>{job?.title || task.job_id || "—"}</TableCell>
                              <TableCell>
                                {task.status === "awaiting_claim" ? (
                                  <Button type="button" size="sm" variant="outline" onClick={() => void claimDeepSeekTask(task.id)} disabled={Boolean(claimedDeepSeekTask) || interactiveActionBusy === `claim:${task.id}`}>
                                    Claim
                                  </Button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Active</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No DeepSeek generation tasks are waiting right now.</p>
                )}

                {deepSeekPanelOpen && (
                  <div className="rounded-md border overflow-hidden">
                    <webview
                      ref={(node) => { deepSeekWebViewRef.current = node as unknown as HTMLElement | null; }}
                      src={deepSeekSrc}
                      partition="persist:deepseek"
                      className="flex h-[24rem] w-full"
                      allowpopups={true}
                    />
                  </div>
                )}
              </div>

              <div ref={chatGptLaneRef} className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">ChatGPT Verifier</div>
                    <div className="text-xs text-muted-foreground">Processes one claimed verifier task at a time after generation is submitted.</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setChatGptPanelOpen((value) => !value)}>
                      {chatGptPanelOpen ? "Hide webview" : "Show webview"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void loadInteractiveProviderSession("chatgpt")}>
                      Load session
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => void saveInteractiveProviderSession("chatgpt")}>
                      Save session
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => reloadInteractiveWebView("chatgpt")}>
                      Refresh
                    </Button>
                  </div>
                </div>

                {claimedChatGptVerifierTask ? (
                  <div className="rounded-md border bg-muted/10 p-3 space-y-3">
                    <div className="text-sm">
                      <strong>Claimed verifier task:</strong> {claimedChatGptVerifierTask.id}
                      {claimedChatGptVerifierTask.job_id && <span className="text-muted-foreground"> · {jobs.find((job) => job.id === claimedChatGptVerifierTask.job_id)?.title || claimedChatGptVerifierTask.job_id}</span>}
                      {typeof claimedChatGptVerifierTask.retries === "number" && typeof claimedChatGptVerifierTask.max_retries === "number" && (
                        <span className="text-muted-foreground"> · attempt {claimedChatGptVerifierTask.retries} / {claimedChatGptVerifierTask.max_retries + 1}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Automation status: <strong>{chatGptAutomation.taskId === claimedChatGptVerifierTask.id ? chatGptAutomation.phase : "idle"}</strong>
                    </div>
                    {chatGptAutomation.taskId === claimedChatGptVerifierTask.id && chatGptAutomation.error && (
                      <p className="text-sm text-destructive">{chatGptAutomation.error}</p>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="chatgpt-verifier-prompt">Verifier prompt</Label>
                      <Textarea id="chatgpt-verifier-prompt" value={chatGptVerifierPrompt} readOnly className="min-h-40 font-mono text-xs" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="chatgpt-verifier-result">Submit ChatGPT verifier JSON</Label>
                      <Textarea
                        id="chatgpt-verifier-result"
                        value={chatGptVerifierJson}
                        onChange={(event) => setChatGptVerifierJson(event.target.value)}
                        className="min-h-40 font-mono text-xs"
                        placeholder='{"pass":true,"violations":[],"retryInstructions":[],"qualityScore":0.9,"humanReviewReason":null,"providerMetadata":{"effective_provider":"chatgpt_webview"}}'
                      />
                    </div>
                    {chatGptAutomation.taskId === claimedChatGptVerifierTask.id && chatGptAutomation.rawText ? (
                      <div className="space-y-2">
                        <Label htmlFor="chatgpt-raw-output">ChatGPT raw output</Label>
                        <Textarea id="chatgpt-raw-output" value={chatGptAutomation.rawText} readOnly className="min-h-32 font-mono text-xs" />
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        onClick={() => void submitChatGptVerifier(claimedChatGptVerifierTask.id)}
                        disabled={!chatGptVerifierJson.trim() || interactiveActionBusy === `submit-verifier:${claimedChatGptVerifierTask.id}`}
                      >
                        {interactiveActionBusy === `submit-verifier:${claimedChatGptVerifierTask.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                        Submit verifier result
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void runChatGptAutomation(claimedChatGptVerifierTask.id, chatGptVerifierPrompt)}
                        disabled={!chatGptVerifierPrompt.trim() || (chatGptAutomation.taskId === claimedChatGptVerifierTask.id && ["loading_session", "running", "parsing", "submitting"].includes(chatGptAutomation.phase))}
                      >
                        Retry automation
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No ChatGPT verifier task is currently claimed.</p>
                )}

                {chatGptVerifierTasks.length > 0 ? (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Pos</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Job</TableHead>
                          <TableHead>Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {chatGptVerifierTasks.map((task, index) => {
                          const job = jobs.find((item) => item.id === task.job_id) || batchJobs.find((item) => item.id === task.job_id);
                          return (
                            <TableRow key={task.id}>
                              <TableCell>{index + 1}</TableCell>
                              <TableCell>{task.status}</TableCell>
                              <TableCell>{job?.title || task.job_id || "—"}</TableCell>
                              <TableCell>
                                {task.status === "awaiting_verifier_claim" ? (
                                  <Button type="button" size="sm" variant="outline" onClick={() => void claimChatGptVerifierTask(task.id)} disabled={Boolean(claimedChatGptVerifierTask) || interactiveActionBusy === `claim-verifier:${task.id}`}>
                                    Claim
                                  </Button>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Active</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No ChatGPT verifier tasks are waiting right now.</p>
                )}

                {chatGptPanelOpen && (
                  <div className="rounded-md border overflow-hidden">
                    <webview
                      ref={(node) => { chatGptWebViewRef.current = node as unknown as HTMLElement | null; }}
                      src={chatGptSrc}
                      partition="persist:chatgpt"
                      className="flex h-[24rem] w-full"
                      allowpopups={true}
                    />
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Task Queue</CardTitle>
            <CardDescription>
              Operator controls for the stage-pooled execution model. In normal operation you run separate workers for fetch, rank, and GPU LLM stages; this view lets you inspect queue backlog and processed history.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => void refreshQueue()} disabled={queueLoading}>
                {queueLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh queue
              </Button>
              <Button type="button" onClick={() => void processNextQueueTask()} disabled={queueLoading}>
                {queueLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Process next task
              </Button>
              <Button type="button" variant="outline" onClick={() => void drainQueue()} disabled={queueLoading}>
                Drain queue
              </Button>
              <span className="text-sm text-muted-foreground">Open tasks: {queueItems.length}</span>
              <span className="text-sm text-muted-foreground">Processed history: {taskHistoryItems.length}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              With dedicated worker pools, ranking no longer needs to wait behind fetch or extract backlog. If you only run a single generic worker, tasks still advance one at a time through the shared queue.
            </p>
            {queueItems.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Job</TableHead>
                      <TableHead>Worker</TableHead>
                      <TableHead>Inspect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queueItems.map((task) => (
                      <React.Fragment key={task.id}>
                        <TableRow>
                          <TableCell>{task.task_type}</TableCell>
                          <TableCell>{task.status}</TableCell>
                          <TableCell className="font-mono text-xs">{task.job_id || "—"}</TableCell>
                          <TableCell>{task.worker_id || "—"}</TableCell>
                          <TableCell>
                            <Button type="button" size="sm" variant="outline" onClick={() => void toggleTaskDetails(task)} disabled={Boolean(taskDetailLoading[task.id])}>
                              {taskDetailLoading[task.id] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                              {expandedTaskIds[task.id] ? "Hide" : "Inspect"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {expandedTaskIds[task.id] && (
                          <TableRow>
                            <TableCell colSpan={5}>{renderTaskInspector(task)}</TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No queued or claimed tasks right now.</p>
            )}

            <div className="space-y-2">
              <div className="text-sm font-medium">Processed Task History</div>
              {taskHistoryItems.length > 0 ? (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Finished</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Job</TableHead>
                        <TableHead>Worker</TableHead>
                        <TableHead>Outcome</TableHead>
                        <TableHead>Inspect</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {taskHistoryItems.map((task) => (
                        <React.Fragment key={task.id}>
                          <TableRow>
                            <TableCell className="text-xs text-muted-foreground">{task.completed_at || task.updated_at || task.created_at || "—"}</TableCell>
                            <TableCell>{task.task_type}</TableCell>
                            <TableCell>
                              <span className={task.status === "failed" ? "text-destructive" : undefined}>{task.status}</span>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{task.job_id || "—"}</TableCell>
                            <TableCell>{task.worker_id || "—"}</TableCell>
                            <TableCell className="max-w-[28rem] text-xs text-muted-foreground">{getTaskOutcomeSummary(task)}</TableCell>
                            <TableCell>
                              <Button type="button" size="sm" variant="outline" onClick={() => void toggleTaskDetails(task)} disabled={Boolean(taskDetailLoading[task.id])}>
                                {taskDetailLoading[task.id] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                {expandedTaskIds[task.id] ? "Hide" : "Inspect"}
                              </Button>
                            </TableCell>
                          </TableRow>
                          {expandedTaskIds[task.id] && (
                            <TableRow>
                              <TableCell colSpan={7}>{renderTaskInspector(task)}</TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No completed or failed tasks have been loaded yet.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Resume Sync</CardTitle>
            <CardDescription>
              Owner-only desktop flow for selecting a local resume folder, computing a manifest, and sending changed HTML files to the unified sync APIs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_auto_auto]">
              <div className="space-y-2">
                <Label htmlFor="resume-sync-folder">Resume folder</Label>
                <Input id="resume-sync-folder" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="Choose a local folder from the desktop app" />
              </div>
              <div className="flex items-end">
                <Button type="button" variant="outline" onClick={chooseFolder}>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  Browse
                </Button>
              </div>
              <div className="flex items-end">
                <Button type="button" onClick={runResumeSync} disabled={syncLoading}>
                  {syncLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
                  Sync now
                </Button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={isFullSync} onChange={(event) => setIsFullSync(event.target.checked)} />
              Treat this as a full sync and archive imported variants missing from the manifest.
            </label>

            {syncError && <p className="text-sm text-destructive">{syncError}</p>}
            {syncProgress && <p className="text-sm text-muted-foreground">{syncProgress}</p>}

            {lastScan && (
              <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-4">
                  <span><strong>{lastScan.files.length}</strong> HTML files</span>
                  {lastScan.errors && lastScan.errors.length > 0 && <span><strong>{lastScan.errors.length}</strong> scan errors</span>}
                </div>
                {lastScan.errors && lastScan.errors.length > 0 && (
                  <div className="mt-2 max-h-28 overflow-y-auto font-mono text-xs text-muted-foreground">
                    {lastScan.errors.join("\n")}
                  </div>
                )}
              </div>
            )}

            {latestPreparedSync && (
              <div className="grid gap-3 md:grid-cols-4">
                {Object.entries(latestPreparedSync.counts).map(([key, value]) => (
                  <div key={key} className="rounded-md border bg-muted/20 px-3 py-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{key}</div>
                    <div className="text-lg font-semibold">{value}</div>
                  </div>
                ))}
              </div>
            )}

            {latestPreparedSync && latestPreparedSync.files.length > 0 && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Relative path</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Upload</TableHead>
                      <TableHead>Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {latestPreparedSync.files.slice(0, 20).map((file) => (
                      <TableRow key={file.relativePath}>
                        <TableCell className="font-mono text-xs">{file.relativePath}</TableCell>
                        <TableCell>{file.compareStatus}</TableCell>
                        <TableCell>{file.uploadStatus}</TableCell>
                        <TableCell>{formatBytes(file.size)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {latestCommittedSync && (
              <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm">
                <div><strong>Last committed sync:</strong> {latestCommittedSync.id}</div>
                <div><strong>Status:</strong> {latestCommittedSync.status}</div>
                {latestCommittedSync.summary_json && <div><strong>Summary:</strong> {latestCommittedSync.summary_json}</div>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Job Intake</CardTitle>
            <CardDescription>
              Submit one or many URLs, or upload a CSV with a required <code>URL</code> column. Intake now starts the staged pipeline at <code>job_fetch</code> and lets the worker pools auto-chain fetch, extract, rank, and verify work.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  <h2 className="text-base font-medium">Paste URLs</h2>
                </div>
                <Textarea
                  value={urlsText}
                  onChange={(event) => setUrlsText(event.target.value)}
                  className="min-h-40"
                  placeholder="Paste one job URL per line, or paste several URLs separated by whitespace"
                />
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{parsedUrlCount} URL{parsedUrlCount === 1 ? "" : "s"} detected</span>
                  <Button type="button" onClick={submitUrls} disabled={intakeLoading || parsedUrlCount === 0}>
                    {intakeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                    Start staged batch
                  </Button>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4" />
                  <h2 className="text-base font-medium">Upload CSV</h2>
                </div>
                <Input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setCsvFileName(file.name);
                    setCsvText(await file.text());
                  }}
                />
                <Textarea
                  value={csvText}
                  onChange={(event) => setCsvText(event.target.value)}
                  className="min-h-40 font-mono text-xs"
                  placeholder="URL,Company,Job"
                />
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{csvFileName || "No CSV selected"}</span>
                  <Button type="button" variant="outline" onClick={submitCsv} disabled={intakeLoading || !csvText.trim()}>
                    {intakeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                    Start staged batch
                  </Button>
                </div>
              </section>
            </div>

            {intakeError && <p className="text-sm text-destructive">{intakeError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Batch Execution</CardTitle>
            <CardDescription>
              Server-backed batch view keyed by <code>batch_id</code>. Use this to follow fetch, extract, rank, generate, and verify progress across large URL submissions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
              <div className="space-y-1">
                <Label htmlFor="pipeline-batch-select">Active batch</Label>
                <select
                  id="pipeline-batch-select"
                  value={activeBatchId || ""}
                  onChange={(event) => {
                    const nextBatchId = event.target.value || null;
                    setActiveBatchId(nextBatchId);
                    if (!nextBatchId) {
                      setBatchJobs([]);
                      setBatchError(null);
                    }
                  }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">No batch filter</option>
                  {availableBatchIds.map((batchId) => (
                    <option key={batchId} value={batchId}>{batchId}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <Button type="button" variant="outline" onClick={() => void refreshBatchJobs(activeBatchId)} disabled={!activeBatchId || batchLoading}>
                  {batchLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Refresh batch
                </Button>
              </div>
              <div className="flex items-end">
                <Button type="button" variant="outline" onClick={() => void hydrateBatchDetails(activeBatchId)} disabled={!activeBatchId || batchHydrating || activeBatchJobs.length === 0}>
                  {batchHydrating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  Hydrate details
                </Button>
              </div>
              <div className="flex items-end">
                <Button type="button" variant="ghost" onClick={() => { setActiveBatchId(null); setBatchJobs([]); setBatchError(null); }} disabled={!activeBatchId}>
                  Clear batch filter
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void retryBatchStage("job_fetch")} disabled={batchRetryGroups.job_fetch.length === 0 || Boolean(reviewBulkBusy)}>
                Retry failed fetch ({batchRetryGroups.job_fetch.length})
              </Button>
              <Button type="button" variant="outline" onClick={() => void retryBatchStage("job_extract")} disabled={batchRetryGroups.job_extract.length === 0 || Boolean(reviewBulkBusy)}>
                Retry failed extract ({batchRetryGroups.job_extract.length})
              </Button>
              <Button type="button" variant="outline" onClick={() => void retryBatchStage("job_rank")} disabled={batchRetryGroups.job_rank.length === 0 || Boolean(reviewBulkBusy)}>
                Retry failed rank ({batchRetryGroups.job_rank.length})
              </Button>
              <Button type="button" variant="outline" onClick={() => void retryBatchStage("tailor_verify")} disabled={batchRetryGroups.tailor_verify.length === 0 || Boolean(reviewBulkBusy)}>
                Retry failed verify ({batchRetryGroups.tailor_verify.length})
              </Button>
            </div>

            {batchError && <p className="text-sm text-destructive">{batchError}</p>}

            {!activeBatchId ? (
              <p className="text-sm text-muted-foreground">Choose a batch id to load server-backed job progress and counters for that intake run.</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                  {Object.entries(batchSummary).map(([key, value]) => (
                    <div key={key} className="rounded-md border bg-muted/20 px-3 py-3 text-sm space-y-1">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">{key.replace(/_/g, " ")}</div>
                      <div className="text-lg font-semibold">{value}</div>
                    </div>
                  ))}
                </div>

                {activeBatchJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No jobs have been loaded for this batch yet.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                      <span>Loaded jobs: <strong>{activeBatchJobs.length}</strong></span>
                      <span>Visible in job list: <strong>{filteredJobs.length}</strong></span>
                    </div>
                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Title</TableHead>
                            <TableHead>Company</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Stage</TableHead>
                            <TableHead>Decision</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {activeBatchJobs.slice(0, 30).map((job) => (
                            <TableRow key={job.id}>
                              <TableCell className="max-w-[20rem] truncate">{job.title || "Untitled job"}</TableCell>
                              <TableCell>{job.company || "—"}</TableCell>
                              <TableCell>{job.status}</TableCell>
                              <TableCell>{getBatchStageKey(job)}</TableCell>
                              <TableCell>{getPrimaryDecision(job)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {activeBatchJobs.length > 30 && (
                      <p className="text-xs text-muted-foreground">Showing the first 30 jobs here. Use the Session Jobs list below for full per-job drill-down.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Verifier Review Queue</CardTitle>
            <CardDescription>
              Jobs whose latest tailored result is blocked by the verifier or waiting for manual review.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span>Total jobs: <strong>{jobSummary.total}</strong></span>
              <span>Blocked: <strong>{jobSummary.blocked}</strong></span>
              <span>Retryable: <strong>{jobSummary.retryableBlocked}</strong></span>
              <span>Completed: <strong>{jobSummary.completed}</strong></span>
              <span>Ranked: <strong>{jobSummary.ranked}</strong></span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant={reviewOnly ? "default" : "outline"} onClick={() => setReviewOnly(reviewOnly ? false : true)}>
                {reviewOnly ? "Showing blocked only" : "Show blocked only"}
              </Button>
              <Button type="button" variant="outline" onClick={() => void refreshBlockedJobs()} disabled={Boolean(reviewBulkBusy) || reviewQueueJobs.length === 0}>
                {reviewBulkBusy === "Refreshing blocked jobs…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh blocked
              </Button>
              <Button type="button" variant="outline" onClick={() => void retryBlockedJobs()} disabled={Boolean(reviewBulkBusy) || retryableReviewQueueJobs.length === 0}>
                {reviewBulkBusy === "Queueing blocked tailoring retries…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Retry local tailor
              </Button>
              <Button type="button" variant="outline" onClick={exportBlockedVerifierReportsJson} disabled={reviewQueueJobs.length === 0 || Boolean(reviewBulkBusy)}>
                Export JSON
              </Button>
              <Button type="button" variant="outline" onClick={exportBlockedVerifierReportsCsv} disabled={reviewQueueJobs.length === 0 || Boolean(reviewBulkBusy)}>
                Export CSV
              </Button>
              <Button type="button" variant="ghost" onClick={clearJobFilters}>
                Clear filters
              </Button>
            </div>
            {reviewBulkBusy && <p className="text-sm text-muted-foreground">{reviewBulkBusy}</p>}
            {reviewQueueJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No blocked verifier results right now.</p>
            ) : (
              <div className="space-y-2">
                {reviewQueueJobs.map((job) => {
                  const topMatch = job.matchResults?.[0];
                  const busyLabel = busyJobIds[job.id];
                  return (
                    <div key={job.id} className="flex flex-col gap-3 rounded-md border bg-muted/10 p-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="font-medium">{job.title || "Untitled job"}</div>
                        <div className="text-sm text-muted-foreground">{job.company || "Unknown company"}</div>
                        <div className="text-xs text-muted-foreground">Status: {job.latestTailorTask?.status || job.status} · Violations: {getVerifierViolationCount(job)}</div>
                        {topMatch ? (
                          <div className="text-xs text-muted-foreground">Top match: {topMatch.profile_name} / {topMatch.variant_name}</div>
                        ) : (
                          <div className="text-xs text-muted-foreground">No ranked match available for retry yet.</div>
                        )}
                        {getVerifierSummary(job) && <div className="text-xs text-muted-foreground">{getVerifierSummary(job)}</div>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => focusReviewJob(job)}>
                          Focus in list
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => topMatch && void tailorJob(job.id, topMatch.id)} disabled={!topMatch || Boolean(busyLabel) || Boolean(reviewBulkBusy)}>
                          {busyLabel === "Queueing tailor task…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                          Retry tailor
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => void refreshJob(job.id)} disabled={Boolean(busyLabel) || Boolean(reviewBulkBusy)}>
                          Refresh
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Session Jobs</CardTitle>
            <CardDescription>
              Jobs created in this desktop session. Use filters to focus on blocked verifier results, job status, or top match decisions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 xl:grid-cols-[2fr_1fr_1fr_auto_auto]">
              <div className="space-y-1">
                <Label htmlFor="pipeline-job-search">Search</Label>
                <Input id="pipeline-job-search" value={jobSearch} onChange={(event) => setJobSearch(event.target.value)} placeholder="Search title, company, URL, match text, or verifier reason" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pipeline-status-filter">Job status</Label>
                <select id="pipeline-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="all">All statuses</option>
                  <option value="queued">queued</option>
                  <option value="fetching">fetching</option>
                  <option value="extracting">extracting</option>
                  <option value="extracted">extracted</option>
                  <option value="ranked">ranked</option>
                  <option value="tailoring">tailoring</option>
                  <option value="verifying">verifying</option>
                  <option value="completed">completed</option>
                  <option value="manual_review_required">manual_review_required</option>
                  <option value="failed">failed</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pipeline-decision-filter">Decision</Label>
                <select id="pipeline-decision-filter" value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="all">All decisions</option>
                  <option value="use_as_is">use_as_is</option>
                  <option value="review">review</option>
                  <option value="need_tailor">need_tailor</option>
                  <option value="not_eligible">not_eligible</option>
                  <option value="blocked_by_verifier">blocked_by_verifier</option>
                </select>
              </div>
              <div className="flex items-end">
                <Button type="button" variant={reviewOnly ? "default" : "outline"} onClick={() => setReviewOnly(reviewOnly ? false : true)}>
                  {reviewOnly ? "Blocked only" : "Show blocked"}
                </Button>
              </div>
              <div className="flex items-end">
                <Button type="button" variant="ghost" onClick={clearJobFilters}>
                  Clear
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>Total: <strong>{jobSummary.total}</strong></span>
              <span>Visible: <strong>{jobSummary.visible}</strong></span>
              <span>Blocked: <strong>{jobSummary.blocked}</strong></span>
            </div>

            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs in this session yet.</p>
            ) : filteredJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs match the current filters.</p>
            ) : (
              <div className="space-y-4">
                {filteredJobs.map((job) => {
                  const busyLabel = busyJobIds[job.id];
                  const matches = job.matchResults || [];
                  const topMatch = matches[0];
                  const jobProfile = parseJobProfile(job.job_profile_json);
                  const latestFetchAttempt = getLatestFetchAttempt(job);
                  const latestMatchSummary = getLatestMatchSummary(job);
                  const extractionArtifacts = (job.jobArtifacts || []).filter((artifact) => artifact.artifact_kind === "source_html" || artifact.artifact_kind === "job_json");
                  return (
                    <div key={job.id} className="rounded-lg border p-4 space-y-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-1">
                          <div className="text-lg font-semibold">{job.title || "Untitled job"}</div>
                          <div className="text-sm text-muted-foreground">{job.company || "Unknown company"}</div>
                          <div className="text-xs font-mono text-muted-foreground break-all">{job.canonical_url}</div>
                          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>Status: <strong>{job.status}</strong></span>
                            {job.processing_stage && <span>Stage: <strong>{job.processing_stage}</strong></span>}
                            {job.batchId && <span>Batch: <strong>{job.batchId}</strong></span>}
                            {job.work_model && <span>Work model: <strong>{job.work_model}</strong></span>}
                            {job.location && <span>Location: <strong>{job.location}</strong></span>}
                          </div>
                          {job.linkedApplication && (
                            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                              <span>Application: <strong>{job.linkedApplication.id}</strong></span>
                              <span>Applied: <strong>{Number(job.linkedApplication.applied_manually) === 1 ? "yes" : "no"}</strong></span>
                              {job.linkedApplication.resume_file_name && <span>Resume file: <strong>{job.linkedApplication.resume_file_name}</strong></span>}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" onClick={() => void refreshJob(job.id)} disabled={Boolean(busyLabel)}>
                            {busyLabel === "Refreshing…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                            Refresh
                          </Button>
                          <Button type="button" onClick={() => void rankJob(job.id)} disabled={Boolean(busyLabel)}>
                            {busyLabel === "Queueing ranking…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                            Queue ranking
                          </Button>
                        </div>
                      </div>

                      {busyLabel && <p className="text-sm text-muted-foreground">{busyLabel}</p>}

                      <div className="grid gap-3 xl:grid-cols-5">
                        <div className="rounded-md border bg-muted/10 p-3 text-sm space-y-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Fetch result</div>
                          <div><strong>Status:</strong> {latestFetchAttempt?.result_code || (job.fetch_method ? "fetched" : job.status === "fetching" ? "running" : "pending")}</div>
                          <div className="text-xs text-muted-foreground">Method: {latestFetchAttempt?.method || job.fetch_method || "—"}</div>
                          <div className="text-xs text-muted-foreground">Attempts: {job.fetchAttempts?.length || 0}</div>
                          {isFailedFetchJob(job) && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void requeueJobStage(job.id, "job_fetch")} disabled={Boolean(busyLabel)}>
                              Retry fetch
                            </Button>
                          )}
                        </div>
                        <div className="rounded-md border bg-muted/10 p-3 text-sm space-y-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Extraction result</div>
                          <div><strong>Status:</strong> {jobProfile ? "ready" : job.status === "extracting" ? "running" : job.description_text ? "pending profile" : "pending"}</div>
                          <div className="text-xs text-muted-foreground">Confidence: {typeof jobProfile?.confidence === "number" ? formatPercent(jobProfile.confidence) : "—"}</div>
                          <div className="text-xs text-muted-foreground">Artifacts: {extractionArtifacts.length}</div>
                          {isFailedExtractJob(job) && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void requeueJobStage(job.id, "job_extract")} disabled={Boolean(busyLabel)}>
                              Retry extract
                            </Button>
                          )}
                        </div>
                        <div className="rounded-md border bg-muted/10 p-3 text-sm space-y-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Ranking result</div>
                          <div><strong>Decision:</strong> {topMatch?.decision || String(latestMatchSummary?.nextAction || "pending")}</div>
                          <div className="text-xs text-muted-foreground">Top score: {topMatch ? formatPercent(topMatch.hybrid_score) : "—"}</div>
                          <div className="text-xs text-muted-foreground">Matches: {matches.length}</div>
                          {hasExtractedJobProfile(job) && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void requeueJobStage(job.id, "job_rank")} disabled={Boolean(busyLabel)}>
                              Retry rank
                            </Button>
                          )}
                        </div>
                        <div className="rounded-md border bg-muted/10 p-3 text-sm space-y-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Tailor result</div>
                          <div><strong>Status:</strong> {job.latestTailorTask?.status || "not started"}</div>
                          <div className="text-xs text-muted-foreground">Provider: {job.latestTailorTask?.provider || "—"}</div>
                          <div className="text-xs text-muted-foreground">Verifier: {job.latestTailorTask?.verifier_provider || "—"}</div>
                          <div className="text-xs text-muted-foreground">Snapshot: {job.latestTailorTask?.tailored_snapshot_id || "—"}</div>
                          {topMatch && (
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" size="sm" variant="outline" onClick={() => void tailorJob(job.id, topMatch.id)} disabled={Boolean(busyLabel)}>
                                Queue local tailor
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void tailorJob(job.id, topMatch.id, "deepseek_webview", "chatgpt_webview")}
                                disabled={Boolean(busyLabel)}
                              >
                                Queue DeepSeek + ChatGPT
                              </Button>
                            </div>
                          )}
                        </div>
                        <div className="rounded-md border bg-muted/10 p-3 text-sm space-y-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">Verifier result</div>
                          <div><strong>Status:</strong> {job.latestVerifierResult ? (Number(job.latestVerifierResult.pass) === 1 ? "pass" : "blocked") : "pending"}</div>
                          <div className="text-xs text-muted-foreground">Quality: {job.latestVerifierResult ? formatPercent(job.latestVerifierResult.quality_score || 0) : "—"}</div>
                          <div className="text-xs text-muted-foreground">Violations: {getVerifierViolationCount(job)}</div>
                          {isRetryableVerifyJob(job) && (
                            <Button type="button" size="sm" variant="outline" onClick={() => void requeueJobStage(job.id, "tailor_verify")} disabled={Boolean(busyLabel)}>
                              Retry verify
                            </Button>
                          )}
                        </div>
                      </div>

                      {job.unifiedTasks && job.unifiedTasks.length > 0 && (
                        <div className="rounded-md border bg-muted/10 p-3 text-xs text-muted-foreground space-y-1">
                          <div className="font-medium text-foreground">Queued work for this job</div>
                          {job.unifiedTasks.map((task) => (
                            <div key={task.id}>{task.task_type} · {task.status}</div>
                          ))}
                        </div>
                      )}

                      {(job.fetchAttempts && job.fetchAttempts.length > 0) || job.latestMatchRun || job.error_code || job.error_message || jobProfile || job.description_text || extractionArtifacts.length > 0 ? (
                        <details className="rounded-md border bg-muted/10 p-3 text-sm" open={job.status === "extracted" || job.status === "ranked"}>
                          <summary className="cursor-pointer font-medium text-foreground">Job diagnostics</summary>
                          <div className="mt-3 space-y-3">
                            {(job.error_code || job.error_message) && (
                              <div className="rounded-md border bg-background/60 p-3 text-sm space-y-1">
                                {job.error_code && <div><strong>Error code:</strong> {job.error_code}</div>}
                                {job.error_message && <div><strong>Error message:</strong> {job.error_message}</div>}
                              </div>
                            )}
                            {job.latestMatchRun && (
                              <div className="rounded-md border bg-background/60 p-3 text-sm space-y-1">
                                <div><strong>Latest match run:</strong> {job.latestMatchRun.id}</div>
                                <div><strong>Status:</strong> {job.latestMatchRun.status}</div>
                                {job.latestMatchRun.summary_json && <div><strong>Summary:</strong> {job.latestMatchRun.summary_json}</div>}
                              </div>
                            )}
                            {job.fetchAttempts && job.fetchAttempts.length > 0 && (
                              <div className="space-y-2">
                                <div className="font-medium text-foreground">Fetch attempts</div>
                                <div className="space-y-2">
                                  {job.fetchAttempts.map((attempt) => (
                                    <div key={attempt.id} className="rounded-md border bg-background/60 p-3 text-xs text-muted-foreground space-y-1">
                                      <div className="flex flex-wrap gap-3">
                                        <span><strong className="text-foreground">Method:</strong> {attempt.method}</span>
                                        <span><strong className="text-foreground">Result:</strong> {attempt.result_code}</span>
                                        {attempt.status_code != null && <span><strong className="text-foreground">HTTP:</strong> {attempt.status_code}</span>}
                                      </div>
                                      {attempt.error_message && <div><strong className="text-foreground">Error:</strong> {attempt.error_message}</div>}
                                      {attempt.excerpt && <div className="line-clamp-4 break-words"><strong className="text-foreground">Excerpt:</strong> {attempt.excerpt}</div>}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {(jobProfile || job.description_text || extractionArtifacts.length > 0) && (
                              <div className="space-y-2">
                                <div className="font-medium text-foreground">Extraction result</div>
                                {jobProfile && (
                                  <div className="rounded-md border bg-background/60 p-3 text-xs text-muted-foreground space-y-2">
                                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                                      <div><strong className="text-foreground">Title:</strong> {jobProfile.title || job.title || "—"}</div>
                                      <div><strong className="text-foreground">Company:</strong> {jobProfile.company || job.company || "—"}</div>
                                      <div><strong className="text-foreground">Location:</strong> {jobProfile.location || job.location || "—"}</div>
                                      <div><strong className="text-foreground">Work model:</strong> {jobProfile.workModel || job.work_model || "—"}</div>
                                      <div><strong className="text-foreground">Seniority:</strong> {jobProfile.seniority || job.seniority || "—"}</div>
                                      <div><strong className="text-foreground">Confidence:</strong> {typeof jobProfile.confidence === "number" ? formatPercent(jobProfile.confidence) : "—"}</div>
                                    </div>
                                    <div><strong className="text-foreground">Primary stack:</strong> {renderJoinedList(jobProfile.primaryStack)}</div>
                                    <div><strong className="text-foreground">Secondary stack:</strong> {renderJoinedList(jobProfile.secondaryStack)}</div>
                                    <div><strong className="text-foreground">Tools:</strong> {renderJoinedList(jobProfile.tools)}</div>
                                    <div><strong className="text-foreground">Domain:</strong> {renderJoinedList(jobProfile.domain)}</div>
                                    <div><strong className="text-foreground">Keywords:</strong> {renderJoinedList(jobProfile.keywords)}</div>
                                    <div><strong className="text-foreground">Hard stops:</strong> {renderJoinedList(jobProfile.hardStops)}</div>
                                    {jobProfile.summary && <div><strong className="text-foreground">Summary:</strong> {jobProfile.summary}</div>}
                                  </div>
                                )}
                                {job.description_text && (
                                  <details className="rounded-md border bg-background/60 p-3 text-xs text-muted-foreground">
                                    <summary className="cursor-pointer font-medium text-foreground">Full extracted job description</summary>
                                    <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words">{job.description_text}</pre>
                                  </details>
                                )}
                                {extractionArtifacts.length > 0 && (
                                  <div className="space-y-2">
                                    <div className="font-medium text-foreground">Extraction artifacts</div>
                                    <div className="space-y-2">
                                      {extractionArtifacts.map((artifact) => (
                                        <div key={artifact.id} className="flex flex-col gap-2 rounded-md border bg-background/60 p-3 md:flex-row md:items-center md:justify-between">
                                          <div className="min-w-0 space-y-1">
                                            <div className="text-sm font-medium">{artifact.artifact_kind}</div>
                                            <div className="font-mono text-xs text-muted-foreground break-all">{artifact.relative_path}</div>
                                          </div>
                                          <div className="flex flex-wrap gap-2">
                                            <Button type="button" size="sm" variant="outline" onClick={() => void openArtifactPreview(artifact)}>
                                              Preview
                                            </Button>
                                            <Button type="button" size="sm" variant="ghost" asChild>
                                              <a href={artifactDownloadHref(artifact)} target="_blank" rel="noreferrer">Download</a>
                                            </Button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </details>
                      ) : null}

                      {matches.length > 0 && (
                        <div className="space-y-3">
                          <h3 className="text-sm font-medium">Top matches</h3>
                          <div className="grid gap-3 lg:grid-cols-2">
                            {matches.slice(0, 4).map((match) => {
                              const matched = parseJsonArray(match.matched_requirements_json);
                              const missing = parseJsonArray(match.missing_requirements_json);
                              return (
                                <div key={match.id} className="rounded-md border bg-muted/10 p-3 space-y-2">
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <div className="font-medium">{match.profile_name}</div>
                                      <div className="text-sm text-muted-foreground">{match.variant_name}</div>
                                    </div>
                                    <div className="text-right">
                                      <div className="text-sm font-semibold">{formatPercent(match.hybrid_score)}</div>
                                      <div className="text-xs text-muted-foreground">{match.decision}</div>
                                    </div>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    Similarity {formatPercent(match.similarity_score)} · Rules {formatPercent(match.rule_score)} · Rerank {formatPercent(match.rerank_score)}
                                  </div>
                                  <p className="text-sm">{match.reason}</p>
                                  <div className="text-xs text-muted-foreground">
                                    <div>Matched: {matched.length > 0 ? matched.join(", ") : "—"}</div>
                                    <div>Missing: {missing.length > 0 ? missing.join(", ") : "—"}</div>
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    <Button type="button" size="sm" variant="outline" onClick={() => void tailorJob(job.id, match.id)} disabled={Boolean(busyLabel)}>
                                      {busyLabel === "Queueing tailor task…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                                      Queue local tailor
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => void tailorJob(job.id, match.id, "deepseek_webview", "chatgpt_webview")}
                                      disabled={Boolean(busyLabel)}
                                    >
                                      Queue DeepSeek + ChatGPT
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {job.latestTailorTask && (
                        <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-3">
                          <div className="space-y-1">
                            <div><strong>Last tailor task:</strong> {job.latestTailorTask.id}</div>
                            <div><strong>Status:</strong> {job.latestTailorTask.status}</div>
                            <div><strong>Provider:</strong> {job.latestTailorTask.provider}</div>
                            {job.latestTailorTask.tailored_snapshot_id && <div><strong>Snapshot:</strong> {job.latestTailorTask.tailored_snapshot_id}</div>}
                          </div>

                          {job.latestVerifierResult && (
                            <div className="rounded-md border bg-background/60 p-3 space-y-2">
                              <div className="flex flex-wrap items-center gap-3">
                                <span><strong>Verifier:</strong> {job.latestVerifierResult.pass ? "pass" : "blocked"}</span>
                                <span><strong>Quality:</strong> {formatPercent(job.latestVerifierResult.quality_score || 0)}</span>
                              </div>
                              {job.latestVerifierResult.human_review_reason && (
                                <p className="text-sm text-muted-foreground">{job.latestVerifierResult.human_review_reason}</p>
                              )}
                              {parseVerifierViolations(job.latestVerifierResult.violations_json).length > 0 && (
                                <div className="space-y-1">
                                  <div><strong>Violations</strong></div>
                                  <ul className="space-y-1 text-xs text-muted-foreground">
                                    {parseVerifierViolations(job.latestVerifierResult.violations_json).map((violation, index) => (
                                      <li key={violation.type + violation.message + index}>
                                        {violation.type}: {violation.message}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {parseJsonArray(job.latestVerifierResult.retry_instructions_json).length > 0 && (
                                <div className="space-y-1">
                                  <div><strong>Retry instructions</strong></div>
                                  <ul className="space-y-1 text-xs text-muted-foreground">
                                    {parseJsonArray(job.latestVerifierResult.retry_instructions_json).map((instruction, index) => (
                                      <li key={instruction + index}>{instruction}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}

                          {job.artifacts && job.artifacts.length > 0 && (
                            <div className="space-y-2">
                              <div><strong>Artifacts</strong></div>
                              <div className="space-y-2">
                                {job.artifacts.map((artifact) => (
                                  <div key={artifact.id} className="flex flex-col gap-2 rounded-md border bg-background/60 p-3 md:flex-row md:items-center md:justify-between">
                                    <div className="min-w-0 space-y-1">
                                      <div className="text-sm font-medium">{artifact.artifact_kind}</div>
                                      <div className="font-mono text-xs text-muted-foreground break-all">{artifact.relative_path}</div>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      <Button type="button" size="sm" variant="outline" onClick={() => void openArtifactPreview(artifact)}>
                                        Preview
                                      </Button>
                                      <Button type="button" size="sm" variant="ghost" asChild>
                                        <a href={artifactDownloadHref(artifact)} target="_blank" rel="noreferrer">Download</a>
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Dialog open={Boolean(previewArtifact)} onOpenChange={(open) => { if (!open) closeArtifactPreview(); }}>
          <DialogContent className="max-w-6xl h-[85vh] p-0 overflow-hidden" noZoomAnimation>
            {previewArtifact && (
              <div className="flex h-full min-h-0 flex-col">
                <DialogHeader className="border-b px-6 py-4">
                  <DialogTitle>{previewArtifact.artifact_kind}</DialogTitle>
                  <DialogDescription className="font-mono text-xs break-all">
                    {previewArtifact.relative_path}
                  </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-hidden bg-muted/10">
                  {previewError ? (
                    <div className="p-6 text-sm text-destructive">{previewError}</div>
                  ) : previewLoading ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading preview…
                    </div>
                  ) : artifactPreviewMode(previewArtifact) === "json" ? (
                    <pre className="h-full overflow-auto p-6 text-xs text-foreground whitespace-pre-wrap break-words">{previewText}</pre>
                  ) : artifactPreviewMode(previewArtifact) === "pdf" ? (
                    <iframe title={artifactFileName(previewArtifact)} src={artifactPreviewHref(previewArtifact)} className="h-full w-full border-0 bg-background" />
                  ) : artifactPreviewMode(previewArtifact) === "html" ? (
                    <iframe title={artifactFileName(previewArtifact)} src={artifactPreviewHref(previewArtifact)} className="h-full w-full border-0 bg-background" />
                  ) : (
                    <iframe title={artifactFileName(previewArtifact)} src={artifactPreviewHref(previewArtifact)} className="h-full w-full border-0 bg-background" />
                  )}
                </div>

                <DialogFooter className="border-t px-6 py-4">
                  <Button type="button" variant="outline" asChild>
                    <a href={artifactPreviewHref(previewArtifact)} target="_blank" rel="noreferrer">Open in new tab</a>
                  </Button>
                  <Button type="button" asChild>
                    <a href={artifactDownloadHref(previewArtifact)} target="_blank" rel="noreferrer">Download</a>
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
