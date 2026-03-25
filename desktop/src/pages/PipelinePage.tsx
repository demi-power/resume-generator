import React, { useEffect, useMemo, useState } from "react";
import { FolderOpen, FileSpreadsheet, Link2, Loader2, RefreshCw, Sparkles, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";

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
  tailored_snapshot_id?: string | null;
  verifier_result_id?: string | null;
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

type UnifiedTaskRow = {
  id: string;
  task_type: string;
  status: string;
  job_id?: string | null;
  tailor_task_id?: string | null;
  worker_id?: string | null;
  created_at?: string;
};

type JobRecord = {
  id: string;
  status: string;
  processing_stage?: string;
  canonical_url: string;
  raw_url?: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  work_model?: string | null;
  latestTailorTask?: TailorTaskRow | null;
  latestVerifierResult?: VerifierResultRow | null;
  matchResults?: MatchResultRow[];
  unifiedTasks?: UnifiedTaskRow[];
  artifacts?: ArtifactRow[];
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
  embedModel?: string;
  modelAvailable?: boolean;
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

type ResumeSyncDesktopApi = {
  showResumeSyncFolderDialog?: () => Promise<string | null>;
  scanResumeSyncFolder?: (rootPath: string) => Promise<DesktopResumeSyncScan>;
  readResumeSyncFile?: (payload: { rootPath: string; relativePath: string }) => Promise<DesktopResumeFilePayload>;
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
      latestTailorTask: job.latestTailorTask ?? existing?.latestTailorTask,
      latestVerifierResult: job.latestVerifierResult ?? existing?.latestVerifierResult,
      matchResults: job.matchResults ?? existing?.matchResults,
      unifiedTasks: job.unifiedTasks ?? existing?.unifiedTasks,
      artifacts: job.artifacts ?? existing?.artifacts,
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

function formatPercent(value: number): string {
  return Math.round(value * 100) + "%";
}

function formatBytes(value: number): string {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
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
  const [queueLoading, setQueueLoading] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusResponse | null>(null);
  const [workerStatusLoading, setWorkerStatusLoading] = useState(false);

  const parsedUrlCount = useMemo(() => {
    return urlsText
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean).length;
  }, [urlsText]);

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
      const res = await fetch("/api/unified/tasks?status=queued&status=claimed&limit=20");
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { items: UnifiedTaskRow[] };
      setQueueItems(payload.items || []);
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

  const loadArtifactsForSnapshot = async (snapshotId: string): Promise<ArtifactRow[]> => {
    const res = await fetch("/api/tailored/" + snapshotId + "/artifacts");
    if (!res.ok) throw new Error(await readError(res));
    const payload = (await res.json()) as { items: ArtifactRow[] };
    return payload.items || [];
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
      setJobs((previous) => mergeJobs(previous, [{ ...payload, artifacts }]));
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to refresh job");
    } finally {
      setJobBusy(jobId, null);
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
  }, []);

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
      const res = await fetch("/api/jobs/intake/urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, batchId: crypto.randomUUID() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { items: JobRecord[] };
      setJobs((previous) => mergeJobs(previous, payload.items || []));
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
      const res = await fetch("/api/jobs/intake/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText, batchId: crypto.randomUUID() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { items: JobRecord[] };
      setJobs((previous) => mergeJobs(previous, payload.items || []));
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
      if (payload.job) {
        setJobs((previous) => mergeJobs(previous, [payload.job]));
      }
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to queue ranking");
    } finally {
      setJobBusy(jobId, null);
    }
  };

  const tailorJob = async (jobId: string, matchResultId: string) => {
    try {
      setJobBusy(jobId, "Queueing tailor task…");
      const res = await fetch("/api/jobs/" + jobId + "/tailor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchResultId, provider: "local_ollama" }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { job?: JobRecord; task?: TailorTaskRow };
      const nextJob = payload.job ? { ...payload.job, latestTailorTask: payload.task ?? payload.job.latestTailorTask } : ({ id: jobId, latestTailorTask: payload.task } as JobRecord);
      setJobs((previous) => mergeJobs(previous, [nextJob]));
      await refreshQueue();
      await refreshWorkerStatus();
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "Failed to queue tailoring");
    } finally {
      setJobBusy(jobId, null);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="container mx-auto max-w-7xl px-4 py-8 space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Unified Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            The desktop app now queues extraction, ranking, and local tailoring. The cards below show both the queue state and whether the private Python worker is actually connected, running, and using local model providers.
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
                  <div><strong>Chat model:</strong> {workerStatus.worker.ollama?.model || "—"}</div>
                  <div><strong>Embed model:</strong> {workerStatus.worker.ollama?.embedModel || "—"}</div>
                  <div><strong>Model ready:</strong> {workerStatus.worker.ollama?.modelAvailable ? "yes" : "no"}</div>
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
                {workerStatus.worker.lastError && <div className="text-destructive"><strong>Last error:</strong> {workerStatus.worker.lastError}</div>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Task Queue</CardTitle>
            <CardDescription>
              Operator controls for the queue-backed execution model. Use these if you want to force progress manually or inspect what the background worker still has pending.
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
            </div>
            {queueItems.length > 0 ? (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Job</TableHead>
                      <TableHead>Worker</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queueItems.map((task) => (
                      <TableRow key={task.id}>
                        <TableCell>{task.task_type}</TableCell>
                        <TableCell>{task.status}</TableCell>
                        <TableCell className="font-mono text-xs">{task.job_id || "—"}</TableCell>
                        <TableCell>{task.worker_id || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No queued or claimed tasks right now.</p>
            )}
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
              Submit one or many URLs, or upload a CSV with a required <code>URL</code> column. Intake now queues extraction work instead of processing everything in the same request.
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
                    Queue extraction
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
                    Queue extraction
                  </Button>
                </div>
              </section>
            </div>

            {intakeError && <p className="text-sm text-destructive">{intakeError}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Session Jobs</CardTitle>
            <CardDescription>
              Jobs created in this desktop session. Refresh after queue processing to see extraction, ranking, and local tailoring results.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs in this session yet.</p>
            ) : (
              <div className="space-y-4">
                {jobs.map((job) => {
                  const busyLabel = busyJobIds[job.id];
                  const matches = job.matchResults || [];
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
                            {job.work_model && <span>Work model: <strong>{job.work_model}</strong></span>}
                            {job.location && <span>Location: <strong>{job.location}</strong></span>}
                          </div>
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

                      {job.unifiedTasks && job.unifiedTasks.length > 0 && (
                        <div className="rounded-md border bg-muted/10 p-3 text-xs text-muted-foreground space-y-1">
                          <div className="font-medium text-foreground">Queued work for this job</div>
                          {job.unifiedTasks.map((task) => (
                            <div key={task.id}>{task.task_type} · {task.status}</div>
                          ))}
                        </div>
                      )}

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
                                  <Button type="button" size="sm" variant="outline" onClick={() => void tailorJob(job.id, match.id)} disabled={Boolean(busyLabel)}>
                                    {busyLabel === "Queueing tailor task…" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                                    Queue local tailor
                                  </Button>
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
                            <div className="space-y-1">
                              <div><strong>Artifacts</strong></div>
                              <ul className="space-y-1 text-xs font-mono text-muted-foreground">
                                {job.artifacts.map((artifact) => (
                                  <li key={artifact.id}>{artifact.artifact_kind}: {artifact.relative_path}</li>
                                ))}
                              </ul>
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
      </div>
    </div>
  );
}
