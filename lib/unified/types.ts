import type { ResumeData } from "@/lib/resume-store";

export type ResumeSyncRunStatus = "prepared" | "uploading" | "processing" | "completed" | "partial" | "failed";
export type ResumeSyncCompareStatus = "new" | "changed" | "unchanged" | "missing";
export type ResumeSyncUploadStatus = "pending" | "uploaded" | "skipped";
export type ResumeSnapshotKind = "imported" | "tailored";
export type ResumeSnapshotStatus = "active" | "archived" | "manual_review_required" | "parse_failed" | "processing";
export type JobSourceType = "url" | "csv";
export type JobStatus = "queued" | "fetching" | "fetched" | "extracting" | "extracted" | "ranking" | "ranked" | "tailoring" | "completed" | "manual_review_required" | "failed";
export type JobFetchResultCode =
  | "SUCCESS"
  | "EXPIRED"
  | "INVALID_URL"
  | "UNSUPPORTED_DOMAIN"
  | "AUTH_REQUIRED"
  | "CAPTCHA_BLOCKED"
  | "CONTENT_TOO_THIN"
  | "EXTRACTION_LOW_CONFIDENCE"
  | "RETRYABLE_ERROR"
  | "PERMANENT_ERROR";
export type MatchDecision = "use_as_is" | "review" | "need_tailor" | "not_eligible";
export type TailorTaskStatus = "queued" | "awaiting_claim" | "claimed" | "submitted" | "verifying" | "completed" | "manual_review_required" | "failed";
export type GenerationProviderId = "deepseek_webview" | "local_ollama";
export type ArtifactOwnerType = "resume_snapshot" | "job" | "match_run" | "tailor_task";

export interface ResumeChunk {
  id: string;
  section: string;
  text: string;
  keywords: string[];
}

export interface ParsedResumeSourceMeta {
  relativePath: string;
  profileName: string;
  variantName: string;
  dateLabel: string | null;
  fileName: string;
}

export interface ImportedResumeDocument {
  source: ParsedResumeSourceMeta;
  rawText: string;
  sections: Record<string, string>;
  chunks: ResumeChunk[];
  resumeData: ResumeData;
}

export interface JobProfile {
  title: string;
  company: string;
  location: string;
  workModel: "remote" | "hybrid" | "onsite" | "unknown";
  seniority: "junior" | "mid" | "senior" | "staff" | "principal" | "unknown";
  primaryStack: string[];
  secondaryStack: string[];
  tools: string[];
  keywords: string[];
  domain: string[];
  summary: string;
  hardStops: string[];
  confidence: number;
}

export interface ResumePatchExperienceEdit {
  experienceId: string;
  originalText: string;
  tailoredText: string;
}

export interface ResumePatch {
  summary: string;
  skillsOrder: string[];
  experienceEdits: ResumePatchExperienceEdit[];
  removedItems: string[];
  coverageNotes: string[];
  providerMetadata: Record<string, unknown>;
}

export interface VerifierViolation {
  type: "unsupported_claim" | "invented_metric" | "invented_tool" | "missing_required_keyword" | "format_violation" | "keyword_stuffing";
  message: string;
}

export interface VerifierResult {
  pass: boolean;
  violations: VerifierViolation[];
  retryInstructions: string[];
  qualityScore: number;
  humanReviewReason: string | null;
  providerMetadata: Record<string, unknown>;
}

export interface RankedResumeCandidate {
  resumeSnapshotId: string;
  resumeVariantId: string;
  profileName: string;
  variantName: string;
  similarityScore: number;
  ruleScore: number;
  rerankScore: number;
  hybridScore: number;
  decision: MatchDecision;
  reason: string;
  matchedRequirements: string[];
  missingRequirements: string[];
  supportingChunkIds: string[];
}

export interface ResumeSyncManifestFile {
  relativePath: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

export interface ResumeSyncPrepareResult {
  syncRunId: string;
  status: ResumeSyncRunStatus;
  counts: Record<ResumeSyncCompareStatus, number>;
  files: Array<ResumeSyncManifestFile & { compareStatus: ResumeSyncCompareStatus; uploadStatus: ResumeSyncUploadStatus }>;
}

export interface JobQueueItem {
  id: string;
  intakeItemId: string;
  canonicalUrl: string;
  status: JobStatus;
}
