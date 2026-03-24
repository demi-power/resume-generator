import { rawDb } from "@/lib/db";
import { createId, nowIso, safeJsonParse } from "@/lib/unified/utils";

export type UnifiedTaskType = "job_extract" | "job_rank" | "tailor_local";
export type UnifiedTaskStatus = "queued" | "claimed" | "completed" | "failed";

export interface UnifiedTaskRow {
  id: string;
  task_type: UnifiedTaskType;
  status: UnifiedTaskStatus;
  priority: number;
  payload_json: string;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  max_attempts: number;
  requested_by: string | null;
  worker_id: string | null;
  job_id: string | null;
  tailor_task_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

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

function mapTask(row: Record<string, unknown> | undefined): UnifiedTaskRow | undefined {
  if (!row) return undefined;
  return row as unknown as UnifiedTaskRow;
}

export function getUnifiedTask(taskId: string): UnifiedTaskRow | undefined {
  return mapTask(rawDb.prepare("SELECT * FROM unified_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined);
}

export function listUnifiedTasks(filters: {
  statuses?: UnifiedTaskStatus[];
  jobId?: string | null;
  tailorTaskId?: string | null;
  limit?: number;
} = {}): UnifiedTaskRow[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
    values.push(...filters.statuses);
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
      "INSERT INTO unified_tasks (id, task_type, status, priority, payload_json, result_json, error_json, attempts, max_attempts, requested_by, worker_id, job_id, tailor_task_id, created_at, updated_at, started_at, completed_at) VALUES (?, ?, 'queued', ?, ?, NULL, NULL, 0, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)"
    )
    .run(
      taskId,
      params.taskType,
      params.priority ?? 100,
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

export function claimUnifiedTasks(params: {
  workerId: string;
  taskTypes?: UnifiedTaskType[];
  maxTasks?: number;
}): UnifiedTaskRow[] {
  const maxTasks = Math.max(1, params.maxTasks ?? 1);
  const typeFilter = params.taskTypes && params.taskTypes.length > 0
    ? ` AND task_type IN (${params.taskTypes.map(() => "?").join(", ")})`
    : "";
  const rows = rawDb
    .prepare(`SELECT * FROM unified_tasks WHERE status = 'queued'${typeFilter} ORDER BY priority ASC, created_at ASC LIMIT ${maxTasks}`)
    .all(...(params.taskTypes ?? [])) as Array<Record<string, unknown>>;
  const claimed: UnifiedTaskRow[] = [];
  for (const row of rows) {
    const taskId = String(row.id);
    const updated = rawDb
      .prepare(
        "UPDATE unified_tasks SET status = 'claimed', worker_id = ?, attempts = attempts + 1, updated_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'"
      )
      .run(params.workerId, nowIso(), nowIso(), taskId);
    if (updated.changes > 0) {
      claimed.push(getUnifiedTask(taskId)!);
    }
  }
  return claimed;
}

export function completeUnifiedTask(taskId: string, result: Record<string, unknown> = {}): UnifiedTaskRow {
  rawDb
    .prepare("UPDATE unified_tasks SET status = 'completed', result_json = ?, error_json = NULL, updated_at = ?, completed_at = ? WHERE id = ?")
    .run(JSON.stringify(result), nowIso(), nowIso(), taskId);
  return getUnifiedTask(taskId)!;
}

export function failUnifiedTask(taskId: string, error: Record<string, unknown>): UnifiedTaskRow {
  rawDb
    .prepare("UPDATE unified_tasks SET status = 'failed', error_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
    .run(JSON.stringify(error), nowIso(), nowIso(), taskId);
  return getUnifiedTask(taskId)!;
}

async function executeClaimedUnifiedTask(task: UnifiedTaskRow): Promise<Record<string, unknown>> {
  const payload = safeJsonParse(task.payload_json, {} as Record<string, unknown>);
  const store = await import("@/lib/unified/store");
  switch (task.task_type) {
    case "job_extract":
      if (!task.job_id) throw new Error("job_extract task missing job_id");
      return await store.ensureJobExtracted(task.job_id);
    case "job_rank":
      if (!task.job_id) throw new Error("job_rank task missing job_id");
      return await store.runRankingForJob(task.job_id);
    case "tailor_local":
      if (!task.tailor_task_id) throw new Error("tailor_local task missing tailor_task_id");
      return await store.runLocalTailorTask(task.tailor_task_id, payload);
    default:
      throw new Error(`Unsupported unified task type: ${task.task_type}`);
  }
}

export async function processNextUnifiedTask(params: {
  workerId?: string;
  taskTypes?: UnifiedTaskType[];
} = {}): Promise<{ task: UnifiedTaskRow; result: Record<string, unknown> } | null> {
  const claimed = claimUnifiedTasks({ workerId: params.workerId ?? "inline-runner", taskTypes: params.taskTypes, maxTasks: 1 });
  if (claimed.length === 0) return null;
  const task = claimed[0];
  try {
    const result = await executeClaimedUnifiedTask(task);
    return { task: completeUnifiedTask(task.id, result), result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failUnifiedTask(task.id, { message });
    throw error;
  }
}
