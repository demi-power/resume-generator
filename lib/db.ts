import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { ResumeData } from "./resume-store";
import { normalizeCompanyForDuplicateKey } from "./normalize-company";
import { canonicalizeJobUrl } from "./unified/utils";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "app.db");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

ensureDataDir();

const db = new Database(DB_PATH);
export const rawDb = db;
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_applications (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  job_url TEXT,
  unified_job_id TEXT,
  profile_id TEXT,
  resume_file_name TEXT NOT NULL,
  job_description TEXT NOT NULL,
  applied_manually INTEGER NOT NULL DEFAULT 0,
  gpt_chat_url TEXT,
  last_resume_download_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_links (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  checked INTEGER NOT NULL,
  check_result TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  assigned_profile_id TEXT,
  start_date TEXT,
  created_at TEXT NOT NULL
);
`);
  // Migration: add last_seen_at for online status (ignore if already present)
  try {
    const info = db.prepare<unknown[], { name: string }>("SELECT name FROM pragma_table_info('users') WHERE name = 'last_seen_at'").get();
    if (!info) {
      db.exec("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
    }
  } catch (_) {}
  // Migration: add active (1 = active, 0 = inactive)
  try {
    const info = db.prepare<unknown[], { name: string }>("SELECT name FROM pragma_table_info('users') WHERE name = 'active'").get();
    if (!info) {
      db.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    }
  } catch (_) {}

  // Migration: add last_resume_download_at for tracking resume download time
  try {
    const info = db
      .prepare<unknown[], { name: string }>(
        "SELECT name FROM pragma_table_info('job_applications') WHERE name = 'last_resume_download_at'"
      )
      .get();
    if (!info) {
      db.exec("ALTER TABLE job_applications ADD COLUMN last_resume_download_at TEXT");
    }
  } catch (_) {}
  // Migration: link legacy job_applications rows to unified pipeline jobs
  try {
    const info = db
      .prepare<unknown[], { name: string }>(
        "SELECT name FROM pragma_table_info('job_applications') WHERE name = 'unified_job_id'"
      )
      .get();
    if (!info) {
      db.exec("ALTER TABLE job_applications ADD COLUMN unified_job_id TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_job_applications_unified_job_id ON job_applications(unified_job_id)");
  } catch (_) {}

function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// --- Settings (single-user, key/value) ---

export interface Settings {
  activeProfileId: string | null;
}

export function getActiveProfileId(): string | null {
  const row = db
    .prepare<unknown[], { value: string }>("SELECT value FROM settings WHERE key = 'activeProfileId'")
    .get();
  return row ? (row.value || null) : null;
}

export function setActiveProfileId(activeProfileId: string | null): void {
  const value = activeProfileId ?? "";
  db.prepare("INSERT INTO settings (key, value) VALUES ('activeProfileId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
}

// --- DeepSeek session cookies (shared; full Electron cookie objects) ---

const DEEPSEEK_COOKIES_KEY = "deepseek_cookies";
const CHATGPT_COOKIES_KEY = "chatgpt_cookies";

/** Full cookie object as returned by Electron session.cookies.get(). */
export type DeepSeekCookie = Record<string, unknown>;
export type ChatGptCookie = Record<string, unknown>;

export function getDeepSeekCookies(): DeepSeekCookie[] {
  const row = db
    .prepare<unknown[], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(DEEPSEEK_COOKIES_KEY);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setDeepSeekCookies(cookies: DeepSeekCookie[]): void {
  const value = JSON.stringify(Array.isArray(cookies) ? cookies : []);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DEEPSEEK_COOKIES_KEY, value);
}

export function getChatGptCookies(): ChatGptCookie[] {
  const row = db
    .prepare<unknown[], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(CHATGPT_COOKIES_KEY);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setChatGptCookies(cookies: ChatGptCookie[]): void {
  const value = JSON.stringify(Array.isArray(cookies) ? cookies : []);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(CHATGPT_COOKIES_KEY, value);
}

// --- Profiles ---

export interface ProfileRow {
  id: string;
  name: string;
  data: string;
  created_at: string;
  updated_at: string;
}

/** Returns profiles in stored order (sort_order). */
export function listProfiles(): ProfileRow[] {
  const rows = db
    .prepare<unknown[], { id: string; name: string; data_json: string; created_at: string; updated_at: string }>(
      "SELECT id, name, data_json, created_at, updated_at FROM profiles ORDER BY sort_order ASC"
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    data: r.data_json,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export function getProfile(id: string): ProfileRow | undefined {
  const row = db
    .prepare<unknown[], { id: string; name: string; data_json: string; created_at: string; updated_at: string }>(
      "SELECT id, name, data_json, created_at, updated_at FROM profiles WHERE id = ?"
    )
    .get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    data: row.data_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createProfile(name: string, data: ResumeData): ProfileRow {
  const now = new Date().toISOString();
  const id = genId();
  const maxOrderRow = db.prepare("SELECT MAX(sort_order) as maxOrder FROM profiles").get() as { maxOrder: number | null } | undefined;
  const maxOrder = maxOrderRow?.maxOrder ?? -1;
  const sortOrder = maxOrder + 1;
  db.prepare("INSERT INTO profiles (id, name, data_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    name.trim() || "Untitled",
    JSON.stringify(data),
    sortOrder,
    now,
    now
  );
  return {
    id,
    name: name.trim() || "Untitled",
    data: JSON.stringify(data),
    created_at: now,
    updated_at: now,
  };
}

export function updateProfile(
  id: string,
  updates: { name?: string; data?: ResumeData }
): void {
  const existing = db.prepare("SELECT id, name, data_json, created_at, updated_at FROM profiles WHERE id = ?").get(id) as
    | { id: string; name: string; data_json: string; created_at: string; updated_at: string }
    | undefined;
  if (!existing) throw new Error("Profile not found");
  const name = updates.name !== undefined ? updates.name.trim() : existing.name;
  const dataJson = updates.data !== undefined ? JSON.stringify(updates.data) : existing.data_json;
  const updatedAt = new Date().toISOString();
  db.prepare("UPDATE profiles SET name = ?, data_json = ?, updated_at = ? WHERE id = ?").run(
    name,
    dataJson,
    updatedAt,
    id
  );
}

export function deleteProfile(id: string): void {
  db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
}

/** Reorder profiles by the given id order. Ids not in the list keep current order at end. */
export function reorderProfiles(orderedIds: string[]): void {
  const existing = db
    .prepare<unknown[], { id: string; sort_order: number }>("SELECT id, sort_order FROM profiles")
    .all();
  const byId = new Map(existing.map((p) => [p.id, p]));
  const ordered: { id: string; sort_order: number }[] = [];
  let sortOrder = 0;
  for (const id of orderedIds) {
    const p = byId.get(id);
    if (p) {
      ordered.push({ id: p.id, sort_order: sortOrder++ });
      byId.delete(id);
    }
  }
  for (const p of existing) {
    if (byId.has(p.id)) {
      ordered.push({ id: p.id, sort_order: sortOrder++ });
    }
  }
  const stmt = db.prepare("UPDATE profiles SET sort_order = ? WHERE id = ?");
  const tx = db.transaction((rows: { id: string; sort_order: number }[]) => {
    for (const row of rows) {
      stmt.run(row.sort_order, row.id);
    }
  });
  tx(ordered);
}

// --- Job applications ---

export interface JobApplicationRow {
  id: string;
  date: string;
  company_name: string;
  title: string;
  job_url: string | null;
  unified_job_id: string | null;
  profile_id: string | null;
  resume_file_name: string;
  job_description: string;
  /** 0 = not applied, 1 = applied */
  applied_manually: number;
  gpt_chat_url: string | null;
  last_resume_download_at: string | null;
  created_at: string;
}

function slug(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80) || "untitled";
}

/** Returns job applications in storage order. If profileId is provided, only rows for that profile. */
export function listJobApplications(profileId?: string | null): JobApplicationRow[] {
  const cols =
    "id, date, company_name, title, job_url, unified_job_id, profile_id, resume_file_name, job_description, applied_manually, gpt_chat_url, last_resume_download_at, created_at";
  const order = " ORDER BY rowid ASC";
  if (profileId != null && String(profileId).trim() !== "") {
    const rows = db
      .prepare<
        [string],
        {
          id: string;
          date: string;
          company_name: string;
          title: string;
          job_url: string | null;
          unified_job_id: string | null;
          profile_id: string | null;
          resume_file_name: string;
          job_description: string;
          applied_manually: number;
          gpt_chat_url: string | null;
          last_resume_download_at: string | null;
          created_at: string;
        }
      >(`SELECT ${cols} FROM job_applications WHERE profile_id = ?${order}`)
      .all(profileId.trim());
    return rows;
  }
  const rows = db
    .prepare<
      unknown[],
      {
        id: string;
        date: string;
        company_name: string;
        title: string;
        job_url: string | null;
        unified_job_id: string | null;
        profile_id: string | null;
        resume_file_name: string;
        job_description: string;
        applied_manually: number;
        gpt_chat_url: string | null;
        last_resume_download_at: string | null;
        created_at: string;
      }
    >(`SELECT ${cols} FROM job_applications${order}`)
    .all();
  return rows;
}

/** Keys (profile_id::normalized_company) that appear more than once in job_applications. Used to highlight duplicate rows. */
export function getDuplicateJobApplicationKeys(): string[] {
  const rows = db
    .prepare<
      unknown[],
      { profile_id: string; company_name: string }
    >(
      `SELECT profile_id, company_name
       FROM job_applications
       WHERE profile_id IS NOT NULL AND profile_id != '' AND TRIM(company_name) != ''`
    )
    .all();
  const countByKey = new Map<string, number>();
  for (const r of rows) {
    const norm = normalizeCompanyForDuplicateKey(r.company_name);
    if (!norm) continue;
    const key = `${r.profile_id}::${norm}`;
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
  }
  return Array.from(countByKey.entries())
    .filter(([, n]) => n > 1)
    .map(([k]) => k);
}

export function getJobApplication(id: string): JobApplicationRow | undefined {
  const row = db
    .prepare<
      unknown[],
      {
        id: string;
        date: string;
        company_name: string;
        title: string;
        job_url: string | null;
        unified_job_id: string | null;
        profile_id: string | null;
        resume_file_name: string;
        job_description: string;
        applied_manually: number;
        gpt_chat_url: string | null;
        last_resume_download_at: string | null;
        created_at: string;
      }
    >(
      "SELECT id, date, company_name, title, job_url, unified_job_id, profile_id, resume_file_name, job_description, applied_manually, gpt_chat_url, last_resume_download_at, created_at FROM job_applications WHERE id = ?"
    )
    .get(id);
  return row ?? undefined;
}

export function getJobApplicationByUnifiedJobId(unifiedJobId: string): JobApplicationRow | undefined {
  const trimmed = unifiedJobId.trim();
  if (!trimmed) return undefined;
  const row = db
    .prepare<
      [string],
      {
        id: string;
        date: string;
        company_name: string;
        title: string;
        job_url: string | null;
        unified_job_id: string | null;
        profile_id: string | null;
        resume_file_name: string;
        job_description: string;
        applied_manually: number;
        gpt_chat_url: string | null;
        last_resume_download_at: string | null;
        created_at: string;
      }
    >(
      "SELECT id, date, company_name, title, job_url, unified_job_id, profile_id, resume_file_name, job_description, applied_manually, gpt_chat_url, last_resume_download_at, created_at FROM job_applications WHERE unified_job_id = ? ORDER BY rowid ASC LIMIT 1"
    )
    .get(trimmed);
  return row ?? undefined;
}

export function findJobApplicationByCanonicalJobUrl(jobUrl: string): JobApplicationRow | undefined {
  const canonical = canonicalizeJobUrl(jobUrl)?.canonicalUrl;
  if (!canonical) return undefined;
  const rows = listJobApplications();
  return rows.find((row) => {
    if (!row.job_url) return false;
    return canonicalizeJobUrl(row.job_url)?.canonicalUrl === canonical;
  });
}

export function createJobApplication(params: {
  date: string;
  company_name: string;
  title: string;
  job_url?: string | null;
  unified_job_id?: string | null;
  profile_id?: string | null;
  resume_file_name?: string | null;
  job_description?: string | null;
  applied_manually?: number | boolean;
  gpt_chat_url?: string | null;
}): JobApplicationRow {
  let resume_file_name: string;
  if (params.resume_file_name !== undefined && params.resume_file_name !== null) {
    resume_file_name = String(params.resume_file_name).trim();
  } else {
    const profileName =
      params.profile_id != null ? getProfile(params.profile_id)?.name ?? "default" : "default";
    resume_file_name = `${slug(profileName)}_${slug(params.company_name)}_${slug(params.title)}_${params.date}.pdf`;
  }
  const now = new Date().toISOString();
  const id = genId();
  const appliedValue =
    typeof params.applied_manually === "boolean"
      ? params.applied_manually
        ? 1
        : 0
      : typeof params.applied_manually === "number"
      ? params.applied_manually
      : 0;
  const row: JobApplicationRow = {
    id,
    date:
      params.date !== undefined && params.date !== null
        ? String(params.date).trim()
        : now.slice(0, 10),
    company_name: params.company_name.trim(),
    title: params.title.trim(),
    job_url: params.job_url?.trim() || null,
    unified_job_id: params.unified_job_id?.trim() || null,
    profile_id: params.profile_id ?? null,
    resume_file_name,
    job_description: typeof params.job_description === "string" ? params.job_description : "",
    applied_manually: appliedValue,
    gpt_chat_url: params.gpt_chat_url ?? null,
    last_resume_download_at: null,
    created_at: now,
  };
  db.prepare(
    "INSERT INTO job_applications (id, date, company_name, title, job_url, unified_job_id, profile_id, resume_file_name, job_description, applied_manually, gpt_chat_url, last_resume_download_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    row.id,
    row.date,
    row.company_name,
    row.title,
    row.job_url,
    row.unified_job_id,
    row.profile_id,
    row.resume_file_name,
    row.job_description,
    row.applied_manually,
    row.gpt_chat_url,
    row.last_resume_download_at,
    row.created_at
  );
  return row;
}

export function updateJobApplication(
  id: string,
  updates: {
    date?: string;
    company_name?: string;
    title?: string;
    job_url?: string | null;
    unified_job_id?: string | null;
    profile_id?: string | null;
    resume_file_name?: string | null;
    job_description?: string | null;
    applied_manually?: number | boolean;
    gpt_chat_url?: string | null;
    last_resume_download_at?: string | null;
  }
): void {
  const existing = getJobApplication(id);
  if (!existing) throw new Error("Job application not found");
  const next: JobApplicationRow = {
    ...existing,
    date: updates.date !== undefined ? updates.date : existing.date,
    company_name: updates.company_name !== undefined ? updates.company_name.trim() : existing.company_name,
    title: updates.title !== undefined ? updates.title.trim() : existing.title,
    job_url: updates.job_url !== undefined ? updates.job_url?.trim() || null : existing.job_url,
    unified_job_id: updates.unified_job_id !== undefined ? updates.unified_job_id?.trim() || null : existing.unified_job_id,
    profile_id: updates.profile_id !== undefined ? updates.profile_id : existing.profile_id,
    resume_file_name:
      updates.resume_file_name !== undefined
        ? updates.resume_file_name != null
          ? String(updates.resume_file_name).trim()
          : ""
        : existing.resume_file_name,
    job_description:
      updates.job_description !== undefined
        ? typeof updates.job_description === "string"
          ? updates.job_description
          : ""
        : existing.job_description,
    applied_manually:
      updates.applied_manually !== undefined
        ? typeof updates.applied_manually === "boolean"
          ? updates.applied_manually
            ? 1
            : 0
          : updates.applied_manually
        : existing.applied_manually,
    gpt_chat_url:
      updates.gpt_chat_url !== undefined
        ? updates.gpt_chat_url != null
          ? updates.gpt_chat_url
          : null
        : existing.gpt_chat_url,
    last_resume_download_at:
      updates.last_resume_download_at !== undefined
        ? updates.last_resume_download_at
        : existing.last_resume_download_at ?? null,
  };
  db.prepare(
    "UPDATE job_applications SET date = ?, company_name = ?, title = ?, job_url = ?, unified_job_id = ?, profile_id = ?, resume_file_name = ?, job_description = ?, applied_manually = ?, gpt_chat_url = ?, last_resume_download_at = ? WHERE id = ?"
  ).run(
    next.date,
    next.company_name,
    next.title,
    next.job_url,
    next.unified_job_id,
    next.profile_id,
    next.resume_file_name,
    next.job_description,
    next.applied_manually,
    next.gpt_chat_url,
    next.last_resume_download_at,
    id
  );
}

export function upsertJobApplicationForUnifiedJob(params: {
  unified_job_id: string;
  date?: string;
  company_name?: string;
  title?: string;
  job_url?: string | null;
  profile_id?: string | null;
  resume_file_name?: string | null;
  job_description?: string | null;
}): JobApplicationRow {
  const unifiedJobId = params.unified_job_id.trim();
  if (!unifiedJobId) throw new Error("unified_job_id is required");

  const existing =
    getJobApplicationByUnifiedJobId(unifiedJobId) ??
    (params.job_url ? findJobApplicationByCanonicalJobUrl(params.job_url) : undefined);

  if (!existing) {
    return createJobApplication({
      date: params.date ?? new Date().toISOString().slice(0, 10),
      company_name: params.company_name ?? "",
      title: params.title ?? "",
      job_url: params.job_url ?? null,
      unified_job_id: unifiedJobId,
      profile_id: params.profile_id ?? null,
      resume_file_name: params.resume_file_name ?? "",
      job_description: params.job_description ?? "",
      applied_manually: 0,
      gpt_chat_url: null,
    });
  }

  const updates: Parameters<typeof updateJobApplication>[1] = {
    unified_job_id: unifiedJobId,
  };
  if (!existing.date.trim() && params.date?.trim()) updates.date = params.date.trim();
  if (!existing.company_name.trim() && params.company_name?.trim()) updates.company_name = params.company_name.trim();
  if (!existing.title.trim() && params.title?.trim()) updates.title = params.title.trim();
  if (!existing.job_url?.trim() && params.job_url?.trim()) updates.job_url = params.job_url.trim();
  if (!existing.profile_id && params.profile_id) updates.profile_id = params.profile_id;
  if (!existing.resume_file_name.trim() && params.resume_file_name !== undefined) updates.resume_file_name = params.resume_file_name;
  if (!existing.job_description.trim() && params.job_description?.trim()) updates.job_description = params.job_description;
  updateJobApplication(existing.id, updates);
  return getJobApplication(existing.id)!;
}

export function syncJobApplicationForUnifiedJob(
  unifiedJobId: string,
  updates: {
    company_name?: string;
    title?: string;
    job_url?: string | null;
    job_description?: string | null;
    resume_file_name?: string | null;
  }
): JobApplicationRow | undefined {
  const existing = getJobApplicationByUnifiedJobId(unifiedJobId);
  if (!existing) return undefined;

  const next: Parameters<typeof updateJobApplication>[1] = {
    unified_job_id: unifiedJobId,
  };
  if (!existing.company_name.trim() && updates.company_name?.trim()) next.company_name = updates.company_name.trim();
  if (!existing.title.trim() && updates.title?.trim()) next.title = updates.title.trim();
  if (!existing.job_url?.trim() && updates.job_url?.trim()) next.job_url = updates.job_url.trim();
  if (!existing.job_description.trim() && updates.job_description?.trim()) next.job_description = updates.job_description;
  if (!existing.resume_file_name.trim() && updates.resume_file_name !== undefined) next.resume_file_name = updates.resume_file_name;
  updateJobApplication(existing.id, next);
  return getJobApplication(existing.id)!;
}

export function deleteJobApplication(id: string): void {
  db.prepare("DELETE FROM job_applications WHERE id = ?").run(id);
}

// --- Job links ---

export interface JobLinkRow {
  id: string;
  url: string;
  title: string;
  date: string;
  checked: boolean;
  check_result: string | null;
  created_at: string;
}

export function listJobLinks(): JobLinkRow[] {
  const rows = db
    .prepare<
      unknown[],
      {
        id: string;
        url: string;
        title: string;
        date: string;
        checked: number;
        check_result: string | null;
        created_at: string;
      }
    >("SELECT id, url, title, date, checked, check_result, created_at FROM job_links ORDER BY date DESC, created_at DESC")
    .all();
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    date: r.date,
    checked: Boolean(r.checked),
    check_result: r.check_result,
    created_at: r.created_at,
  }));
}

export function getJobLink(id: string): JobLinkRow | undefined {
  const row = db
    .prepare<
      unknown[],
      {
        id: string;
        url: string;
        title: string;
        date: string;
        checked: number;
        check_result: string | null;
        created_at: string;
      }
    >("SELECT id, url, title, date, checked, check_result, created_at FROM job_links WHERE id = ?")
    .get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    date: row.date,
    checked: Boolean(row.checked),
    check_result: row.check_result,
    created_at: row.created_at,
  };
}

export function createJobLink(params: { url: string; title?: string; date?: string }): JobLinkRow {
  const date =
    params.date !== undefined && params.date !== null
      ? String(params.date).trim()
      : new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const id = genId();
  const row: JobLinkRow = {
    id,
    url: params.url.trim(),
    title: typeof params.title === "string" ? params.title.trim() : "",
    date,
    checked: false,
    check_result: null,
    created_at: now,
  };
  db.prepare(
    "INSERT INTO job_links (id, url, title, date, checked, check_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.url, row.title, row.date, row.checked ? 1 : 0, row.check_result, row.created_at);
  return row;
}

export function updateJobLink(
  id: string,
  updates: {
    url?: string;
    title?: string;
    date?: string;
    checked?: boolean;
    checkResult?: string | null;
  }
): void {
  const existing = getJobLink(id);
  if (!existing) throw new Error("Job link not found");
  const next: JobLinkRow = {
    ...existing,
    url: updates.url !== undefined ? updates.url.trim() : existing.url,
    title: updates.title !== undefined ? updates.title.trim() : existing.title,
    date: updates.date !== undefined ? updates.date.trim() : existing.date,
    checked: updates.checked !== undefined ? updates.checked : existing.checked,
    check_result: updates.checkResult !== undefined ? updates.checkResult : existing.check_result,
  };
  db.prepare("UPDATE job_links SET url = ?, title = ?, date = ?, checked = ?, check_result = ? WHERE id = ?").run(
    next.url,
    next.title,
    next.date,
    next.checked ? 1 : 0,
    next.check_result,
    id
  );
}

export function deleteJobLink(id: string): void {
  db.prepare("DELETE FROM job_links WHERE id = ?").run(id);
}

// --- Users (auth + RBAC) ---

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  assigned_profile_id: string | null;
  start_date: string | null;
  created_at: string;
  last_seen_at?: string | null;
  active?: number; // 1 = active, 0 = inactive
}

export function hasAnyUser(): boolean {
  const row = db.prepare<unknown[], { c: number }>("SELECT COUNT(*) AS c FROM users").get();
  return row ? (row as { c: number }).c > 0 : false;
}

export function getUserByUsername(username: string): UserRow | undefined {
  const row = db
    .prepare<
      unknown[],
      {
        id: string;
        username: string;
        password_hash: string;
        role: string;
        assigned_profile_id: string | null;
        start_date: string | null;
        created_at: string;
      }
    >(
      "SELECT id, username, password_hash, role, assigned_profile_id, start_date, created_at, last_seen_at, COALESCE(active, 1) AS active FROM users WHERE username = ?"
    )
    .get(username.trim().toLowerCase());
  if (!row) return undefined;
  return {
    ...row,
    role: row.role as UserRole,
  };
}

export function getUserById(id: string): UserRow | undefined {
  const row = db
    .prepare<
      unknown[],
      {
        id: string;
        username: string;
        password_hash: string;
        role: string;
        assigned_profile_id: string | null;
        start_date: string | null;
        created_at: string;
      }
    >(
      "SELECT id, username, password_hash, role, assigned_profile_id, start_date, created_at, last_seen_at, COALESCE(active, 1) AS active FROM users WHERE id = ?"
    )
    .get(id);
  if (!row) return undefined;
  return {
    ...row,
    role: row.role as UserRole,
  };
}

export function listUsers(): (UserRow & { application_count: number })[] {
  const rows = db
    .prepare<
      unknown[],
      {
        id: string;
        username: string;
        password_hash: string;
        role: string;
        assigned_profile_id: string | null;
        start_date: string | null;
        created_at: string;
        last_seen_at: string | null;
        active: number;
      }
    >("SELECT id, username, password_hash, role, assigned_profile_id, start_date, created_at, last_seen_at, COALESCE(active, 1) AS active FROM users ORDER BY created_at ASC")
    .all();
  const counts = db
    .prepare<unknown[], { profile_id: string; c: number }>(
      `SELECT profile_id, COUNT(*) AS c FROM job_applications
       WHERE profile_id IS NOT NULL AND profile_id != ''
         AND TRIM(COALESCE(resume_file_name, '')) != ''
         AND TRIM(COALESCE(job_description, '')) != ''
         AND applied_manually = 1
       GROUP BY profile_id`
    )
    .all() as { profile_id: string; c: number }[];
  const countByProfile = new Map(counts.map((r) => [r.profile_id, r.c]));
  return rows.map((r) => ({
    ...r,
    role: r.role as UserRole,
    application_count: r.assigned_profile_id ? countByProfile.get(r.assigned_profile_id) ?? 0 : 0,
  }));
}

/** Count job applications that have resume, job description, and status = applied. */
export function getApplicationCountByProfileId(profileId: string): number {
  const row = db
    .prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM job_applications
       WHERE profile_id = ?
         AND TRIM(COALESCE(resume_file_name, '')) != ''
         AND TRIM(COALESCE(job_description, '')) != ''
         AND applied_manually = 1`
    )
    .get(profileId);
  return row ? (row as { c: number }).c : 0;
}

