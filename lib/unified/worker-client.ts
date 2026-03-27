import type {
  GenerationProviderId,
  ImportedResumeDocument,
  JobProfile,
  RankedResumeCandidate,
  ResumePatch,
  VerifierResult,
} from "@/lib/unified/types";

function getWorkerBaseUrl(): string | null {
  const value = process.env.UNIFIED_AI_WORKER_BASE_URL?.trim();
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

function isStrictMode(): boolean {
  const value = process.env.UNIFIED_AI_WORKER_STRICT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function getWorkerTimeoutMs(): number {
  const explicit = Number.parseInt(process.env.UNIFIED_AI_WORKER_TIMEOUT_MS || "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const ollamaSeconds = Number.parseInt(process.env.OLLAMA_TIMEOUT_SECONDS || "", 10);
  if (Number.isFinite(ollamaSeconds) && ollamaSeconds > 0) return ollamaSeconds * 1000 + 15_000;
  return 135_000;
}

async function postWorkerJson<T>(path: string, body: unknown): Promise<T | null> {
  const baseUrl = getWorkerBaseUrl();
  if (!baseUrl) return null;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = process.env.UNIFIED_AI_WORKER_TOKEN?.trim();
  if (token) {
    headers["x-unified-ai-worker-token"] = token;
  }

  try {
    const controller = new AbortController();
    const timeoutMs = getWorkerTimeoutMs();
    const timeoutId = setTimeout(() => controller.abort(new Error(`Unified AI worker request timed out after ${timeoutMs}ms`)), timeoutMs);
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeoutId);
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error("Unified AI worker request failed with " + response.status + ": " + (text || response.statusText));
    }
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch (error) {
    if (isStrictMode()) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    console.warn("Unified AI worker unavailable, falling back to local engine:", error);
    return null;
  }
}

export async function extractJobProfileFromWorker(input: {
  pageTitle: string;
  descriptionText: string;
  titleHint?: string | null;
  companyHint?: string | null;
}): Promise<JobProfile | null> {
  const result = await postWorkerJson<{ jobProfile: JobProfile }>("/pipeline/extract-job-profile", input);
  return result?.jobProfile ?? null;
}

export async function rankResumeDocumentsFromWorker(
  jobProfile: JobProfile,
  resumes: Array<{ snapshotId: string; variantId: string; profileName: string; variantName: string; document: ImportedResumeDocument }>
): Promise<RankedResumeCandidate[] | null> {
  const result = await postWorkerJson<{ results: RankedResumeCandidate[] }>("/pipeline/rank", { jobProfile, resumes });
  return result?.results ?? null;
}

export async function generateTailoredPatchFromWorker(
  baseDocument: ImportedResumeDocument,
  jobProfile: JobProfile,
  match: RankedResumeCandidate,
  providerId: GenerationProviderId
): Promise<ResumePatch | null> {
  const result = await postWorkerJson<{ patch: ResumePatch }>("/pipeline/generate-tailor", {
    baseDocument,
    jobProfile,
    match,
    providerId,
  });
  return result?.patch ?? null;
}

export async function verifyTailoredPatchFromWorker(
  baseDocument: ImportedResumeDocument,
  patch: ResumePatch,
  jobProfile: JobProfile
): Promise<VerifierResult | null> {
  const result = await postWorkerJson<{ verifier: VerifierResult }>("/pipeline/verify-tailor", {
    baseResume: baseDocument,
    patch,
    jobProfile,
  });
  return result?.verifier ?? null;
}
