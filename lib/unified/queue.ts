import { rawDb } from "@/lib/db";
import { createId, nowIso, safeJsonParse } from "@/lib/unified/utils";

export type UnifiedTaskType = "job_fetch" | "job_extract" | "job_rank" | "tailor_generate" | "tailor_verify";
export type UnifiedTaskStatus = "queued" | "claimed" | "completed" | "failed";
export type UnifiedResourceClass = "fetch" | "rank" | "gpu_llm";

export interface UnifiedTaskRow {
  id: string;
  task_type: UnifiedTaskType;
  status: UnifiedTaskStatus;
  priority: number;
  resource_class: UnifiedResourceClass;
  payload_json: string;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  max_attempts: number;
  requested_by: string | null;
  worker_id: string | null;
  job_id: string | null;
  tailor_task_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const DEFAULT_LEASE_MS = Math.max(30_000, Number.parseInt(process.env.UNIFIED_TASK_LEASE_MS || "600000", 10) || 600_000);

rawDb.exec(`
CREATE TABLE IF NOT EXISTS unified_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  requested_by TEXT,
  worker_id TEXT,
  job_id TEXT,
  tailor_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_status_priority ON unified_tasks(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_job_id ON unified_tasks(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_tailor_task_id ON unified_tasks(tailor_task_id, created_at);
`);

function ensureTaskColumn(name: string, sqlType: string, defaultClause: string): void {
  const columns = rawDb.prepare("PRAGMA table_info(unified_tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    rawDb.exec(`ALTER TABLE unified_tasks ADD COLUMN ${name} ${sqlType} ${defaultClause}`.trim());
  }
}

ensureTaskColumn("resource_class", "TEXT", "NOT NULL DEFAULT 'gpu_llm'");
ensureTaskColumn("lease_expires_at", "TEXT", "");
ensureTaskColumn("heartbeat_at", "TEXT", "");
rawDb.exec(`
CREATE INDEX IF NOT EXISTS idx_unified_tasks_status_resource_priority ON unified_tasks(status, resource_class, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_unified_tasks_lease_expires ON unified_tasks(status, lease_expires_at);
`);

function mapTask(row: Record<string, unknown> | undefined): UnifiedTaskRow | undefined {
  if (!row) return undefined;
  return row as unknown as UnifiedTaskRow;
}

function isoAfterMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function resourceClassForTaskType(taskType: UnifiedTaskType): UnifiedResourceClass {
  switch (taskType) {
    case "job_fetch":
      return "fetch";
    case "job_rank":
      return "rank";
    case "job_extract":
    case "tailor_generate":
    case "tailor_verify":
    default:
      return "gpu_llm";
  }
}

export function getUnifiedTask(taskId: string): UnifiedTaskRow | undefined {
  return mapTask(rawDb.prepare("SELECT * FROM unified_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined);
}

export function listUnifiedTasks(filters: {
  statuses?: UnifiedTaskStatus[];
  jobId?: string | null;
  tailorTaskId?: string | null;
  taskTypes?: UnifiedTaskType[];
  limit?: number;
} = {}): UnifiedTaskRow[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
    values.push(...filters.statuses);
  }
  if (filters.taskTypes && filters.taskTypes.length > 0) {
    clauses.push(`task_type IN (${filters.taskTypes.map(() => "?").join(", ")})`);
    values.push(...filters.taskTypes);
  }
  if (filters.jobId) {
    clauses.push("job_id = ?");
    values.push(filters.jobId);
  }
  if (filters.tailorTaskId) {
    clauses.push("tailor_task_id = ?");
    values.push(filters.tailorTaskId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Number.isFinite(filters.limit) ? ` LIMIT ${Math.max(1, Number(filters.limit))}` : "";
  return rawDb
    .prepare(`SELECT * FROM unified_tasks ${where} ORDER BY created_at DESC${limit}`)
    .all(...values)
    .map((row) => mapTask(row as Record<string, unknown>)!) as UnifiedTaskRow[];
}

export function enqueueUnifiedTask(params: {
  taskType: UnifiedTaskType;
  priority?: number;
  requestedBy?: string | null;
  jobId?: string | null;
  tailorTaskId?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  resourceClass?: UnifiedResourceClass;
}): UnifiedTaskRow {
  const existing = rawDb
    .prepare(
      "SELECT * FROM unified_tasks WHERE task_type = ? AND status IN ('queued', 'claimed') AND COALESCE(job_id, '') = COALESCE(?, '') AND COALESCE(tailor_task_id, '') = COALESCE(?, '') ORDER BY created_at DESC LIMIT 1"
    )
    .get(params.taskType, params.jobId ?? null, params.tailorTaskId ?? null) as Record<string, unknown> | undefined;
  if (existing) return mapTask(existing)!;

  const taskId = createId();
  const now = nowIso();
  rawDb
    .prepare(
      "INSERT INTO unified_tasks (id, task_type, status, priority, resource_class, payload_json, result_json, error_json, attempts, max_attempts, requested_by, worker_id, job_id, tailor_task_id, lease_expires_at, heartbeat_at, created_at, updated_at, started_at, completed_at) VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, 0, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL, NULL)"
    )
    .run(
      taskId,
      params.taskType,
      params.priority ?? 100,
      params.resourceClass ?? resourceClassForTaskType(params.taskType),
      JSON.stringify(params.payload ?? {}),
      params.maxAttempts ?? 3,
      params.requestedBy ?? null,
      params.jobId ?? null,
      params.tailorTaskId ?? null,
      now,
      now
    );
  return getUnifiedTask(taskId)!;
}

export function recoverExpiredUnifiedTasks(taskTypes?: UnifiedTaskType[]): number {
  const now = nowIso();
  const staleCutoff = new Date(Date.now() - DEFAULT_LEASE_MS).toISOString();
  const typeFilter = taskTypes && taskTypes.length > 0 ? ` AND task_type IN (${taskTypes.map(() => "?").join(", ")})` : "";
  const result = rawDb
    .prepare(
      `UPDATE unified_tasks
         SET status = 'queued', worker_id = NULL, updated_at = ?, started_at = NULL, heartbeat_at = NULL, lease_expires_at = NULL
       WHERE status = 'claimed'
         AND (
           (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           OR (lease_expires_at IS NULL AND COALESCE(heartbeat_at, '') = '' AND updated_at <= ?)
         )${typeFilter}`
    )
    .run(now, now, staleCutoff, ...(taskTypes ?? []));
  return result.changes;
}

export function claimUnifiedTasks(params: {
  workerId: string;
  taskTypes?: UnifiedTaskType[];
  maxTasks?: number;
  leaseMs?: number;
}): UnifiedTaskRow[] {
  const maxTasks = Math.max(1, params.maxTasks ?? 1);
  const leaseMs = Math.max(30_000, params.leaseMs ?? DEFAULT_LEASE_MS);
  recoverExpiredUnifiedTasks(params.taskTypes);
  const typeFilter = params.taskTypes && params.taskTypes.length > 0
    ? ` AND task_type IN (${params.taskTypes.map(() => "?").join(", ")})`
    : "";
  const rows = rawDb
    .prepare(`SELECT * FROM unified_tasks WHERE status = 'queued'${typeFilter} ORDER BY priority ASC, created_at ASC LIMIT ${maxTasks}`)
    .all(...(params.taskTypes ?? [])) as Array<Record<string, unknown>>;
  const claimed: UnifiedTaskRow[] = [];
  for (const row of rows) {
    const taskId = String(row.id);
    const now = nowIso();
    const updated = rawDb
      .prepare(
        "UPDATE unified_tasks SET status = 'claimed', worker_id = ?, attempts = attempts + 1, updated_at = ?, started_at = COALESCE(started_at, ?), heartbeat_at = ?, lease_expires_at = ?, result_json = NULL, error_json = NULL WHERE id = ? AND status = 'queued'"
      )
      .run(params.workerId, now, now, now, isoAfterMs(leaseMs), taskId);
    if (updated.changes > 0) {
      claimed.push(getUnifiedTask(taskId)!);
    }
  }
  return claimed;
}

export function heartbeatUnifiedTask(taskId: string, workerId?: string | null, leaseMs?: number): UnifiedTaskRow | undefined {
  const now = nowIso();
  const result = workerId
    ? rawDb.prepare("UPDATE unified_tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND worker_id = ?").run(now, isoAfterMs(Math.max(30_000, leaseMs ?? DEFAULT_LEASE_MS)), now, taskId, workerId)
    : rawDb.prepare("UPDATE unified_tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed'").run(now, isoAfterMs(Math.max(30_000, leaseMs ?? DEFAULT_LEASE_MS)), now, taskId);
  if (result.changes <= 0) return undefined;
  return getUnifiedTask(taskId);
}

export function completeUnifiedTask(taskId: string, result: Record<string, unknown> = {}): UnifiedTaskRow {
  rawDb
    .prepare("UPDATE unified_tasks SET status = 'completed', result_json = ?, error_json = NULL, updated_at = ?, completed_at = ?, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ?")
    .run(JSON.stringify(result), nowIso(), nowIso(), taskId);
  return getUnifiedTask(taskId)!;
}

export function failUnifiedTask(taskId: string, error: Record<string, unknown>): UnifiedTaskRow {
  rawDb
    .prepare("UPDATE unified_tasks SET status = 'failed', error_json = ?, updated_at = ?, completed_at = ?, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ?")
    .run(JSON.stringify(error), nowIso(), nowIso(), taskId);
  return getUnifiedTask(taskId)!;
}

async function executeClaimedUnifiedTask(task: UnifiedTaskRow, extraPayload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const payload = {
    ...safeJsonParse(task.payload_json, {} as Record<string, unknown>),
    ...extraPayload,
  };
  const store = await import("@/lib/unified/store");
  switch (task.task_type) {
    case "job_fetch":
      if (!task.job_id) throw new Error("job_fetch task missing job_id");
      return await store.runJobFetchTask(task.job_id, { requestedBy: task.requested_by ?? null, autoQueueNext: true });
    case "job_extract":
      if (!task.job_id) throw new Error("job_extract task missing job_id");
      return await store.runJobExtractTask(task.job_id, { requestedBy: task.requested_by ?? null, autoQueueNext: true });
    case "job_rank":
      if (!task.job_id) throw new Error("job_rank task missing job_id");
      return await store.runRankingForJob(task.job_id, { autoEnsureExtracted: false, autoChain: true, requestedBy: task.requested_by ?? null });
    case "tailor_generate":
      if (!task.tailor_task_id) throw new Error("tailor_generate task missing tailor_task_id");
      return await store.runLocalTailorGenerationTask(task.tailor_task_id, { ...payload, requestedBy: task.requested_by ?? null });
    case "tailor_verify":
      if (!task.tailor_task_id) throw new Error("tailor_verify task missing tailor_task_id");
      return await store.runTailorVerifyTask(task.tailor_task_id, { ...payload, requestedBy: task.requested_by ?? null });
    default:
      throw new Error(`Unsupported unified task type: ${task.task_type}`);
  }
}

export async function processNextUnifiedTask(params: {
  workerId?: string;
  taskTypes?: UnifiedTaskType[];
  leaseMs?: number;
  payload?: Record<string, unknown>;
} = {}): Promise<{ task: UnifiedTaskRow; result: Record<string, unknown> } | null> {
  const claimed = claimUnifiedTasks({
    workerId: params.workerId ?? "inline-runner",
    taskTypes: params.taskTypes,
    maxTasks: 1,
    leaseMs: params.leaseMs,
  });
  if (claimed.length === 0) return null;
  const task = claimed[0];
  try {
    const result = await executeClaimedUnifiedTask(task, params.payload);
    return { task: completeUnifiedTask(task.id, result), result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failUnifiedTask(task.id, { message });
    throw error;
  }
}