export function createUser(params: {
  username: string;
  password_hash: string;
  role: UserRole;
  assigned_profile_id?: string | null;
  start_date?: string | null;
  active?: number;
}): UserRow {
  const id = genId();
  const username = params.username.trim().toLowerCase();
  const now = new Date().toISOString();
  const active = params.active !== undefined ? (params.active ? 1 : 0) : 1;
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, assigned_profile_id, start_date, created_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    username,
    params.password_hash,
    params.role,
    params.assigned_profile_id ?? null,
    params.start_date ?? null,
    now,
    active
  );
  const row = getUserById(id)!;
  return row;
}

export function updateUser(
  id: string,
  updates: {
    username?: string;
    role?: UserRole;
    assigned_profile_id?: string | null;
    start_date?: string | null;
    active?: number | boolean;
  }
): UserRow {
  const existing = getUserById(id);
  if (!existing) throw new Error("User not found");
  const username = updates.username !== undefined ? updates.username.trim().toLowerCase() : existing.username;
  const role = updates.role ?? existing.role;
  const assigned_profile_id = updates.assigned_profile_id !== undefined ? updates.assigned_profile_id : existing.assigned_profile_id;
  const start_date = updates.start_date !== undefined ? updates.start_date : existing.start_date;
  const active = updates.active !== undefined ? (updates.active === true || updates.active === 1 ? 1 : 0) : (existing.active ?? 1);
  db.prepare("UPDATE users SET username = ?, role = ?, assigned_profile_id = ?, start_date = ?, active = ? WHERE id = ?").run(
    username,
    role,
    assigned_profile_id,
    start_date,
    active,
    id
  );
  return getUserById(id)!;
}

export function updateUserPassword(id: string, password_hash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password_hash, id);
}

export function updateUserLastSeen(id: string): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, id);
}

export function deleteUser(id: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function countAdminUsers(): number {
  const row = db.prepare<unknown[], { c: number }>("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get();
  return row ? (row as { c: number }).c : 0;
}
