"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useResume, type ProfileMeta } from "@/lib/resume-context";
import { useAuth } from "../lib/auth-context";
import { useStatus } from "../lib/status-context";
import { normalizeCompanyForDuplicateKey } from "@/lib/normalize-company";
import { defaultResumeData, APPLICATION_RESUME_STYLE, type Experience, type ResumeData, type StoredProfileData } from "@/lib/resume-store";
import { FORMAT_LIST, formatIdToTemplateId, type FormatId } from "@/lib/template-format";
import { ApplicationResumeEditor } from "@/components/application-resume-editor";
import { Check, Copy, ExternalLink, FileText, Loader2, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Save, Download } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Doc icon with "R" label and light red stroke for resume cell and resume preview/style. */
function ResumeDocIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-red-400", className)}
      aria-hidden
    >
      {/* Document shape with fold */}
      <path d="M20 2H8a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V10l-6-8z" fill="none" />
      <path d="M20 2v6h6" fill="none" />
      <text x="16" y="22" textAnchor="middle" fill="currentColor" fontSize="18" fontWeight="700" fontFamily="system-ui, sans-serif">R</text>
    </svg>
  );
}

interface JobApplication {
  id: string;
  date: string;
  company_name: string;
  title: string;
  job_url: string | null;
  unified_job_id?: string | null;
  profile_id: string | null;
  resume_format_id?: string | null;
  resume_file_name: string;
  job_description?: string;
  /** 0 = not applied, 1 = applied */
  applied_manually?: number;
  gpt_chat_url?: string | null;
  last_resume_download_at?: string | null;
  created_at: string;
}

function isFormatId(value: string | null | undefined): value is FormatId {
  return Boolean(value && FORMAT_LIST.some((item) => item.formatId === value));
}

function readStoredApplicationFormatId(): FormatId {
  if (typeof window === "undefined") return "format1";
  try {
    const stored = localStorage.getItem("resume-builder-application-modal-template");
    if (isFormatId(stored)) return stored;
  } catch {}
  return "format1";
}

function getJobApplicationFormatId(app?: JobApplication | null): FormatId {
  return isFormatId(app?.resume_format_id) ? app.resume_format_id : readStoredApplicationFormatId();
}

/** In-memory placeholder so a new row can appear at the clicked line (e.g. line 73). Not in DB. */
type RowItem = JobApplication | (JobApplication & { _placeholder: true });

function isPlaceholder(app: RowItem): app is JobApplication & { _placeholder: true } {
  return "_placeholder" in app && (app as { _placeholder?: boolean })._placeholder === true;
}

/** Strip trailing Google search reference markers (e.g. " -10.", " -1-10.", " -4.") from a single line. */
function stripGoogleRefSuffix(line: string): string {
  return line.replace(/\s-\d+(?:-\d+)?\.?$/, "");
}

/** Clean text line-by-line: strip Google ref suffixes. Use for pasted JD and for content read from GPT chat. */
function stripGoogleRefSuffixFromText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => stripGoogleRefSuffix(line))
    .join("\n");
}

function jobAppFieldsDiffer(a: JobApplication, b: JobApplication): boolean {
  return (
    (a.date ?? "") !== (b.date ?? "") ||
    (a.company_name ?? "") !== (b.company_name ?? "") ||
    (a.title ?? "") !== (b.title ?? "") ||
    (a.job_url ?? "") !== (b.job_url ?? "") ||
    (a.profile_id ?? "") !== (b.profile_id ?? "") ||
    (a.resume_format_id ?? "") !== (b.resume_format_id ?? "") ||
    (a.resume_file_name ?? "") !== (b.resume_file_name ?? "") ||
    (a.job_description ?? "") !== (b.job_description ?? "") ||
    (a.applied_manually ?? 0) !== (b.applied_manually ?? 0) ||
    (a.gpt_chat_url ?? "") !== (b.gpt_chat_url ?? "")
  );
}

function jobAppPatchBody(app: JobApplication): Record<string, unknown> {
  return {
    date: app.date ?? "",
    company_name: app.company_name ?? "",
    title: app.title ?? "",
    job_url: app.job_url ?? null,
    profile_id: app.profile_id ?? null,
    resume_format_id: app.resume_format_id ?? "format1",
    resume_file_name: app.resume_file_name ?? null,
    job_description: app.job_description ?? "",
    applied_manually: app.applied_manually ?? 0,
    gpt_chat_url: app.gpt_chat_url ?? null,
  };
}

const COLUMN_KEYS = [
  "no",
  "date",
  "company",
  "title",
  "jobUrl",
  "jobDescription",
  "resume",
  "applied",
] as const;

type ColumnKey = (typeof COLUMN_KEYS)[number];

const COLUMN_INDEX: Record<ColumnKey, number> = {
  no: 0,
  date: 1,
  company: 2,
  title: 3,
  jobUrl: 4,
  jobDescription: 5,
  resume: 6,
  applied: 7,
};

type PromptId = 1 | 2 | 3 | 4;
type HighlightTarget = "currentCompany" | "lastCompany" | "summary" | "skills";

type AiPrompts = {
  summary: string;
  bulletsCurrent: string;
  bulletsLast: string;
  skills: string;
};

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  no: 64,
  date: 96,
  company: 160,
  title: 180,
  jobUrl: 220,
  jobDescription: 260,
  resume: 220,
  applied: 80,
};

const EDITABLE_COLUMNS: ColumnKey[] = ["date", "company", "title", "jobUrl", "jobDescription", "resume"];

function fillPromptTemplate(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    const token = `{{${key}}}`;
    if (result.includes(token)) {
      result = result.split(token).join(value);
    }
  }
  return result;
}

/** Replaces {{job_description}} only on first occurrence; further occurrences become "[See role context above.]" to avoid duplicating role context. */
function fillPromptTemplateWithJobDescriptionOnce(
  template: string,
  replacements: Record<string, string>,
  subsequentPlaceholder: string = "[See role context above.]"
): string {
  const jobDescToken = "{{job_description}}";
  const value = replacements.job_description ?? "";
  if (!template.includes(jobDescToken)) return fillPromptTemplate(template, replacements);
  const firstIdx = template.indexOf(jobDescToken);
  let result =
    template.slice(0, firstIdx) + value + template.slice(firstIdx + jobDescToken.length);
  result = result.split(jobDescToken).join(subsequentPlaceholder);
  const { job_description: _, ...rest } = replacements;
  for (const [key, val] of Object.entries(rest)) {
    const token = `{{${key}}}`;
    if (result.includes(token)) result = result.split(token).join(val);
  }
  return result;
}

function buildPromptForButton(
  id: PromptId,
  prompts: AiPrompts | null,
  params: { currentCompany: string; lastCompany: string; jobDescription: string; roleContext?: string | null; currentRole?: string | null }
): string {
  const base = (() => {
    switch (id) {
      case 1:
        return prompts?.bulletsCurrent ?? "Write strong bullets for the current company.";
      case 2:
        return prompts?.bulletsLast ?? "Write strong bullets for the last company.";
      case 3:
        return prompts?.summary ?? "Write a concise professional summary.";
      case 4:
        return prompts?.skills ?? "Extract and refine a clear skill set description.";
      default:
        return "";
    }
  })();
  if (!base) return "";

  const currentCompany = params.currentCompany?.trim() ?? "";
  const lastCompany = params.lastCompany?.trim() ?? "";
  const jobDescription = params.jobDescription ?? "";
  const roleContext = (params.roleContext ?? "").trim();
  const currentRole = (params.currentRole ?? "").trim();

  if (id === 1) {
    return fillPromptTemplateWithJobDescriptionOnce(base, {
      company: currentCompany,
      job_description: roleContext || "",
      role: currentRole,
    });
  }
  if (id === 2) {
    return fillPromptTemplateWithJobDescriptionOnce(base, {
      company: lastCompany,
      job_description: roleContext || "",
      role: currentRole,
    });
  }
  return fillPromptTemplate(base, {
    company: currentCompany,
    job_description: jobDescription,
    role: currentRole,
  });
}

/** Build extraction prompt for core role context (same text as server extractCoreContext). Used only for GPT webview flow. */
function buildExtractionPromptForGpt(jobDescription: string): string {
  const jd = (jobDescription ?? "").trim();
  if (!jd) return "";
  return [
    "JOB DESCRIPTION EXTRACTOR",
    "",
    "You are a resume assistant. Extract the following from the job description below and output in a clean, consistent format.",
    "Do not summarize, interpret, paraphrase, or add commentary — preserve exact names and terms as written in the JD.",
    "",
    "---",
    "",
    "Input",
    "Job Description:",
    "",
    jd,
    "",
    "---",
    "",
    "Extract exactly these 6 sections:",
    "",
    "(1) JOB TITLE",
    "- Exact job title as written",
    "",
    "(2) SENIORITY LEVEL",
    "- Junior / Mid / Senior / Staff / Principal — infer from title and responsibilities if not explicitly stated",
    "",
    "(3) KEY RESPONSIBILITIES",
    "- 4-6 short bullet points summarizing core responsibilities",
    "- Use the JD's own language — do not rephrase or upgrade wording",
    "",
    "(4) TECH STACK — EXACT NAMES ONLY",
    "- List every technology, tool, framework, language, database, and cloud service mentioned",
    "- Exact names only — never group, summarize, or generalize",
    '- Never write "cloud platforms", "database technologies", or "modern frameworks" — always write the exact name (e.g. AWS Lambda, PostgreSQL, React)',
    "- Separate into subcategories:",
    "  - Cloud provider and native services: (e.g. AWS Lambda, Azure Functions, GCP BigQuery)",
    "  - Programming languages: (e.g. Python, Java, Go)",
    "  - Frameworks and libraries: (e.g. FastAPI, Spring Boot, React)",
    "  - Databases: (e.g. PostgreSQL, MongoDB, Redis)",
    "  - DevOps and infrastructure tools: (e.g. Kafka, Terraform, Docker, Kubernetes)",
    "  - AI and ML tools: (e.g. LangChain, OpenAI API, HuggingFace)",
    "",
    "(5) CLOUD PROVIDER",
    "- Identify the primary cloud platform targeted: AWS / Azure / GCP / Multi-cloud / Not specified",
    "- List all cloud-specific services mentioned (e.g. S3, Cosmos DB, BigQuery)",
    "",
    "(6) CORE SKILLS AND KEYWORDS",
    "- 8-12 non-tech keywords and soft skills (e.g. distributed systems, high availability, cross-functional collaboration, event-driven architecture)",
    "- Exact phrases from the JD only — no invention",
    "",
    "---",
    "",
    "Output the 6 sections only — no commentary, no explanations, no additional text.",
  ].join("\n");
}

/** Build full prompt for GPT/DeepSeek webview flow. Steps 1–2 use only role context (no full JD). Steps 3 and 4 include bullets when provided. */
function buildFullPromptForGptStep(
  stepId: PromptId,
  prompts: AiPrompts | null,
  params: { currentCompany: string; lastCompany: string; jobDescription: string; currentRole?: string | null },
  generatedBullets?: { current: string; last: string },
  roleContext?: string | null
): string {
  const paramsWithRole = { ...params, roleContext: roleContext ?? undefined };
  const baseCorePrompt = buildPromptForButton(stepId, prompts, paramsWithRole);
  const prefix = roleContext && roleContext.trim()
    ? `Job description (use to tailor):\n${roleContext.trim()}\n\n`
    : "";
  const basePrompt = prefix + baseCorePrompt;
  if (stepId === 1 || stepId === 2) return baseCorePrompt;
  const bulletsText = [generatedBullets?.current ?? "", generatedBullets?.last ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!bulletsText) return basePrompt;
  if (stepId === 3) {
    return basePrompt + "\n\nHere are the experience bullets to base the summary on:\n\n" + bulletsText;
  }
  return basePrompt + "\n\nHere are the experience bullets to extract skills from:\n\n" + bulletsText;
}

/** Max skills per category; AI sometimes returns 15–18+ despite prompt limits, so we cap and ignore the rest. */
const MAX_SKILLS_PER_CATEGORY = 15;

/** Parse skills text (Category: A, B, C lines) into skills array. Reused by API and GPT flows. Caps at MAX_SKILLS_PER_CATEGORY per category. */
function parseSkillsText(skillsText: string): { id: string; name: string; category: string }[] {
  const lines = skillsText.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
  const skillsArr: { id: string; name: string; category: string }[] = [];
  let id = 0;
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const category = line.slice(0, idx).trim();
      const rest = line.slice(idx + 1).trim();
      const names = rest ? rest.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
      for (const name of names) {
        skillsArr.push({ id: `skill-${id++}`, name, category: category || "Other" });
      }
    } else {
      const names = line.split(",").map((s: string) => s.trim()).filter(Boolean);
      for (const name of names) {
        skillsArr.push({ id: `skill-${id++}`, name, category: "Other" });
      }
    }
  }
  return capSkillsPerCategory(skillsArr, MAX_SKILLS_PER_CATEGORY);
}

/** Keep at most maxPerCategory skills per category; ignore the rest and reassign ids. */
function capSkillsPerCategory(
  skills: { id: string; name: string; category: string }[],
  maxPerCategory: number
): { id: string; name: string; category: string }[] {
  const byCategory = new Map<string, { id: string; name: string; category: string }[]>();
  for (const s of skills) {
    const cat = s.category || "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    const list = byCategory.get(cat)!;
    if (list.length < maxPerCategory) list.push(s);
  }
  const out: { id: string; name: string; category: string }[] = [];
  let id = 0;
  for (const list of Array.from(byCategory.values())) {
    for (const s of list) {
      out.push({ id: `skill-${id++}`, name: s.name, category: s.category });
    }
  }
  return out;
}

/** Display date as MM/DD for current year, MM/DD/YYYY for other years. Input: YYYY-MM-DD. */
function formatDateForDisplay(dateStr: string | null | undefined): string {
  if (!dateStr || typeof dateStr !== "string") return "";
  const trimmed = dateStr.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("-");
  const y = parts[0] ?? "";
  const m = parts[1] ?? "";
  const d = parts[2] ?? "";
  if (!m || !d) return trimmed;
  const month = m.padStart(2, "0");
  const day = d.padStart(2, "0");
  const currentYear = new Date().getFullYear();
  const yearNum = parseInt(y, 10);
  if (!Number.isNaN(yearNum) && yearNum === currentYear) return `${month}/${day}`;
  return `${month}/${day}/${y}`;
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (!text) return;
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      console.error("navigator.clipboard.writeText failed:", err);
    }
  }
  if (typeof document === "undefined") return;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch (err) {
    console.error("Fallback copy to clipboard failed:", err);
  }
}

export function JobApplicationsView() {
  const { user } = useAuth();
  const { setStatus } = useStatus();
  const { profiles, currentProfileId } = useResume();
  const [applications, setApplications] = useState<RowItem[]>([]);
  /** Duplicate keys from backend (profile_id::company_lower) for red highlight */
  const [duplicateApplicationKeys, setDuplicateApplicationKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  /** When set, the modal is in "Apply" mode for this application; otherwise "Add new" from context menu. */
  const [applyApplication, setApplyApplication] = useState<JobApplication | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  /** Blob URL for PDF shown in the right panel (revoked on close or when regenerating). */
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  /** Modal-only resume data: loaded from API when modal opens. No global variable. */
  const [modalResumeData, setModalResumeData] = useState<ResumeData | null>(null);
  /** Approximate token count of the modal resume content (for PDF output). */
  const modalResumeTokenEstimate = useMemo(() => {
    const data = modalResumeData ?? defaultResumeData;
    try {
      const text = JSON.stringify(data);
      // Rough approximation: 4 characters ≈ 1 token
      return Math.ceil(text.length / 4);
    } catch {
      return 0;
    }
  }, [modalResumeData]);
  /** Incremented whenever summary/skills/experience change so debounced PDF refresh always runs. */
  /** Resume style (template) chosen in application modal; persisted to localStorage. */
  const APPLICATION_MODAL_TEMPLATE_KEY = "resume-builder-application-modal-template";
  const [applicationModalFormatId, setApplicationModalFormatId] = useState<FormatId>(() => readStoredApplicationFormatId());
  const modalResumeDataRef = useRef<ResumeData | null>(null);
  modalResumeDataRef.current = modalResumeData;
  const applicationModalFormatIdRef = useRef<FormatId>(applicationModalFormatId);
  applicationModalFormatIdRef.current = applicationModalFormatId;
  const persistApplicationResumeFormat = useCallback(async (appId: string, formatId: FormatId) => {
    const res = await fetch(`/api/job-applications/${appId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume_format_id: formatId }),
    });
    if (!res.ok) {
      throw new Error("Failed to save resume style");
    }
    const updated = (await res.json()) as JobApplication;
    setApplications((prev) => prev.map((app) => (app.id === updated.id ? { ...app, ...updated } : app)));
    setApplyApplication((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
    return updated;
  }, []);
  // Native browser PDF viewer UI can be large; most Chromium-based browsers honor these.
  const [modalContentVersion, setModalContentVersion] = useState(0);
  const pdfPreviewIframeSrc = useMemo(() => {
    if (!pdfPreviewUrl) return null;
    return `${pdfPreviewUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=page-width`;
  }, [pdfPreviewUrl]);
  const [modalResumeDataId, setModalResumeDataId] = useState<string | null>(null);
  const [modalDataLoading, setModalDataLoading] = useState(false);
  const DEEPSEEK_PANEL_KEY = "resume-builder-deepseek-panel-open";
  const [deepSeekPanelOpen, setDeepSeekPanelOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const stored = localStorage.getItem(DEEPSEEK_PANEL_KEY);
      if (stored === "false") return false;
      return true;
    } catch {
      return true;
    }
  });
  const toggleDeepSeekPanel = useCallback(() => {
    setDeepSeekPanelOpen((prev) => {
      const next = !prev;
      if (!next) deepSeekCookiesLoadedFromDbRef.current = false;
      try {
        localStorage.setItem(DEEPSEEK_PANEL_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);
  const deepSeekWebViewRef = useRef<HTMLElement | null>(null);
  const deepSeekCookiesLoadedFromDbRef = useRef(false);
  const deepSeekInvalidRetryCountRef = useRef(0);
  const DEEPSEEK_MAX_RETRIES = 3;
  const isDesktopDeepSeekSync = typeof window !== "undefined" && !!(window as unknown as { electron?: { setDeepSeekCookies?: unknown } }).electron?.setDeepSeekCookies;
  const [deepSeekWebViewSrc, setDeepSeekWebViewSrc] = useState<string>(() =>
    isDesktopDeepSeekSync ? "about:blank" : "https://chat.deepseek.com/"
  );

  /** First-time load: fetch cookies from API, inject into partition, then set webview src (desktop only, no flash). */
  useEffect(() => {
    if (!deepSeekPanelOpen || !isDesktopDeepSeekSync) return;
    const electron = (window as unknown as { electron?: { setDeepSeekCookies: (c: unknown[]) => Promise<unknown> } }).electron;
    if (!electron?.setDeepSeekCookies) return;
    if (deepSeekCookiesLoadedFromDbRef.current) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/deepseek-cookies");
        if (cancelled) return;
        const data = (await res.json()) as { cookies?: unknown[] };
        const cookies = Array.isArray(data?.cookies) ? data.cookies : [];
        if (cookies.length > 0) {
          await electron.setDeepSeekCookies(cookies);
        }
        if (cancelled) return;
        deepSeekCookiesLoadedFromDbRef.current = true;
        setDeepSeekWebViewSrc("https://chat.deepseek.com/");
        if (cookies.length > 0) {
          const wv = deepSeekWebViewRef.current as unknown as { reload?: () => void };
          const reload = wv?.reload;
          if (typeof reload === "function") setTimeout(() => reload(), 50);
        }
      } catch {
        if (!cancelled) {
          deepSeekCookiesLoadedFromDbRef.current = true;
          setDeepSeekWebViewSrc("https://chat.deepseek.com/");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepSeekPanelOpen, isDesktopDeepSeekSync]);

  useEffect(() => {
    const el = deepSeekWebViewRef.current;
    if (!el || !deepSeekPanelOpen) return;
    const onLoad = () => {
      const wv = el as unknown as { setZoomFactor?: (f: number) => void; executeJavaScript?: (code: string) => Promise<unknown>; reload?: () => void };
      if (typeof wv.setZoomFactor === "function") wv.setZoomFactor(0.6);

      if (!isDesktopDeepSeekSync || deepSeekInvalidRetryCountRef.current >= DEEPSEEK_MAX_RETRIES) return;
      const electron = (window as unknown as { electron?: { setDeepSeekCookies: (c: unknown[]) => Promise<unknown> } }).electron;
      if (!electron?.setDeepSeekCookies || typeof wv.executeJavaScript !== "function") return;

      wv.executeJavaScript(
        `(function(){
          var b = document.body;
          if (!b) return true;
          var t = (b.innerText || '').toLowerCase();
          return t.indexOf('log in') !== -1 || t.indexOf('login') !== -1 || !!document.querySelector('form[action*="login"], [data-testid*="login"], a[href*="login"]');
        })()`
      ).then((notLoggedIn) => {
        if (notLoggedIn !== true) return;
        if (deepSeekInvalidRetryCountRef.current >= DEEPSEEK_MAX_RETRIES) return;
        deepSeekInvalidRetryCountRef.current += 1;
        deepSeekCookiesLoadedFromDbRef.current = false;
        (async () => {
          try {
            const res = await fetch("/api/deepseek-cookies");
            const data = (await res.json()) as { cookies?: unknown[] };
            const cookies = Array.isArray(data?.cookies) ? data.cookies : [];
            if (cookies.length > 0) await electron.setDeepSeekCookies(cookies);
            if (typeof wv.reload === "function") wv.reload();
          } catch {
            deepSeekCookiesLoadedFromDbRef.current = true;
          }
        })();
      }).catch(() => {});
    };
    el.addEventListener("did-finish-load", onLoad);
    return () => el.removeEventListener("did-finish-load", onLoad);
  }, [deepSeekPanelOpen, isDesktopDeepSeekSync]);

  /** When application modal opens, click the DeepSeek "new chat" button in the webview so user gets a fresh chat. */
  useEffect(() => {
    if (!addOpen || !deepSeekPanelOpen) return;
    const wv = deepSeekWebViewRef.current as unknown as { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> } | null;
    if (typeof wv?.executeJavaScript !== "function") return;
    const t = setTimeout(() => {
      const ref = deepSeekWebViewRef.current as unknown as { executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown> } | null;
      if (typeof ref?.executeJavaScript !== "function") return;
      const code = `(function(){
        var buttons = document.querySelectorAll('div.ds-icon-button.ds-icon-button--xl.ds-icon-button--sizing-container[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          var path = buttons[i].querySelector('svg path');
          if (path && path.getAttribute('d') && path.getAttribute('d').indexOf('9.2192 6.36949') !== -1) {
            buttons[i].click();
            break;
          }
        }
      })();`;
      ref.executeJavaScript(code, true).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [addOpen, deepSeekPanelOpen]);

  /** Run one GPT step in the DeepSeek webview: set prompt, send, wait for reply, return last assistant message text. */
  const runGptStepInWebview = useCallback(
    async (promptText: string): Promise<string | null> => {
      const wv = deepSeekWebViewRef.current as unknown as {
        executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
      } | null;
      if (typeof wv?.executeJavaScript !== "function") return null;
      const exec = async (code: string) => {
        try {
          return await wv.executeJavaScript!(code, true);
        } catch {
          return null;
        }
      };

      const escapedPrompt = JSON.stringify(promptText);
      const setTextareaCode = `(function(){
        var ta = document.querySelector('textarea[placeholder="Message DeepSeek"]') || document.querySelector('textarea.d96f2d2a');
        if (!ta) return false;
        var prompt = ${escapedPrompt};
        var value = prompt + ".";
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (nativeSetter) { nativeSetter.call(ta, value); }
        else { ta.value = value; }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })();`;
      const setOk = await exec(setTextareaCode);
      if (!setOk) return null;

      const sendEnabledCode = `(function(){
        var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].classList.contains('ds-icon-button--disabled')) continue;
          var path = buttons[i].querySelector('svg path');
          var d = path && path.getAttribute('d');
          if (d && d.indexOf('8.3125') !== -1) return true;
        }
        return false;
      })();`;
      const SEND_WAIT_MS = 5000;
      const startSend = Date.now();
      while (Date.now() - startSend < SEND_WAIT_MS) {
        const enabled = await exec(sendEnabledCode);
        if (enabled === null) return null;
        if (enabled) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const stillEnabled = await exec(sendEnabledCode);
      if (stillEnabled !== true) return null;

      const clickSendCode = `(function(){
        var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          if (buttons[i].classList.contains('ds-icon-button--disabled')) continue;
          var path = buttons[i].querySelector('svg path');
          var d = path && path.getAttribute('d');
          if (d && d.indexOf('8.3125') !== -1) { buttons[i].click(); return true; }
        }
        return false;
      })();`;
      const clicked = await exec(clickSendCode);
      if (clicked === null) return null;

      const generatingCode = `(function(){
        var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          var path = buttons[i].querySelector('svg path');
          var d = path && path.getAttribute('d');
          if (d && (d.indexOf('M2 4.88') !== -1 || d.indexOf('2 4.88') !== -1)) return true;
        }
        return false;
      })();`;
      const doneCode = `(function(){
        var buttons = document.querySelectorAll('div.ds-icon-button[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          var path = buttons[i].querySelector('svg path');
          var d = path && path.getAttribute('d');
          if (d && d.indexOf('8.3125') !== -1) {
            return buttons[i].classList.contains('ds-icon-button--disabled');
          }
        }
        return false;
      })();`;
      const GEN_TIMEOUT_MS = 90000;
      const startGen = Date.now();
      let sawGenerating = false;
      while (Date.now() - startGen < GEN_TIMEOUT_MS) {
        const gen = await exec(generatingCode);
        if (gen === null) return null;
        if (gen) sawGenerating = true;
        if (sawGenerating) {
          const done = await exec(doneCode);
          if (done === null) return null;
          if (done) break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const lastMessageCode = `(function(){
        function nodeToMarkdown(node) {
          if (!node) return '';
          if (node.nodeType === 3) return node.nodeValue || '';
          if (node.nodeType !== 1) return '';
          var el = node;
          var tag = el.tagName;
          if (tag === 'BR') return '\\n';
          var block = tag === 'P' || tag === 'DIV' || tag === 'LI';
          var style = el.getAttribute('style') || '';
          var className = el.getAttribute('class') || '';
          var bold =
            tag === 'STRONG' ||
            tag === 'B' ||
            /font-weight\\s*:\\s*(bold|[5-9]00)/i.test(style) ||
            /(font-(semi)?bold|font-black|font-medium|font-semibold)/i.test(className) ||
            /\\b(bold|semibold)\\b/i.test(className);
          var text = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            text += nodeToMarkdown(el.childNodes[i]);
          }
          if (block && text && text.charAt(text.length - 1) !== '\\n') text += '\\n';
          if (!text) return '';
          if (bold) return '**' + text + '**';
          return text;
        }
        var messages = document.querySelectorAll('.ds-message');
        for (var i = messages.length - 1; i >= 0; i--) {
          var markdown = messages[i].querySelector('.ds-markdown');
          if (!markdown) continue;
          var raw = nodeToMarkdown(markdown);
          if (!raw) raw = (markdown.innerText || markdown.textContent || '').trim();
          if (!raw) continue;
          raw = raw.replace(/\\r\\n/g, '\\n');
          raw = raw.replace(/\\n{3,}/g, '\\n\\n');
          raw = raw.replace(/[^\\S\\n]+/g, ' ');
          return raw.trim();
        }
        return null;
      })();`;
      const text = await exec(lastMessageCode);
      return typeof text === "string" ? stripGoogleRefSuffixFromText(text) : null;
    },
    []
  );

  /** Capture the current DeepSeek chat URL and associate it with the active application or pending modal session. */
  const captureCurrentGptChatUrl = useCallback(
    async (appId: string | null) => {
      const wv = deepSeekWebViewRef.current as unknown as {
        executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
      } | null;
      if (typeof wv?.executeJavaScript !== "function") return;
      let href: unknown = null;
      try {
        href = await wv.executeJavaScript!("location.href", true);
      } catch {
        return;
      }
      if (typeof href !== "string") return;
      const url = href.trim();
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (appId) {
        saveGptChatUrlForApp(appId, url);
      } else {
        setPendingGptChatUrl(url);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** Start a fresh DeepSeek chat session (click the \"new chat\" button in the webview). */
  const startNewGptChatSession = useCallback(async () => {
    const wv = deepSeekWebViewRef.current as unknown as {
      executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
    } | null;
    if (typeof wv?.executeJavaScript !== "function") return;
    const code = `(function(){
      try {
        var buttons = document.querySelectorAll('div.ds-icon-button.ds-icon-button--xl.ds-icon-button--sizing-container[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          var path = buttons[i].querySelector('svg path');
          if (path && path.getAttribute('d') && path.getAttribute('d').indexOf('9.2192 6.36949') !== -1) {
            buttons[i].click();
            return true;
          }
        }
      } catch (e) {}
      return false;
    })();`;
    try {
      await wv.executeJavaScript!(code, true);
    } catch {
      // ignore errors; best-effort
    }
  }, []);


  const EMPTY_ROW_BATCH = 1000;
  const [emptyRowCount, setEmptyRowCount] = useState(50);
  const [emptyRowLimit, setEmptyRowLimit] = useState(EMPTY_ROW_BATCH);
  const scrollRef = useRef<HTMLDivElement>(null);
  const outerScrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    row: number | null;
    selectionRows: number[];
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  /** Right-click on resume icon: show "Update resume" to open application modal and replace PDF for same id. */
  const [resumeContextMenu, setResumeContextMenu] = useState<{
    x: number;
    y: number;
    app: JobApplication;
  } | null>(null);
  const resumeContextMenuRef = useRef<HTMLDivElement>(null);
  const [regeneratingResumeId, setRegeneratingResumeId] = useState<string | null>(null);
  const [copiedPdfId, setCopiedPdfId] = useState<string | null>(null);
  const pdfBlobCacheRef = useRef<Map<string, Blob>>(new Map());
  /** Cached PDF ArrayBuffers for drag-and-drop (must be ready before dragStart). */
  const pdfBufferCacheRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const applyModalContentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const PROFILE_FILTER_STORAGE_KEY = "job-applications-profile-filter";
  const [profileFilterId, setProfileFilterId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const stored = sessionStorage.getItem(PROFILE_FILTER_STORAGE_KEY);
    if (typeof stored === "string" && stored.trim() !== "") return stored.trim();
    if (typeof currentProfileId === "string" && currentProfileId.trim() !== "") return currentProfileId;
    return "";
  });

  /** For user role, only their assigned profile is allowed. */
  const effectiveProfileFilterId =
    user?.role === "user" && user.assignedProfileId
      ? user.assignedProfileId
      : profileFilterId;

  /** Applications for the selected profile (loaded from backend; no client-side filter). */
  const dataRows = useMemo<RowItem[]>(() => applications, [applications]);

  const [bulkGptRunning, setBulkGptRunning] = useState(false);
  const [bulkGptProgress, setBulkGptProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [bulkInProgressIds, setBulkInProgressIds] = useState<Set<string>>(new Set());
  const [bulkCancelRequested, setBulkCancelRequested] = useState(false);
  const bulkCancelRef = useRef(false);

  const bulkEligibleApps = useMemo<JobApplication[]>(() => {
    return dataRows
      .filter((app): app is JobApplication => app != null && !isPlaceholder(app))
      .filter(
        (app) =>
          !app.applied_manually &&
          (app.job_description ?? "").trim() !== "" &&
          !Boolean(app.resume_file_name)
      );
  }, [dataRows]);

  useEffect(() => {
    if (user?.role === "user" && user.assignedProfileId) {
      setProfileFilterId(user.assignedProfileId);
      if (typeof window !== "undefined") sessionStorage.setItem(PROFILE_FILTER_STORAGE_KEY, user.assignedProfileId);
      return;
    }
    if (!profileFilterId && profiles.length > 0) {
      const firstId = profiles[0]!.id;
      setProfileFilterId(firstId);
      if (typeof window !== "undefined") sessionStorage.setItem(PROFILE_FILTER_STORAGE_KEY, firstId);
    }
  }, [user?.role, user?.assignedProfileId, profileFilterId, profiles]);

  // When the selected profile is deleted, switch to first available profile
  useEffect(() => {
    if (profileFilterId && profiles.length > 0 && !profiles.some((p) => p.id === profileFilterId)) {
      const firstId = profiles[0]!.id;
      setProfileFilterId(firstId);
      if (typeof window !== "undefined") sessionStorage.setItem(PROFILE_FILTER_STORAGE_KEY, firstId);
    }
  }, [profileFilterId, profiles]);

  const fetchDuplicateKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/job-applications/duplicate-keys");
      if (res.ok) {
        const data = (await res.json()) as { duplicateKeys?: string[] };
        setDuplicateApplicationKeys(new Set(data.duplicateKeys ?? []));
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchApplications = useCallback(async (profileId: string | null | undefined) => {
    try {
      if (!profileId) {
        setApplications([]);
        const dupRes = await fetch("/api/job-applications/duplicate-keys");
        if (dupRes.ok) {
          const data = (await dupRes.json()) as { duplicateKeys?: string[] };
          setDuplicateApplicationKeys(new Set(data.duplicateKeys ?? []));
        }
        return;
      }
      setLoading(true);
      const [appsRes, dupRes] = await Promise.all([
        fetch(`/api/job-applications?profile_id=${encodeURIComponent(profileId)}`),
        fetch("/api/job-applications/duplicate-keys"),
      ]);
      if (appsRes.ok) {
        const rows = (await appsRes.json()) as JobApplication[];
        setApplications(rows);
        setHistory([]);
        setFuture([]);
      }
      if (dupRes.ok) {
        const data = (await dupRes.json()) as { duplicateKeys?: string[] };
        setDuplicateApplicationKeys(new Set(data.duplicateKeys ?? []));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (effectiveProfileFilterId) {
      fetchApplications(effectiveProfileFilterId);
    } else {
      setApplications([]);
      setLoading(false);
    }
  }, [effectiveProfileFilterId, fetchApplications]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = contextMenuRef.current;
      if (el && !el.contains(e.target as Node)) setContextMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [contextMenu]);

  useEffect(() => {
    if (!resumeContextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = resumeContextMenuRef.current;
      if (el && !el.contains(e.target as Node)) setResumeContextMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [resumeContextMenu]);

  // Prevent browser find (Ctrl+F / Cmd+F) and use our search bar instead
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);
  const saveGptChatUrlForApp = useCallback(
    (appId: string, url: string) => {
      const trimmed = (url || "").trim();
      if (!appId || !trimmed) return;
      // Update in-memory map + localStorage for quick lookup.
      setGptChatUrls((prev) => {
        const next = { ...prev, [appId]: trimmed };
        try {
          if (typeof window !== "undefined") {
            window.localStorage.setItem("resume-builder-gpt-chat-urls", JSON.stringify(next));
          }
        } catch {
          // ignore storage errors
        }
        return next;
      });
      // Persist to backend DB so the chat URL is not lost.
      setApplications((prev) =>
        prev.map((a) => (a.id === appId ? { ...a, gpt_chat_url: trimmed } : a))
      );
      void fetch(`/api/job-applications/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gpt_chat_url: trimmed }),
      }).catch((err) => {
        console.error("Failed to save gpt_chat_url:", err);
      });
    },
    [setApplications]
  );
  /** AI prompt templates loaded from /api/ai/prompts (shared with AI settings page). */
  const [aiPrompts, setAiPrompts] = useState<AiPrompts | null>(null);
  useEffect(() => {
    if (!addOpen) {
      setHighlightTarget(null);
      setCopiedPromptId(null);
      setCopiedJobUrl(false);
      setPendingGptChatUrl(null);
    }
  }, [addOpen]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai/prompts");
        if (!res.ok) return;
        const json = (await res.json()) as AiPrompts;
        if (!cancelled) setAiPrompts(json);
      } catch {
        // ignore; buttons will fall back to generic prompts
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runGptPipelineForApplication = useCallback(
    async (app: JobApplication): Promise<StoredProfileData | null> => {
      const jd = (app.job_description ?? "").trim();
      if (!jd || !aiPrompts) return null;
      const profileId = app.profile_id ?? currentProfileId;
      if (!profileId) return null;

      // Use a fresh DeepSeek chat for each job so history is not mixed across applications.
      if (bulkCancelRef.current) return null;
      await startNewGptChatSession();
      if (bulkCancelRef.current) return null;

      let loaded: ResumeData = defaultResumeData;
      try {
        const res = await fetch(`/api/profiles/${profileId}`);
        if (res.ok) {
          const body = (await res.json()) as { data: ResumeData };
          loaded = body.data ?? defaultResumeData;
        }
      } catch {
        // fall back to defaultResumeData
      }

      let resume: ResumeData = {
        ...loaded,
        profile: { ...loaded.profile, summary: "" },
        skills: [],
        experience: (loaded.experience ?? []).map((exp: Experience) => {
          const staticContent =
            exp.useStaticBullets && (exp.staticBulletContent ?? "").trim()
              ? (exp.staticBulletContent ?? "").trim()
              : "";
          return { ...exp, description: staticContent || "" };
        }),
      };

      const exps = resume.experience ?? [];
      const currentCompanyName = exps[0]?.company?.trim() || app.company_name.trim();
      const currentRole = exps[0]?.role?.trim() ?? "";
      const params = {
        currentCompany: currentCompanyName,
        lastCompany: "", // set per non-current experience
        jobDescription: jd,
        currentRole,
      };

      if (bulkCancelRef.current) return null;
      const extractionPrompt = buildExtractionPromptForGpt(jd);
      const extractedContext = extractionPrompt
        ? (await runGptStepInWebview(extractionPrompt))?.trim() ?? ""
        : "";
      if (!extractedContext) return null;

      // Step 1: current company bullets (skip when first experience has static content)
      const firstExp = exps[0];
      const staticCurrent =
        firstExp?.useStaticBullets && (firstExp.staticBulletContent ?? "").trim()
          ? (firstExp.staticBulletContent ?? "").trim()
          : "";
      let currentBullets = staticCurrent;
      if (!staticCurrent) {
        if (bulkCancelRef.current) return null;
        const prompt1 = buildFullPromptForGptStep(1, aiPrompts, params, undefined, extractedContext);
        const result1 = await runGptStepInWebview(prompt1);
        if (!result1?.trim()) return null;
        currentBullets = result1.trim();
        resume = {
          ...resume,
          experience: (() => {
            const list = [...(resume.experience ?? [])];
            if (list[0]) list[0] = { ...list[0], description: currentBullets };
            return list;
          })(),
        };
      }

      // Step 2: last-company prompt (or static content) for each non-current experience (index 1, 2, ...)
      const lastBulletsParts: string[] = [];
      for (let i = 1; i < exps.length; i++) {
        const exp = exps[i];
        const lastCompanyName = exp?.company?.trim() ?? "";
        if (!lastCompanyName) continue;
        const staticLast =
          exp?.useStaticBullets && (exp.staticBulletContent ?? "").trim()
            ? (exp.staticBulletContent ?? "").trim()
            : "";
        let bullets = staticLast;
        if (!staticLast) {
          if (bulkCancelRef.current) return null;
          const paramsLast = { ...params, lastCompany: lastCompanyName };
          const prompt2 = buildFullPromptForGptStep(2, aiPrompts, paramsLast, undefined, extractedContext);
          const result2 = await runGptStepInWebview(prompt2);
          if (!result2?.trim()) continue;
          bullets = result2.trim();
        }
        lastBulletsParts.push(bullets);
        resume = {
          ...resume,
          experience: (() => {
            const list = [...(resume.experience ?? [])];
            if (list[i]) list[i] = { ...list[i], description: bullets };
            return list;
          })(),
        };
      }
      const lastBullets = lastBulletsParts.join("\n\n");

      // Step 3: summary
      if (bulkCancelRef.current) return null;
      const prompt3 = buildFullPromptForGptStep(
        3,
        aiPrompts,
        params,
        { current: currentBullets, last: lastBullets },
        extractedContext
      );
      const result3 = await runGptStepInWebview(prompt3);
      if (!result3?.trim()) return null;
      const summary = result3.trim();
      resume = {
        ...resume,
        profile: { ...resume.profile, summary },
      };

      // Step 4: skills
      if (bulkCancelRef.current) return null;
      const prompt4 = buildFullPromptForGptStep(
        4,
        aiPrompts,
        params,
        { current: currentBullets, last: lastBullets },
        extractedContext
      );
      const result4 = await runGptStepInWebview(prompt4);
      if (!result4?.trim()) return null;
      const skillsText = result4.trim();
      const skillsArr = parseSkillsText(skillsText);
      resume = {
        ...resume,
        skills: skillsArr,
      };

      if (!bulkCancelRef.current) {
        await captureCurrentGptChatUrl(app.id);
      }

      // Normalize skills and attach style for PDF generation.
      const rawSkills = resume.skills ?? [];
      const normalizedSkills: { id: string; name: string; category?: string }[] = [];
      let id = 0;
      for (const s of rawSkills) {
        const category = (s.category || "").trim() || "Other";
        const names = (s.name || "").split(",").map((n: string) => n.trim()).filter(Boolean);
        for (const name of names) {
          normalizedSkills.push({ id: `skill-pdf-${id++}`, name, category });
        }
      }

      let style = APPLICATION_RESUME_STYLE;
      const formatId = applicationModalFormatIdRef.current;
      try {
        const res = await fetch(`/api/templates/${formatId}/style`);
        if (res.ok) {
          const json = await res.json();
          style = json as typeof APPLICATION_RESUME_STYLE;
        }
      } catch {
        // ignore and fall back to APPLICATION_RESUME_STYLE
      }

      const stored: StoredProfileData = {
        ...resume,
        skills: normalizedSkills,
        style,
      };
      return stored;
    },
    [aiPrompts, currentProfileId, runGptStepInWebview, captureCurrentGptChatUrl]
  );
  const keyboardScrollTargetRef = useRef<{ row: number; col: number } | null>(null);
  const keyboardScrollRafRef = useRef<number | null>(null);
  const [editingCell, setEditingCell] = useState<{
    rowIndex: number;
    key: ColumnKey;
    value: string;
    appId: string;
  } | null>(null);
  const [profileDropdown, setProfileDropdown] = useState<{
    rowIndices: number[];
    left: number;
    top: number;
    anchorRow: number;
    anchorCol: number;
  } | null>(null);
  /** When set, show modal with this application's job description. */
  const [viewJobDescriptionId, setViewJobDescriptionId] = useState<string | null>(null);
  /** Which area of the modal editor is currently highlighted due to a prompt button. */
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>(null);
  /** Last prompt button that successfully copied to clipboard (for subtle UI feedback if needed). */
  const [copiedPromptId, setCopiedPromptId] = useState<PromptId | null>(null);
  /** True when Job URL was just copied in the application modal. */
  const [copiedJobUrl, setCopiedJobUrl] = useState(false);
  /** Mapping of application id -> DeepSeek chat URL (when GPT mode was used). Stored in localStorage. */
  const [gptChatUrls, setGptChatUrls] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem("resume-builder-gpt-chat-urls");
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch {
      return {};
    }
  });
  /** Chat URL captured during the current modal session before a new application has an id. */
  const [pendingGptChatUrl, setPendingGptChatUrl] = useState<string | null>(null);
  /** Whether the 4-step AI pipeline is currently running. */
  const [aiPipelineRunning, setAiPipelineRunning] = useState(false);
  /** Whether the GPT (DeepSeek webview) 4-step pipeline is running. */
  const [gptPipelineRunning, setGptPipelineRunning] = useState(false);
  /** Per-button loading state when generating or retrying a specific area. */
  const [aiButtonLoading, setAiButtonLoading] = useState<Record<PromptId, boolean>>({
    1: false,
    2: false,
    3: false,
    4: false,
  });
  /** In-memory role context and chat history for the current job's 4-step AI run (API flow). */
  const [roleContext, setRoleContext] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<
    { role: "user" | "assistant" | "system"; content: string }[]
  >([]);

  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(() => {
    if (typeof window === "undefined") return DEFAULT_COLUMN_WIDTHS;
    try {
      const raw = window.localStorage.getItem("jobApplicationsColumnWidths");
      if (!raw) return DEFAULT_COLUMN_WIDTHS;
      const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, number>>;
      return { ...DEFAULT_COLUMN_WIDTHS, ...parsed };
    } catch {
      return DEFAULT_COLUMN_WIDTHS;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("jobApplicationsColumnWidths", JSON.stringify(columnWidths));
    } catch {
      // ignore
    }
  }, [columnWidths]);

  const totalTableWidth = COLUMN_KEYS.reduce((sum, key) => sum + columnWidths[key], 0);

  const resizingColRef = useRef<ColumnKey | null>(null);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);

  const handleColumnResizeMouseDown = useCallback(
    (e: React.MouseEvent, key: ColumnKey) => {
      e.preventDefault();
      e.stopPropagation();
      resizingColRef.current = key;
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = columnWidths[key];

      const handleMove = (ev: MouseEvent) => {
        if (!resizingColRef.current) return;
        const delta = ev.clientX - resizeStartXRef.current;
        const base = resizeStartWidthRef.current;
        const next = Math.min(480, Math.max(60, base + delta));
        setColumnWidths((prev) => ({
          ...prev,
          [key]: next,
        }));
      };

      const handleUp = () => {
        resizingColRef.current = null;
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [columnWidths]
  );

  const startEdit = useCallback(
    (rowIndex: number, key: ColumnKey, initialValue: string, appId: string) => {
      if (!EDITABLE_COLUMNS.includes(key)) return;
      setEditingCell({
        rowIndex,
        key,
        value: initialValue ?? "",
        appId,
      });
    },
    []
  );

  const commitEdit = useCallback(async () => {
    if (!editingCell) return;
    const { rowIndex, key, value, appId } = editingCell;
    let patch: Partial<JobApplication> = {};
    if (key === "date") patch.date = value;
    else if (key === "company") patch.company_name = value;
    else if (key === "title") patch.title = value;
    else if (key === "jobUrl") patch.job_url = value || null;
    else if (key === "jobDescription") patch.job_description = value;
    else if (key === "resume") patch.resume_file_name = value;

    if (Object.keys(patch).length === 0) {
      setEditingCell(null);
      return;
    }

    // Placeholders are in-memory only; never PATCH them to the API.
    if (appId.startsWith("placeholder-")) {
      setApplications((prev) => {
        pushHistory(prev);
        return prev.map((a, idx) =>
          a.id === appId && idx === rowIndex ? { ...a, ...patch } : a
        );
      });
      setEditingCell(null);
      return;
    }

    try {
      setApplications((prev) => {
        pushHistory(prev);
        return prev;
      });
      const res = await fetch(`/api/job-applications/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = (await res.json()) as JobApplication;
        setApplications((prev) =>
          prev.map((a, idx) => (a.id === appId && idx === rowIndex ? updated : a))
        );
        toast.success("Saved");
      } else {
        // If API fails, keep local change so user doesn't lose input
        setApplications((prev) =>
          prev.map((a, idx) =>
            a.id === appId && idx === rowIndex ? { ...a, ...patch } : a
          )
        );
        toast.error("Failed to save");
      }
    } catch {
      setApplications((prev) =>
        prev.map((a, idx) =>
          a.id === appId && idx === rowIndex ? { ...a, ...patch } : a
        )
      );
      toast.error("Failed to save");
    } finally {
      setEditingCell(null);
      void fetchDuplicateKeys();
    }
  }, [editingCell, setApplications, fetchDuplicateKeys]);

  const loadMoreEmptyRows = useCallback(() => {
    setEmptyRowCount((prev) => Math.min(prev + 50, emptyRowLimit));
  }, [emptyRowLimit]);

  const handleAddMoreRows = useCallback(() => {
    setEmptyRowLimit((prev) => prev + EMPTY_ROW_BATCH);
  }, []);

  // Undo/redo state (must be before handleUndo/handleRedo)
  const UNDO_LIMIT = 10;
  const UNDO_STORAGE_KEY = "job-applications-undo-history";
  const SCROLL_STORAGE_KEY = "job-applications-scroll";
  const [history, setHistory] = useState<RowItem[][]>([]);
  const [future, setFuture] = useState<RowItem[][]>([]);
  const pushHistory = useCallback((prev: RowItem[]) => {
    const snapshot = prev.map((a) =>
      isPlaceholder(a) ? a : ({ ...a } as JobApplication)
    );
    setHistory((h) => [...h.slice(-(UNDO_LIMIT - 1)), snapshot]);
    setFuture([]);
  }, []);
  const tableStats = useMemo(() => {
    const real = applications.filter((a): a is JobApplication => !isPlaceholder(a));
    const hasJobInfo = (a: JobApplication) =>
      (a.company_name ?? "").trim() !== "" ||
      (a.title ?? "").trim() !== "" ||
      (a.job_url ?? "").trim() !== "";
    const notEmpty = real.filter(hasJobInfo);
    const today = new Date().toISOString().slice(0, 10);
    const total = notEmpty.length;
    const todayCount = notEmpty.filter((a) => (a.date ?? "").trim() === today).length;
    const available = notEmpty.filter((a) => !Boolean(a.resume_file_name)).length;
    return { total, todayCount, available };
  }, [applications]);

  const handleUndo = useCallback(async () => {
    if (!history.length) return;
    const restored = history[history.length - 1] as RowItem[];
    const currentIds = new Set(
      applications.filter((a) => !isPlaceholder(a)).map((a) => a.id)
    );
    const restoredIds = new Set(
      restored.filter((a) => !isPlaceholder(a)).map((a) => (a as JobApplication).id)
    );
    const toRestore = restored.filter(
      (a): a is JobApplication => !isPlaceholder(a) && !currentIds.has(a.id)
    );
    const toRemove = applications.filter(
      (a): a is JobApplication =>
        !isPlaceholder(a) && !restoredIds.has(a.id)
    );
    if (toRestore.length === 0 && toRemove.length === 0) {
      const restoredById = new Map(
        restored
          .filter((a): a is JobApplication => !isPlaceholder(a))
          .map((a) => [a.id, a])
      );
      const toRevert = applications.filter((a): a is JobApplication => {
        if (isPlaceholder(a)) return false;
        const prev = restoredById.get(a.id);
        return prev != null && jobAppFieldsDiffer(a, prev);
      });
      if (toRevert.length > 0) {
        try {
          await Promise.all(
            toRevert.map((app) => {
              const prev = restoredById.get(app.id)!;
              return fetch(`/api/job-applications/${app.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(jobAppPatchBody(prev)),
              }).then((r) => {
                if (!r.ok) throw new Error("Failed to revert application");
              });
            })
          );
        } catch (e) {
          console.error("Undo (revert edits in DB) failed:", e);
          setHistory((prev) => prev.slice(0, -1));
          fetchApplications(effectiveProfileFilterId);
          return;
        }
      }
      setApplications(restored);
      setHistory((prev) => prev.slice(0, -1));
      setFuture((f) => [applications, ...f]);
      void fetchDuplicateKeys();
      return;
    }
    if (toRemove.length > 0) {
      try {
        await Promise.all(
          toRemove.map((app) =>
            fetch(`/api/job-applications/${app.id}`, { method: "DELETE" })
          )
        );
      } catch (e) {
        console.error("Undo (remove added row from DB) failed:", e);
        setHistory((prev) => prev.slice(0, -1));
        fetchApplications(effectiveProfileFilterId);
        return;
      }
    }
    if (toRestore.length === 0) {
      setApplications(restored);
      setHistory((prev) => prev.slice(0, -1));
      setFuture((f) => [applications, ...f]);
      void fetchDuplicateKeys();
      return;
    }
    try {
      const newRows = await Promise.all(
        toRestore.map((app) =>
          fetch("/api/job-applications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              date: app.date,
              company_name: app.company_name,
              title: app.title,
              job_url: app.job_url ?? null,
              profile_id: app.profile_id ?? null,
              resume_file_name: app.resume_file_name ?? null,
              job_description: (app as JobApplication).job_description ?? "",
            }),
          }).then((r) => {
            if (!r.ok) throw new Error("Failed to restore application");
            return r.json() as Promise<JobApplication>;
          })
        )
      );
      const newRestored = restored.map((a) => {
        const i = toRestore.indexOf(a as JobApplication);
        if (i >= 0) return newRows[i];
        return a;
      });
      setApplications(newRestored);
      setHistory((prev) => prev.slice(0, -1));
      setFuture((f) => [applications, ...f]);
      void fetchDuplicateKeys();
    } catch (e) {
      console.error("Undo (restore to DB) failed:", e);
      setHistory((prev) => prev.slice(0, -1));
      fetchApplications(effectiveProfileFilterId);
    }
  }, [history, applications, effectiveProfileFilterId, fetchApplications, fetchDuplicateKeys]);

  const handleRedo = useCallback(async () => {
    if (!future.length) return;
    const [next, ...rest] = future;
    const currentIds = new Set(
      applications.filter((a) => !isPlaceholder(a)).map((a) => a.id)
    );
    const nextIds = new Set(
      next.filter((a) => !isPlaceholder(a)).map((a) => (a as JobApplication).id)
    );
    const toRemove = applications.filter(
      (a): a is JobApplication =>
        !isPlaceholder(a) && !nextIds.has(a.id)
    );
    const toRestore = next.filter(
      (a): a is JobApplication =>
        !isPlaceholder(a) && !currentIds.has(a.id)
    );
    if (toRemove.length > 0) {
      try {
        await Promise.all(
          toRemove.map((app) =>
            fetch(`/api/job-applications/${app.id}`, { method: "DELETE" })
          )
        );
      } catch (e) {
        console.error("Redo (remove from DB) failed:", e);
        return;
      }
    }
    if (toRestore.length === 0) {
      const nextById = new Map(
        next
          .filter((a): a is JobApplication => !isPlaceholder(a))
          .map((a) => [a.id, a])
      );
      const toReapply = applications.filter((a): a is JobApplication => {
        if (isPlaceholder(a)) return false;
        const target = nextById.get(a.id);
        return target != null && jobAppFieldsDiffer(a, target);
      });
      if (toReapply.length > 0) {
        try {
          await Promise.all(
            toReapply.map((app) => {
              const target = nextById.get(app.id)!;
              return fetch(`/api/job-applications/${app.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(jobAppPatchBody(target)),
              }).then((r) => {
                if (!r.ok) throw new Error("Failed to redo re-apply application");
              });
            })
          );
        } catch (e) {
          console.error("Redo (re-apply edits in DB) failed:", e);
          return;
        }
      }
      setApplications(next);
      setFuture(rest);
      setHistory((h) => [...h, applications]);
      void fetchDuplicateKeys();
      return;
    }
    try {
      const newRows = await Promise.all(
        toRestore.map((app) =>
          fetch("/api/job-applications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              date: app.date,
              company_name: app.company_name,
              title: app.title,
              job_url: app.job_url ?? null,
              profile_id: app.profile_id ?? null,
              resume_file_name: app.resume_file_name ?? null,
              job_description: (app as JobApplication).job_description ?? "",
            }),
          }).then((r) => {
            if (!r.ok) throw new Error("Failed to redo restore application");
            return r.json() as Promise<JobApplication>;
          })
        )
      );
      const newNext = next.map((a) => {
        const i = toRestore.indexOf(a as JobApplication);
        if (i >= 0) return newRows[i];
        return a;
      });
      setApplications(newNext);
      setFuture(rest);
      setHistory((h) => [...h, applications]);
      void fetchDuplicateKeys();
    } catch (e) {
      console.error("Redo (restore to DB) failed:", e);
    }
  }, [future, applications, fetchDuplicateKeys]);

  type AddFormState = {
    date: string;
    company_name: string;
    title: string;
    job_url: string;
    profile_id: string;
    job_description: string;
  };
  const [form, setForm] = useState<AddFormState>({
    date: "",
    company_name: "",
    title: "",
    job_url: "",
    profile_id: currentProfileId ?? "",
    job_description: "",
  });

  const jobDescriptionTokenEstimate = useMemo(() => {
    const jd = form.job_description?.trim() ?? "";
    const parts = [
      aiPrompts?.summary ?? "",
      aiPrompts?.bulletsCurrent ?? "",
      aiPrompts?.bulletsLast ?? "",
      aiPrompts?.skills ?? "",
      jd,
    ];
    const text = parts.join("\n\n").trim();
    if (!text) return 0;
    const chars = text.length;
    return Math.ceil(chars / 4);
  }, [form.job_description, aiPrompts]);

  // Persist undo history (real applications only, max 10) for restore on refresh
  useEffect(() => {
    if (typeof window === "undefined" || history.length === 0) return;
    try {
      const toSave = history
        .slice(-UNDO_LIMIT)
        .map((state) => state.filter((a) => !isPlaceholder(a)) as JobApplication[]);
      localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(toSave));
    } catch {
      // ignore
    }
  }, [history]);

  const hasRestoredScrollAndSelectionRef = useRef(false);
  const applicationsLengthRef = useRef(0);
  useEffect(() => {
    applicationsLengthRef.current = applications.length;
  }, [applications.length]);

  // Reset scroll restore when profile changes so we can scroll to last row after new data loads
  useEffect(() => {
    hasRestoredScrollAndSelectionRef.current = false;
    if (typeof window !== "undefined" && effectiveProfileFilterId) {
      try {
        sessionStorage.removeItem(SCROLL_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, [effectiveProfileFilterId]);

  // Restore scroll position and selection after load, or scroll to last row when no saved position
  useEffect(() => {
    if (loading) return;
    if (hasRestoredScrollAndSelectionRef.current) return;
    const id = requestAnimationFrame(() => {
      try {
        hasRestoredScrollAndSelectionRef.current = true;
        const el = scrollRef.current;
        const outerEl = outerScrollRef.current;
        const raw = typeof window !== "undefined" ? sessionStorage.getItem(SCROLL_STORAGE_KEY) : null;
        if (raw) {
          const parsed = JSON.parse(raw) as {
            scrollTop?: number;
            scrollLeft?: number;
            selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number };
          };
          const { scrollTop = 0, scrollLeft = 0, selectedRange: savedRange } = parsed;
          if (el && scrollTop > 0) el.scrollTop = scrollTop;
          if (outerEl && scrollLeft > 0) outerEl.scrollLeft = scrollLeft;
          const maxRow = Math.max(1, applicationsLengthRef.current);
          const maxCol = 5;
          if (
            savedRange &&
            typeof savedRange.startRow === "number" &&
            typeof savedRange.startCol === "number" &&
            typeof savedRange.endRow === "number" &&
            typeof savedRange.endCol === "number" &&
            savedRange.startRow >= 1 &&
            savedRange.endRow >= 1 &&
            savedRange.startRow <= maxRow &&
            savedRange.endRow <= maxRow &&
            savedRange.startCol >= 0 &&
            savedRange.endCol >= 0 &&
            savedRange.startCol <= maxCol &&
            savedRange.endCol <= maxCol
          ) {
            const range = {
              startRow: savedRange.startRow,
              startCol: savedRange.startCol,
              endRow: savedRange.endRow,
              endCol: savedRange.endCol,
            };
            setSelectedRange(range);
            const anchorRow = Math.min(savedRange.startRow, savedRange.endRow);
            const anchorCol = Math.min(savedRange.startCol, savedRange.endCol);
            selectionAnchorRef.current = { row: anchorRow, col: anchorCol };
          }
        } else if (el && applications.length > 0) {
          // No saved scroll: show last row that has content (ignore trailing empty rows)
          const hasContent = (a: JobApplication) =>
            ((a.company_name ?? "").trim() !== "" ||
              (a.title ?? "").trim() !== "" ||
              (a.job_url ?? "").trim() !== "") &&
            !isPlaceholder(a);
          let lastContentRow = 0;
          for (let i = applications.length - 1; i >= 0; i--) {
            const item = applications[i];
            if (item && hasContent(item)) {
              lastContentRow = i + 1;
              break;
            }
          }
          if (lastContentRow >= 1) {
            const cell = el.querySelector(`[data-row="${lastContentRow}"]`);
            const row = cell?.closest?.("tr");
            if (row) row.scrollIntoView({ block: "end", behavior: "auto" });
          }
        }
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(id);
  }, [loading, applications]);

  // Load modal resume from API when modal opens; use application's profile when applying, else current.
  useEffect(() => {
    if (!addOpen) {
      setModalResumeData(null);
      setModalResumeDataId(null);
      setPdfError(null);
      setModalContentVersion(0);
      setApplyApplication(null);
      return;
    }
    const profileId = applyApplication?.profile_id ?? currentProfileId;
    if (!profileId) {
      setModalResumeData(defaultResumeData);
      setModalResumeDataId(null);
      return;
    }
    let cancelled = false;
    setModalDataLoading(true);
    fetch(`/api/profiles/${profileId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to fetch"))))
      .then((body: { data: ResumeData }) => {
        if (cancelled) return;
        const loaded = body.data ?? defaultResumeData;
        const withContentCleared: ResumeData = {
          ...loaded,
          profile: { ...loaded.profile, summary: "" },
          skills: [],
          experience: (loaded.experience ?? []).map((exp: Experience) => {
            const staticContent =
              exp.useStaticBullets && (exp.staticBulletContent ?? "").trim()
                ? (exp.staticBulletContent ?? "").trim()
                : "";
            return { ...exp, description: staticContent || "" };
          }),
        };
        setModalResumeData(withContentCleared);
        setModalResumeDataId(profileId);
        try {
          const p = withContentCleared.profile;
          const locationParts = [p.city, p.state, p.postalCode]
            .map((x) => (x || "").trim())
            .filter(Boolean);
          const location = locationParts.join(", ");
          const companyName = (form.company_name || "").trim();
          const summaryPayload = {
            id: profileId,
            profileName: p.name || "",
            title: p.title || "",
            email: p.email || "",
            phone: p.phone || "",
            location,
            company: companyName,
            updatedAt: Date.now(),
          };
          window.localStorage.setItem(
            "desktop-profile-flyout-current-profile",
            JSON.stringify(summaryPayload)
          );
          const electron = (window as unknown as { electron?: { setProfileFlyoutSummary?: (s: unknown) => void } }).electron;
          if (electron?.setProfileFlyoutSummary) {
            try {
              electron.setProfileFlyoutSummary(summaryPayload);
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore storage errors
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModalResumeData(defaultResumeData);
          setModalResumeDataId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setModalDataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addOpen, currentProfileId, applyApplication?.profile_id]);

  // When resume data for the modal is loaded, default the job title from the
  // first experience's role (if any). This uses the role on each experience,
  // not the overall resume profile title.
  useEffect(() => {
    if (!addOpen || !modalResumeData) return;
    setForm((prev) => {
      if (prev.title && prev.title.trim().length > 0) return prev;
      const firstRole = modalResumeData.experience?.[0]?.role?.trim();
      if (!firstRole) return prev;
      return {
        ...prev,
        title: firstRole,
      };
    });
  }, [addOpen, modalResumeData]);

  // Revoke PDF blob URL when modal closes.
  useEffect(() => {
    if (!addOpen && pdfPreviewUrl) {
      URL.revokeObjectURL(pdfPreviewUrl);
      setPdfPreviewUrl(null);
    }
  }, [addOpen, pdfPreviewUrl]);

  const PDF_DEBOUNCE_MS = 200;
  const pdfRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  pdfPreviewUrlRef.current = pdfPreviewUrl;
  const pdfRefreshSeqRef = useRef(0);

  const runPdfRefresh = useCallback(async () => {
    const dataToFetch = modalResumeDataRef.current;
    if (!dataToFetch) return;
    // Normalize skills for PDF: split any "A, B, C" name into individual skills so preview shows one square per tech.
    const rawSkills = dataToFetch.skills ?? [];
    const normalizedSkills: { id: string; name: string; category?: string }[] = [];
    let id = 0;
    for (const s of rawSkills) {
      const category = (s.category || "").trim() || "Other";
      const names = (s.name || "").split(",").map((n: string) => n.trim()).filter(Boolean);
      for (const name of names) {
        normalizedSkills.push({ id: `skill-pdf-${id++}`, name, category });
      }
    }
    // Load the current template's style so changes from the template style editor
    // (data/template-styles/*.json) are reflected in application PDFs.
    let style = APPLICATION_RESUME_STYLE;
    const formatId = applicationModalFormatIdRef.current;
    try {
      const res = await fetch(`/api/templates/${formatId}/style`);
      if (res.ok) {
        const json = await res.json();
        style = json as typeof APPLICATION_RESUME_STYLE;
      }
    } catch {
      // Ignore and fall back to APPLICATION_RESUME_STYLE.
    }
    const dataToSend: StoredProfileData = {
      ...dataToFetch,
      skills: normalizedSkills,
      style,
    };
    const prevUrl = pdfPreviewUrlRef.current;
    const mySeq = ++pdfRefreshSeqRef.current;
    try {
      setPdfError(null);
      setDownloadingPdf(true);
      const templateId = formatIdToTemplateId(applicationModalFormatIdRef.current);
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: dataToSend, templateId: templateId ?? undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "PDF generation failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // If another refresh started after us, discard this response.
      if (mySeq !== pdfRefreshSeqRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      setPdfPreviewUrl(url);
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    } catch (e) {
      // Keep existing PDF on screen; just show error.
      const msg = e instanceof Error ? e.message : "PDF refresh failed";
      setPdfError(msg);
      console.error("PDF refresh failed:", e);
    } finally {
      setDownloadingPdf(false);
    }
  }, []);

  const schedulePdfRefreshRef = useRef<() => void>(() => {});
  schedulePdfRefreshRef.current = () => {
    if (!addOpen) return;
    if (pdfRefreshTimeoutRef.current) clearTimeout(pdfRefreshTimeoutRef.current);
    pdfRefreshTimeoutRef.current = setTimeout(() => {
      pdfRefreshTimeoutRef.current = null;
      runPdfRefresh();
    }, PDF_DEBOUNCE_MS);
  };
  /** Run PDF refresh immediately (e.g. when template/style changes). */
  const runPdfRefreshNowRef = useRef<() => void>(() => {});
  runPdfRefreshNowRef.current = () => {
    if (!addOpen) return;
    if (pdfRefreshTimeoutRef.current) {
      clearTimeout(pdfRefreshTimeoutRef.current);
      pdfRefreshTimeoutRef.current = null;
    }
    runPdfRefresh();
  };

  // When resume content changes (version bump), schedule refresh (effect path).
  useEffect(() => {
    if (!addOpen || modalContentVersion === 0) return;
    schedulePdfRefreshRef.current();
  }, [addOpen, modalContentVersion]);

  useEffect(() => {
    if (!addOpen) return;
    const nextFormatId = getJobApplicationFormatId(applyApplication);
    if (applicationModalFormatIdRef.current === nextFormatId) return;
    setApplicationModalFormatId(nextFormatId);
    applicationModalFormatIdRef.current = nextFormatId;
  }, [addOpen, applyApplication?.id, applyApplication?.resume_format_id]);

  // Auto-generate PDF when modal data finishes loading (no "View PDF" click needed).
  useEffect(() => {
    if (!addOpen) return;
    if (modalDataLoading) return;
    if (!modalResumeDataRef.current) return;
    schedulePdfRefreshRef.current();
  }, [addOpen, modalDataLoading, modalResumeDataId]);

  // When Apply modal opens, move focus to summary or first bullet area after content is ready.
  useEffect(() => {
    if (!addOpen || !applyApplication || modalDataLoading) return;
    const t = setTimeout(() => {
      const el = applyModalContentRef.current;
      const textarea = el?.querySelector("textarea");
      if (textarea) {
        textarea.focus();
      }
    }, 100);
    return () => clearTimeout(t);
  }, [addOpen, applyApplication, modalDataLoading]);

  const profileName = (profileId: string | null) => {
    if (!profileId) return "";
    return profiles.find((p: ProfileMeta) => p.id === profileId)?.name ?? "";
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasCompany = form.company_name.trim() !== "";
    const hasJobLink = form.job_url.trim() !== "";
    if (!hasCompany && !hasJobLink) return;
    const appId = applyApplication?.id;
    try {
      if (appId) {
        setApplications((prev) => {
          pushHistory(prev);
          return prev;
        });
        const res = await fetch(`/api/job-applications/${appId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: new Date().toISOString().slice(0, 10),
            company_name: form.company_name.trim(),
            title: form.title.trim(),
            job_url: form.job_url.trim() || null,
            profile_id: form.profile_id || null,
            resume_format_id: applicationModalFormatIdRef.current,
            job_description: form.job_description?.trim() ?? "",
            applied_manually: true,
          }),
        });
        if (res.ok) {
          const updated = (await res.json()) as JobApplication;
          if (pdfPreviewUrl) {
            try {
              const pdfRes = await fetch(pdfPreviewUrl);
              const blob = await pdfRes.blob();
              await fetch(`/api/job-applications/${appId}/pdf`, {
                method: "POST",
                headers: { "Content-Type": "application/pdf" },
                body: blob,
              });
            } catch (err) {
              console.error("Failed to save application PDF:", err);
            }
          }
          const toMerge = pdfPreviewUrl
            ? await fetch(`/api/job-applications/${appId}`).then((r) => (r.ok ? r.json() : updated)).catch(() => updated)
            : updated;
          if (pendingGptChatUrl) {
            saveGptChatUrlForApp(appId, pendingGptChatUrl);
            setPendingGptChatUrl(null);
          }
          setApplications((prev) =>
            prev.map((a) => (a.id === appId ? { ...a, ...toMerge } : a))
          );
          pdfBlobCacheRef.current.delete(appId);
          pdfBufferCacheRef.current.delete(appId);
          setAddOpen(false);
          setApplyApplication(null);
          setForm({
            date: "",
            company_name: "",
            title: "",
            job_url: "",
            profile_id: currentProfileId ?? "",
            job_description: "",
          });
          void fetchDuplicateKeys();
        }
      } else {
        setApplications((prev) => {
          pushHistory(prev);
          return prev;
        });
        const res = await fetch("/api/job-applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: form.date || "",
            company_name: form.company_name.trim(),
            title: form.title.trim(),
            job_url: form.job_url.trim() || null,
            profile_id: form.profile_id || currentProfileId || null,
            resume_format_id: applicationModalFormatIdRef.current,
            job_description: form.job_description?.trim() ?? "",
          }),
        });
        if (res.ok) {
          const row = (await res.json()) as JobApplication;
          if (pdfPreviewUrl) {
            try {
              const pdfRes = await fetch(pdfPreviewUrl);
              const blob = await pdfRes.blob();
              await fetch(`/api/job-applications/${row.id}/pdf`, {
                method: "POST",
                headers: { "Content-Type": "application/pdf" },
                body: blob,
              });
            } catch (err) {
              console.error("Failed to save application PDF:", err);
            }
          }
          const toShow = pdfPreviewUrl
            ? (await fetch(`/api/job-applications/${row.id}`).then((r) => (r.ok ? r.json() : row)).catch(() => row)) as JobApplication
            : row;
          if (pendingGptChatUrl) {
            saveGptChatUrlForApp(row.id, pendingGptChatUrl);
            setPendingGptChatUrl(null);
          }
          setApplications((prev) => [...prev, toShow]);
          setAddOpen(false);
          setForm({
            date: "",
            company_name: "",
            title: "",
            job_url: "",
            profile_id: currentProfileId ?? "",
            job_description: "",
          });
          void fetchDuplicateKeys();
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const showAddMoreButton = emptyRowCount >= emptyRowLimit;

  type SelectionRange = { startRow: number; startCol: number; endRow: number; endCol: number };
  const [selectedRange, setSelectedRange] = useState<SelectionRange | null>(null);
  const selectedRangeRef = useRef<SelectionRange | null>(null);
  useEffect(() => {
    selectedRangeRef.current = selectedRange;
  }, [selectedRange]);

  type SearchMatch = { row: number; col: number };
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(-1);

  const searchableColumns: ColumnKey[] = ["date", "company", "title", "jobUrl", "resume"];

  const searchMatches = useMemo<SearchMatch[]>(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];

    const matches: SearchMatch[] = [];
    dataRows.forEach((app, index) => {
      if (isPlaceholder(app)) return;
      const row = 1 + index;
      for (const colKey of searchableColumns) {
        let value = "";
        const a = app as JobApplication;
        switch (colKey) {
          case "date":
            value = formatDateForDisplay(a.date ?? "");
            break;
          case "company":
            value = a.company_name ?? "";
            break;
          case "title":
            value = a.title ?? "";
            break;
          case "jobUrl":
            value = a.job_url ?? "";
            break;
          case "resume":
            value = a.resume_file_name ?? "";
            break;
          default:
            value = "";
        }
        if (value && value.toLowerCase().includes(term)) {
          matches.push({ row, col: COLUMN_INDEX[colKey] });
        }
      }
    });
    return matches;
  }, [dataRows, searchTerm, searchableColumns, profileName]);

  useEffect(() => {
    if (!searchTerm.trim() || searchMatches.length === 0) {
      setCurrentMatchIndex(-1);
    } else {
      setCurrentMatchIndex(0);
    }
  }, [searchTerm, searchMatches.length]);
  const anchorRef = useRef<{ row: number; col: number } | null>(null);
  const selectionAnchorRef = useRef<{ row: number; col: number } | null>(null);
  const isSelectingRef = useRef(false);

  /** Colored border on the outer edge and soft background for the selection rectangle (also used for search match). */
  const getSelectionBorderClass = useCallback(
    (row: number, col: number) => {
      if (row === 0) return ""; // header is not selectable
      if (!selectedRange) return "";
      const { startRow, startCol, endRow, endCol } = selectedRange;
      const r0 = Math.min(startRow, endRow);
      const r1 = Math.max(startRow, endRow);
      const c0 = Math.min(startCol, endCol);
      const c1 = Math.max(startCol, endCol);
      if (row < r0 || row > r1 || col < c0 || col > c1) return "";
      const isTop = row === r0;
      const isBottom = row === r1;
      const isLeft = col === c0;
      const isRight = col === c1;
      return [
        "bg-amber-100 border-amber-200",
        isTop && "border-t-amber-500",
        isBottom && "border-b-amber-500",
        isLeft && "border-l-amber-500",
        isRight && "border-r-amber-500",
      ]
        .filter(Boolean)
        .join(" ");
    },
    [selectedRange]
  );

  const getSelectedRowIndices = useCallback(() => {
    if (!selectedRange) return [];
    const r0 = Math.min(selectedRange.startRow, selectedRange.endRow);
    const r1 = Math.max(selectedRange.startRow, selectedRange.endRow);
    const indices: number[] = [];
      for (let r = r0; r <= r1; r++) {
      if (r >= 1 && r <= dataRows.length) indices.push(r - 1);
    }
    return indices;
  }, [selectedRange, dataRows.length]);

  const openProfileDropdown = useCallback(
    (e: React.MouseEvent, clickedRowIndex: number) => {
      e.preventDefault();
      e.stopPropagation();
      const cell = e.currentTarget as HTMLElement;
      const rect = cell.getBoundingClientRect();
      const anchorRow = parseInt(cell.getAttribute("data-row") ?? "", 10);
      const anchorCol = parseInt(cell.getAttribute("data-col") ?? "", 10);
      const indices = getSelectedRowIndices();
      const rowIndices = indices.length > 0 ? indices : [clickedRowIndex];
      setProfileDropdown({
        rowIndices,
        left: rect.left,
        top: rect.bottom,
        anchorRow: Number.isNaN(anchorRow) ? clickedRowIndex + 1 : anchorRow,
        anchorCol: Number.isNaN(anchorCol) ? 5 : anchorCol,
      });
    },
    [getSelectedRowIndices]
  );

  const applyProfileToRows = useCallback(
    async (profileId: string | null) => {
      if (!profileDropdown) return;
      const { rowIndices } = profileDropdown;
      setProfileDropdown(null);
      setApplications((prev) => {
        pushHistory(prev);
        return prev.map((a, idx) =>
          rowIndices.includes(idx) ? { ...a, profile_id: profileId } : a
        );
      });
      const idsToUpdate = rowIndices
        .map((idx) => dataRows[idx])
        .filter((app): app is JobApplication => app != null && !isPlaceholder(app))
        .map((a) => a.id);
      setApplications((prev) =>
        prev.map((a) => (idsToUpdate.includes(a.id) ? { ...a, profile_id: profileId } : a))
      );
      for (const id of idsToUpdate) {
        try {
          await fetch(`/api/job-applications/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile_id: profileId }),
          });
        } catch (err) {
          console.error("Failed to update profile:", err);
        }
      }
      void fetchDuplicateKeys();
    },
    [profileDropdown, dataRows, pushHistory, fetchDuplicateKeys]
  );

  const profileDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!profileDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = profileDropdownRef.current;
      if (el && !el.contains(e.target as Node)) setProfileDropdown(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [profileDropdown]);

  // Reposition profile dropdown when the table scrolls so it follows the anchor cell
  useEffect(() => {
    if (!profileDropdown) return;
    const container = scrollRef.current;
    if (!container) return;
    const updatePosition = () => {
      setProfileDropdown((prev) => {
        if (!prev || prev.anchorRow == null || prev.anchorCol == null) return prev;
        const cell = container.querySelector(
          `td[data-row="${prev.anchorRow}"][data-col="${prev.anchorCol}"], th[data-row="${prev.anchorRow}"][data-col="${prev.anchorCol}"]`
        ) as HTMLElement | null;
        if (!cell) return prev;
        const rect = cell.getBoundingClientRect();
        return { ...prev, left: rect.left, top: rect.bottom };
      });
    };
    container.addEventListener("scroll", updatePosition);
    return () => container.removeEventListener("scroll", updatePosition);
  }, [!!profileDropdown]);

  const getCellFromPoint = useCallback((clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY);
    const cell = el?.closest?.("td[data-row][data-col], th[data-row][data-col]") as HTMLElement | null;
    if (!cell) return null;
    const row = parseInt(cell.getAttribute("data-row") ?? "", 10);
    const col = parseInt(cell.getAttribute("data-col") ?? "", 10);
    if (Number.isNaN(row) || Number.isNaN(col)) return null;
    return { row, col };
  }, []);

  const handleCellMouseDown = useCallback(
    (e: React.MouseEvent, row: number, col: number) => {
      if (row === 0) return; // header is not selectable
      if ((e.target as HTMLElement).closest("button")) return;
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.button === 2) return; // right-click: keep current selection for context menu
      e.preventDefault();
      scrollRef.current?.focus?.();
      const anchor =
        selectionAnchorRef.current ??
        (selectedRangeRef.current
          ? {
              row: Math.min(
                selectedRangeRef.current.startRow,
                selectedRangeRef.current.endRow
              ),
              col: Math.min(
                selectedRangeRef.current.startCol,
                selectedRangeRef.current.endCol
              ),
            }
          : null);
      if (e.shiftKey && anchor) {
        setSelectedRange({
          startRow: Math.min(anchor.row, row),
          startCol: Math.min(anchor.col, col),
          endRow: Math.max(anchor.row, row),
          endCol: Math.max(anchor.col, col),
        });
        isSelectingRef.current = false;
        anchorRef.current = null;
      } else {
        selectionAnchorRef.current = { row, col };
        anchorRef.current = { row, col };
        isSelectingRef.current = true;
        setSelectedRange({ startRow: row, startCol: col, endRow: row, endCol: col });
      }
    },
    []
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelectingRef.current || !anchorRef.current) return;
      const cell = getCellFromPoint(e.clientX, e.clientY);
      if (!cell) return;
      const { row: ar, col: ac } = anchorRef.current;
      setSelectedRange({
        startRow: ar,
        startCol: ac,
        endRow: cell.row,
        endCol: cell.col,
      });
    };
    const handleMouseUp = () => {
      isSelectingRef.current = false;
      anchorRef.current = null;
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [getCellFromPoint]);

  const showEmptyRows = true;
  const maxRow = showEmptyRows
    ? dataRows.length + emptyRowCount + (showAddMoreButton ? 1 : 0)
    : dataRows.length;
  const maxCol = 5;

  const scrollCellIntoView = useCallback((row: number, col: number) => {
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      const outer = outerScrollRef.current;
      if (!container) return;
      const cell = container.querySelector(
        `td[data-row="${row}"][data-col="${col}"], th[data-row="${row}"][data-col="${col}"]`
      ) as HTMLElement | null;
      if (!cell) return;
      const cellRect = cell.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const pad = 8;
      const cellTopInContent = container.scrollTop + (cellRect.top - containerRect.top);
      const cellBottomInContent = cellTopInContent + cellRect.height;
      const visibleBottom = container.scrollTop + container.clientHeight;
      const visibleTop = container.scrollTop;
      if (cellTopInContent < visibleTop) {
        container.scrollTop = Math.max(0, cellTopInContent - pad);
      } else if (cellBottomInContent > visibleBottom) {
        container.scrollTop = cellBottomInContent - container.clientHeight + pad;
      }
      if (outer) {
        const outerRect = outer.getBoundingClientRect();
        const cellLeft = cellRect.left - outerRect.left + outer.scrollLeft;
        const cellRight = cellLeft + cellRect.width;
        if (cellRect.left < outerRect.left) {
          outer.scrollLeft = Math.max(0, cellLeft - pad);
        } else if (cellRect.right > outerRect.right) {
          outer.scrollLeft = cellRight - outer.clientWidth + pad;
        }
      }
    });
  }, []);

  const queueScrollCellIntoView = useCallback(
    (row: number, col: number) => {
      keyboardScrollTargetRef.current = { row, col };
      if (keyboardScrollRafRef.current !== null) return;
      keyboardScrollRafRef.current = requestAnimationFrame(() => {
        keyboardScrollRafRef.current = null;
        const target = keyboardScrollTargetRef.current;
        if (!target) return;
        scrollCellIntoView(target.row, target.col);
      });
    },
    [scrollCellIntoView]
  );

  useEffect(() => {
    if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length) return;
    const match = searchMatches[currentMatchIndex];
    const { row, col } = match;
    if (row < 1 || col < 0) return;
    setSelectedRange({
      startRow: row,
      startCol: col,
      endRow: row,
      endCol: col,
    });
    selectionAnchorRef.current = { row, col };
    queueScrollCellIntoView(row, col);
  }, [currentMatchIndex, searchMatches, queueScrollCellIntoView]);

  const goToNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex((prev) => {
      if (prev < 0 || prev >= searchMatches.length - 1) return 0;
      return prev + 1;
    });
  }, [searchMatches.length]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex((prev) => {
      if (prev <= 0 || prev >= searchMatches.length) return searchMatches.length - 1;
      return prev - 1;
    });
  }, [searchMatches.length]);

  const scrollSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContextMenu((prev) => {
      if (!prev || prev.selectionRows.length === 0) return prev;
      const cell = el.querySelector(`td[data-row="${prev.selectionRows[0]}"]`) as HTMLElement | null;
      if (!cell) return prev;
      const rect = cell.getBoundingClientRect();
      return { ...prev, x: rect.left, y: rect.bottom + 4 };
    });
    const { scrollTop, clientHeight, scrollHeight } = el;
    if (scrollTop + clientHeight >= scrollHeight - 32) {
      loadMoreEmptyRows();
    }
    // Persist scroll position and selection for restore on refresh (throttled)
    if (scrollSaveTimeoutRef.current === null) {
      scrollSaveTimeoutRef.current = setTimeout(() => {
        scrollSaveTimeoutRef.current = null;
        try {
          const outerEl = outerScrollRef.current;
          const payload: { scrollTop: number; scrollLeft: number; selectedRange?: typeof selectedRangeRef.current } = {
            scrollTop: el.scrollTop,
            scrollLeft: outerEl?.scrollLeft ?? 0,
          };
          if (selectedRangeRef.current) {
            payload.selectedRange = selectedRangeRef.current;
          }
          sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(payload));
        } catch {
          // ignore
        }
      }, 150);
    }
  }, [loadMoreEmptyRows]);

  // Ensure an initial selection just below the header after load / reload
  useEffect(() => {
    if (loading) return;
    if (selectedRange) return;
    if (dataRows.length === 0) return;
    const firstRow = 1;
    const firstCol = 0;
    scrollRef.current?.focus?.();
    setSelectedRange({
      startRow: firstRow,
      startCol: firstCol,
      endRow: firstRow,
      endCol: firstCol,
    });
  }, [loading, selectedRange, dataRows.length]);

  const createEmptyRowAt = useCallback(
    async (insertIndex: number, row: number, col: number, colKey: ColumnKey, initialValue: string) => {
      try {
        const profileId = effectiveProfileFilterId || null;
        const res = await fetch("/api/job-applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: "",
            company_name: "",
            title: "",
            job_url: null,
            profile_id: profileId,
            resume_file_name: "",
          }),
        });
        if (!res.ok) return;
        const rowCreated = (await res.json()) as JobApplication;
        setApplications((prev) => {
          pushHistory(prev);
          if (insertIndex <= prev.length) {
            return [
              ...prev.slice(0, insertIndex),
              rowCreated,
              ...prev.slice(insertIndex),
            ];
          }
          const placeholders: RowItem[] = Array.from(
            { length: insertIndex - prev.length },
            (_, i) => ({
              id: `placeholder-${prev.length + i}`,
              date: "",
              company_name: "",
              title: "",
              job_url: null,
              profile_id: profileId,
              resume_file_name: "",
              created_at: "",
              _placeholder: true as const,
            })
          );
          return [...prev, ...placeholders, rowCreated];
        });
        setEditingCell({
          rowIndex: insertIndex,
          key: colKey,
          value: initialValue,
          appId: rowCreated.id,
        });
        setSelectedRange({
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
        });
        queueScrollCellIntoView(row, col);
      } catch (err) {
        console.error("Failed to create empty application row:", err);
      }
    },
    [setApplications, pushHistory, setEditingCell, setSelectedRange, queueScrollCellIntoView, effectiveProfileFilterId]
  );

  const handleTableKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd + F: focus search bar instead of browser find
      if (ctrl && !e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // F3: next match, Shift+F3: previous match
      if (e.key === "F3") {
        e.preventDefault();
        if (e.shiftKey) goToPrevMatch();
        else goToNextMatch();
        return;
      }

      // Copy selected cells to clipboard (TSV) with Ctrl/Cmd + C
      if (ctrl && !e.shiftKey && (e.key === "c" || e.key === "C")) {
        if (!selectedRange) return;
        e.preventDefault();
        const r0 = Math.min(selectedRange.startRow, selectedRange.endRow);
        const r1 = Math.max(selectedRange.startRow, selectedRange.endRow);
        const c0 = Math.min(selectedRange.startCol, selectedRange.endCol);
        const c1 = Math.max(selectedRange.startCol, selectedRange.endCol);
        const lines: string[] = [];
        for (let row = r0; row <= r1; row++) {
          const rowIndex = row - 1;
          const app = row >= 1 && row <= dataRows.length ? dataRows[rowIndex] : null;
          const isRealApp = app && !isPlaceholder(app);
          const cells: string[] = [];
          for (let col = c0; col <= c1; col++) {
            if (!isRealApp) {
              cells.push("");
              continue;
            }
            const a = app as JobApplication;
            switch (col) {
              case 0: {
                cells.push(String(row));
                break;
              }
              case 1: {
                cells.push(formatDateForDisplay(a.date ?? ""));
                break;
              }
              case 2: {
                cells.push(a.company_name ?? "");
                break;
              }
              case 3: {
                cells.push(a.title ?? "");
                break;
              }
              case 4: {
                cells.push(a.job_url ?? "");
                break;
              }
              case 5: {
                cells.push(a.job_description ?? "");
                break;
              }
              case 6: {
                cells.push(a.resume_file_name ?? "");
                break;
              }
              default: {
                cells.push("");
              }
            }
          }
          lines.push(cells.join("\t"));
        }
        const text = lines.join("\n");
        if (text) {
          void writeTextToClipboard(text);
        }
        return;
      }

      // Paste from clipboard with Ctrl/Cmd + V
      if (ctrl && !e.shiftKey && (e.key === "v" || e.key === "V")) {
        // If an inline editor is open, let the browser handle paste into the input.
        if (editingCell) {
          return;
        }
        const startRow = selectedRange?.endRow ?? 1;
        const startCol = selectedRange?.endCol ?? 0;
        const singleCellSelected =
          selectedRange &&
          selectedRange.startRow === selectedRange.endRow &&
          selectedRange.startCol === selectedRange.endCol;
        const colIndex = startCol;

        if (typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function") {
          e.preventDefault();
          navigator.clipboard
            .readText()
            .then((text) => {
              if (!text) return;

              // If exactly one Job description cell is selected, treat the entire text (including newlines)
              // as that single cell's value instead of splitting across multiple rows.
              if (singleCellSelected && colIndex === COLUMN_INDEX.jobDescription) {
                const rowIndex = startRow - 1;
                if (rowIndex >= 0 && rowIndex < dataRows.length) {
                  const app = dataRows[rowIndex];
                  if (app && !isPlaceholder(app)) {
                    const id = (app as JobApplication).id;
                    const patch: Partial<JobApplication> = { job_description: text };
                    setApplications((prev) => {
                      pushHistory(prev);
                      return prev.map((a) => (a.id === id ? { ...a, ...patch } : a));
                    });
                    void fetch(`/api/job-applications/${id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(patch),
                    }).catch((err) => {
                      console.error("Paste job description failed:", err);
                    });
                    return;
                  }
                }
              }

              // Fallback: grid-style paste (multiple rows/columns).
              void handleTablePaste(
                { clipboardData: { getData: () => text }, preventDefault() {} } as unknown as React.ClipboardEvent,
                startRow - 1,
                startCol
              );
            })
            .catch((err) => {
              console.error("Paste from clipboard failed:", err);
            });
        }
        return;
      }

      // Undo / Redo keyboard shortcuts
      if (ctrl && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleUndo();
        return;
      }
      if ((ctrl && (e.key === "y" || e.key === "Y")) || (ctrl && e.shiftKey && (e.key === "z" || e.key === "Z"))) {
        e.preventDefault();
        handleRedo();
        return;
      }

      const current = selectedRange
        ? { row: selectedRange.endRow, col: selectedRange.endCol }
        : null;

      // Typing a printable character starts editing the selected cell (no double-click needed)
      if (!editingCell && current && !ctrl && !e.altKey && !e.metaKey) {
        const isPrintable =
          e.key.length === 1 &&
          e.key !== "Enter" &&
          e.key !== "Escape" &&
          e.key !== "Tab";
        if (isPrintable) {
          const colKey = COLUMN_KEYS[current.col] as ColumnKey;
          if (!EDITABLE_COLUMNS.includes(colKey)) return;

          // Existing data row: just enter edit mode
          if (current.row >= 1 && current.row <= dataRows.length) {
            const app = dataRows[current.row - 1];
            if (app) {
              e.preventDefault();
              startEdit(current.row - 1, colKey, e.key, app.id);
              return;
            }
          }

          // Empty extra row: create a new application row at this position and start editing
          if (showEmptyRows && current.row > dataRows.length && current.row <= dataRows.length + emptyRowCount) {
            e.preventDefault();
            const insertIndex = current.row - 1;
            void createEmptyRowAt(insertIndex, current.row, current.col, colKey, e.key);
            return;
          }
        }
      }

      // Delete / Backspace: clear content of all selected cells (skip applied rows)
      if (!editingCell && selectedRange && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        const r0 = Math.min(selectedRange.startRow, selectedRange.endRow);
        const r1 = Math.max(selectedRange.startRow, selectedRange.endRow);
        const c0 = Math.min(selectedRange.startCol, selectedRange.endCol);
        const c1 = Math.max(selectedRange.startCol, selectedRange.endCol);
        const updatesByAppId = new Map<
          string,
          { rowIndex: number; patch: Partial<JobApplication> }
        >();
        for (let row = r0; row <= r1; row++) {
          if (row < 1 || row > dataRows.length) continue;
          const app = dataRows[row - 1];
          if (!app) continue;
          if (isPlaceholder(app)) continue;
          if (Boolean((app as JobApplication).resume_file_name)) continue; // applied: do not clear via keyboard
          const patch: Partial<JobApplication> = {};
          for (let col = c0; col <= c1; col++) {
            const colKey = COLUMN_KEYS[col] as ColumnKey;
            if (!EDITABLE_COLUMNS.includes(colKey)) continue;
            if (colKey === "date") patch.date = "";
            else if (colKey === "company") patch.company_name = "";
            else if (colKey === "title") patch.title = "";
            else if (colKey === "jobUrl") patch.job_url = null;
            else if (colKey === "jobDescription") patch.job_description = "";
            else if (colKey === "resume") patch.resume_file_name = "";
          }
          if (Object.keys(patch).length > 0) {
            updatesByAppId.set(app.id, { rowIndex: row - 1, patch });
          }
        }
        if (updatesByAppId.size > 0) {
          setApplications((prev) => {
            pushHistory(prev);
            return prev.map((a, idx) => {
              const u = updatesByAppId.get(a.id);
              if (!u || u.rowIndex !== idx) return a;
              return { ...a, ...u.patch };
            });
          });
          (async () => {
            const entries = Array.from(updatesByAppId.entries());
            for (const [id, { patch }] of entries) {
              if (id.startsWith("placeholder-")) continue;
              try {
                await fetch(`/api/job-applications/${id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(patch),
                });
              } catch (err) {
                console.error("Failed to clear cell:", err);
              }
            }
          })();
        }
        return;
      }

      if (!current) {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          const initial = { startRow: 1, startCol: 0, endRow: 1, endCol: 0 };
          setSelectedRange(initial);
          selectionAnchorRef.current = { row: 1, col: 0 };
        }
        return;
      }

      let nextRow = current.row;
      let nextCol = current.col;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (ctrl) nextRow = 1;
        else nextRow = Math.max(1, current.row - 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (ctrl) {
          // Jump to last data/empty row before the optional "Add more" row
          const lastRowBeforeAddMore = maxRow - (showAddMoreButton ? 1 : 0);
          nextRow = lastRowBeforeAddMore;
        } else {
          nextRow = Math.min(maxRow, current.row + 1);
        }
        if (showEmptyRows && nextRow >= 1 + dataRows.length && nextRow >= dataRows.length + emptyRowCount) {
          setEmptyRowCount((prev) => Math.min(emptyRowLimit, Math.max(prev, nextRow - dataRows.length)));
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (ctrl) nextCol = 0;
        else nextCol = Math.max(0, current.col - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (ctrl) nextCol = maxCol;
        else nextCol = Math.min(maxCol, current.col + 1);
      } else {
        return;
      }

      if (e.shiftKey) {
        // Extend selection from anchor to (nextRow, nextCol); keep anchor unchanged
        const anchor =
          selectionAnchorRef.current ??
          (selectedRange
            ? {
                row: Math.min(selectedRange.startRow, selectedRange.endRow),
                col: Math.min(selectedRange.startCol, selectedRange.endCol),
              }
            : null);
        if (anchor) {
          setSelectedRange({
            startRow: Math.min(anchor.row, nextRow),
            startCol: Math.min(anchor.col, nextCol),
            endRow: Math.max(anchor.row, nextRow),
            endCol: Math.max(anchor.col, nextCol),
          });
        } else {
          setSelectedRange({ startRow: nextRow, startCol: nextCol, endRow: nextRow, endCol: nextCol });
          selectionAnchorRef.current = { row: nextRow, col: nextCol };
        }
      } else {
        setSelectedRange({ startRow: nextRow, startCol: nextCol, endRow: nextRow, endCol: nextCol });
        selectionAnchorRef.current = { row: nextRow, col: nextCol };
      }
      queueScrollCellIntoView(nextRow, nextCol);
    },
    [
      selectedRange,
      editingCell,
      applications,
      startEdit,
      maxRow,
      maxCol,
      queueScrollCellIntoView,
      applications.length,
      emptyRowCount,
      emptyRowLimit,
      handleUndo,
      handleRedo,
      showAddMoreButton,
      goToNextMatch,
      goToPrevMatch,
      dataRows,
      dataRows.length,
      showEmptyRows,
    ]
  );

  const handleDeleteSelectedRows = useCallback(
    async (selectionRows: number[]) => {
      const idsToDelete = selectionRows
        .map((r) => dataRows[r - 1])
        .filter((app): app is JobApplication => app != null && !isPlaceholder(app))
        .map((a) => a.id);
      if (idsToDelete.length === 0) return;
      setApplications((prev) => {
        pushHistory(prev);
        const idSet = new Set(idsToDelete);
        return prev.filter((a) => !idSet.has(a.id));
      });
      try {
        const results = await Promise.all(
          idsToDelete.map((id) =>
            fetch(`/api/job-applications/${id}`, { method: "DELETE" })
          )
        );
        if (results.some((r) => !r.ok)) {
          fetchApplications(effectiveProfileFilterId);
          toast.error("Delete failed");
        } else {
          void fetchDuplicateKeys();
          toast.success(`Deleted ${idsToDelete.length} row(s)`);
        }
      } catch (e) {
        console.error(e);
        fetchApplications(effectiveProfileFilterId);
        toast.error("Delete failed");
      }
    },
    [dataRows, pushHistory, fetchDuplicateKeys, effectiveProfileFilterId, fetchApplications]
  );

  const handleTablePaste = useCallback(
    async (e: React.ClipboardEvent, startRowIndex: number, startColIndex: number) => {
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const lines = text.split(/\r?\n/).map((line) => line.split(/\t/));
      if (!lines.length) return;

      const today = new Date().toISOString().slice(0, 10);
      const patchesByRow = new Map<number, Partial<JobApplication>>();

      for (let r = 0; r < lines.length; r++) {
        const rowIndex = startRowIndex + r;
        const cells = lines[r];
        for (let c = 0; c < cells.length; c++) {
          const tableCol = startColIndex + c;
          const value = (cells[c] ?? "").trim();
          if (tableCol === 0 || tableCol === 1) continue;
          if (tableCol === 2) {
            const patch = patchesByRow.get(rowIndex) ?? {};
            patch.company_name = value;
            patchesByRow.set(rowIndex, patch);
          } else if (tableCol === 3) {
            const patch = patchesByRow.get(rowIndex) ?? {};
            patch.title = value;
            patchesByRow.set(rowIndex, patch);
          } else if (tableCol === 4) {
            const patch = patchesByRow.get(rowIndex) ?? {};
            patch.job_url = value || null;
            patchesByRow.set(rowIndex, patch);
          } else if (tableCol === 5) {
            const patch = patchesByRow.get(rowIndex) ?? {};
            patch.job_description = value;
            patchesByRow.set(rowIndex, patch);
          } else if (tableCol === 6) {
            const patch = patchesByRow.get(rowIndex) ?? {};
            patch.resume_file_name = value;
            patchesByRow.set(rowIndex, patch);
          }
        }
      }

      const rowIndices = Array.from(patchesByRow.keys()).sort((a, b) => a - b);
      if (!rowIndices.length) return;

      setApplications((prev) => {
        pushHistory(prev);
        return prev;
      });

      let updated: RowItem[] = [...applications];
      for (const rowIndex of rowIndices) {
        const patch = patchesByRow.get(rowIndex)!;
        if (rowIndex < dataRows.length) {
          const app = dataRows[rowIndex];
          if (app && !isPlaceholder(app)) {
            const id = (app as JobApplication).id;
            updated = updated.map((a) => (a.id === id ? { ...a, ...patch } : a));
            try {
              await fetch(`/api/job-applications/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
              });
            } catch (err) {
              console.error("Paste PATCH failed:", err);
            }
          }
        } else if (showEmptyRows) {
          const fullPatch = {
            date: patch.date ?? "",
            company_name: patch.company_name ?? "",
            title: patch.title ?? "",
            job_url: patch.job_url ?? null,
            resume_file_name: patch.resume_file_name ?? "",
          };
          while (updated.length < rowIndex) {
            updated.push({
              id: `placeholder-${updated.length}`,
              date: "",
              company_name: "",
              title: "",
              job_url: null,
              profile_id: null,
              resume_file_name: "",
              created_at: "",
              _placeholder: true as const,
            });
          }
          try {
            const profileId = effectiveProfileFilterId || null;
            const res = await fetch("/api/job-applications", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...fullPatch,
                profile_id: profileId,
              }),
            });
            if (res.ok) {
              const row = (await res.json()) as JobApplication;
              updated.push(row);
            }
          } catch (err) {
            console.error("Paste POST failed:", err);
          }
        }
      }
      setApplications(updated);
      void fetchDuplicateKeys();
      if (rowIndices.length > 0) toast.success(`Pasted ${rowIndices.length} row(s)`);
    },
    [applications, pushHistory, dataRows, showEmptyRows, fetchDuplicateKeys, effectiveProfileFilterId]
  );

  const handleBulkGptGenerate = useCallback(
    async () => {
      if (bulkEligibleApps.length === 0 || !aiPrompts) return;
      // If already running, treat click as a stop request.
      if (bulkGptRunning) {
        setBulkCancelRequested(true);
        bulkCancelRef.current = true;
        return;
      }
      setBulkCancelRequested(false);
      bulkCancelRef.current = false;
      setBulkGptRunning(true);
      setBulkGptProgress({ done: 0, total: bulkEligibleApps.length });
      setBulkInProgressIds(new Set());
      let successCount = 0;
      let processedCount = 0;
      for (let i = 0; i < bulkEligibleApps.length; i++) {
        if (bulkCancelRef.current) break;
        const app = bulkEligibleApps[i]!;
        setBulkInProgressIds((prev) => {
          const next = new Set(prev);
          next.add(app.id);
          return next;
        });
        try {
          const stored = await runGptPipelineForApplication(app);
          if (!stored) continue;
          const templateId = formatIdToTemplateId(getJobApplicationFormatId(app));
          const pdfRes = await fetch("/api/pdf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: stored, templateId: templateId ?? undefined }),
          });
          if (!pdfRes.ok) continue;
          const blob = await pdfRes.blob();
          const uploadRes = await fetch(`/api/job-applications/${app.id}/pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/pdf" },
            body: blob,
          });
          if (!uploadRes.ok) continue;
          // Reload row so resume_file_name and gpt_chat_url are up to date.
          try {
            const rowRes = await fetch(`/api/job-applications/${app.id}`);
            if (rowRes.ok) {
              const updated = (await rowRes.json()) as JobApplication;
              setApplications((prev) =>
                prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
              );
            }
          } catch {
            // ignore row reload errors
          }
          successCount += 1;
        } catch (err) {
          console.error("Bulk GPT generation failed for app", app.id, err);
        } finally {
          processedCount += 1;
          setBulkInProgressIds((prev) => {
            const next = new Set(prev);
            next.delete(app.id);
            return next;
          });
          setBulkGptProgress({ done: processedCount, total: bulkEligibleApps.length });
        }
      }
      setBulkGptRunning(false);
      setBulkCancelRequested(false);
      bulkCancelRef.current = false;
      setBulkInProgressIds(new Set());
      if (successCount === 0) {
        toast.error("Bulk GPT generation failed for all rows");
      } else if (processedCount < bulkEligibleApps.length) {
        toast.success(`Bulk generation stopped after ${successCount} of ${bulkEligibleApps.length} resumes`);
      } else if (successCount < bulkEligibleApps.length) {
        toast.success(`Generated ${successCount} of ${bulkEligibleApps.length} resumes`);
      } else {
        toast.success(`Generated ${successCount} resumes`);
      }
      void fetchDuplicateKeys();
    },
    [
      aiPrompts,
      bulkEligibleApps,
      bulkGptRunning,
      bulkCancelRequested,
      runGptPipelineForApplication,
      setApplications,
      fetchDuplicateKeys,
    ]
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-col min-h-0 flex-1 min-w-0 overflow-hidden container mx-auto px-4 py-4">
      <Card className="rounded-none border-0 shadow-none flex-1 flex flex-col min-h-0 overflow-hidden">
        <CardContent className="flex-1 flex flex-col min-h-0 overflow-hidden p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
              <p className="text-sm">Loading applications…</p>
            </div>
          ) : (
            <>
              <div className="flex-shrink-0 flex flex-wrap items-center gap-6 pb-3 text-sm text-muted-foreground">
                <span>Total: <strong className="text-foreground font-semibold">{tableStats.total}</strong></span>
                <span>Today: <strong className="text-foreground font-semibold">{tableStats.todayCount}</strong></span>
                <span>Available: <strong className="text-foreground font-semibold">{tableStats.available}</strong></span>
              </div>
              <div className="flex-shrink-0 flex flex-wrap items-center gap-3 pb-3 text-xs items-center">
                <span className="text-muted-foreground min-w-[80px]">
                  {searchTerm.trim()
                    ? `${searchMatches.length} result${searchMatches.length === 1 ? "" : "s"}`
                    : "Search"}
                </span>
                <Input
                  ref={searchInputRef}
                  className="h-7 w-56 text-xs"
                  placeholder="Search in table…"
                  value={searchTerm}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === "F3") {
                      e.preventDefault();
                      if (e.shiftKey) goToPrevMatch();
                      else goToNextMatch();
                      scrollRef.current?.focus();
                    }
                  }}
                />
                <div
                  className={cn(
                    "flex flex-col h-7 w-6 rounded border border-input overflow-hidden bg-background [&_button]:rounded-none [&_button]:flex-1 [&_button]:min-h-0",
                    searchMatches.length === 0 && "opacity-50"
                  )}
                  aria-label="Search match navigation"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-1/2 w-full shrink-0"
                    onClick={goToPrevMatch}
                    disabled={searchMatches.length === 0}
                    aria-label="Previous match"
                  >
                    <ChevronUp className="h-2.5 w-2.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-1/2 w-full shrink-0 border-t border-border"
                    onClick={goToNextMatch}
                    disabled={searchMatches.length === 0}
                    aria-label="Next match"
                  >
                    <ChevronDown className="h-2.5 w-2.5" />
                  </Button>
                </div>
                {user?.role !== "user" && (
                  <>
                    <span className="text-xs text-muted-foreground shrink-0">Profile:</span>
                    <select
                      className="h-7 text-xs border border-input rounded px-2 bg-background"
                      value={effectiveProfileFilterId}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                        const id = e.target.value;
                        setProfileFilterId(id);
                        if (typeof window !== "undefined") sessionStorage.setItem(PROFILE_FILTER_STORAGE_KEY, id);
                      }}
                      aria-label="View table by profile"
                    >
                      {profiles.map((p: ProfileMeta) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Resume style:</span>
                  <select
                    className="h-7 text-xs border border-input rounded px-2 bg-background"
                    value={applicationModalFormatId}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                      const id = e.target.value as FormatId;
                      setApplicationModalFormatId(id);
                      applicationModalFormatIdRef.current = id;
                      try {
                        localStorage.setItem(APPLICATION_MODAL_TEMPLATE_KEY, id);
                      } catch {}
                    }}
                    aria-label="Resume style for bulk generation"
                  >
                    {FORMAT_LIST.map((f: { formatId: FormatId; name: string }) => (
                      <option key={f.formatId} value={f.formatId}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {bulkGptRunning && (
                    <span className="text-[11px] text-muted-foreground">
                      Generating {bulkGptProgress.done}/{bulkGptProgress.total}
                    </span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={bulkGptRunning ? "destructive" : "outline"}
                    className="h-7 px-2 text-[11px]"
                    disabled={
                      !aiPrompts || (!bulkGptRunning && bulkEligibleApps.length === 0)
                    }
                    onClick={handleBulkGptGenerate}
                  >
                    {bulkGptRunning ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        Stop
                      </>
                    ) : (
                      `Bulk generate (${bulkEligibleApps.length})`
                    )}
                  </Button>
                </div>
              </div>
              {effectiveProfileFilterId && dataRows.length === 0 && (
                <div className="flex-shrink-0 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                  No applications for this profile yet. Double-click any cell in the empty rows below to add one, or paste from clipboard.
                </div>
              )}
              <div
                ref={outerScrollRef}
                className="flex flex-col flex-1 min-h-0 m-0 w-full min-w-0 max-w-full overflow-x-auto overflow-y-hidden outline-none focus:outline-none"
              >
              <div
                className="flex flex-col flex-1 min-h-0"
                style={{ width: totalTableWidth, minWidth: totalTableWidth }}
              >
                <div className="flex-shrink-0 overflow-hidden" style={{ width: totalTableWidth }}>
                  <table
                    className="job-applications-table border-collapse table-fixed text-sm caption-bottom select-none"
                    style={{ width: totalTableWidth }}
                  >
                    <colgroup>
                      {COLUMN_KEYS.map((key) => (
                        <col key={key} style={{ width: columnWidths[key], minWidth: columnWidths[key] }} />
                      ))}
                    </colgroup>
                    <TableHeader>
                    <TableRow className="border-b border-border text-xs select-none bg-muted/80 backdrop-blur-[2px]">
                      {(
                        [
                          ["No", "no"] as const,
                          ["Date", "date"] as const,
                          ["Company", "company"] as const,
                          ["Title", "title"] as const,
                          ["Job URL", "jobUrl"] as const,
                          ["Job description", "jobDescription"] as const,
                          ["Resume file", "resume"] as const,
                          ["Applied", "applied"] as const,
                        ] satisfies readonly [string, ColumnKey][]
                      ).map(([label, key], col) => (
                        <TableHead
                          key={key}
                          className={cn(
                            "border border-border bg-muted/80 backdrop-blur-[2px] px-2 py-0.5 font-medium shadow-[0_1px_0_0_hsl(var(--border))]",
                            col === 0 && "w-14 text-right tabular-nums text-muted-foreground",
                            (key === "resume" || key === "applied") && "text-center"
                          )}
                          style={{
                            width: columnWidths[key],
                            minWidth: columnWidths[key],
                            maxWidth: 480,
                            position: "relative",
                            userSelect: "none",
                          }}
                        >
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="truncate">{label}</span>
                          </div>
                          <span
                            onMouseDown={(e) => handleColumnResizeMouseDown(e, key)}
                            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize rounded-sm bg-border hover:bg-primary/60 active:bg-primary"
                            aria-hidden
                          />
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                </table>
              </div>
              <div
                ref={scrollRef}
                role="grid"
                tabIndex={0}
                aria-label="Job applications table"
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden outline-none focus:outline-none"
                onScroll={handleScroll}
                onKeyDown={handleTableKeyDown}
                onPaste={(e) => {
                  // If we're editing a cell (inline input), let the browser handle paste normally.
                  if (editingCell) return;
                  const startRow = selectedRange?.endRow ?? 1;
                  const startCol = selectedRange?.endCol ?? 0;
                  handleTablePaste(e, startRow - 1, startCol);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();

                  // If right-click happens outside the current selection, move the selection
                  // to the cell under the mouse before opening the context menu.
                  let effectiveRange = selectedRangeRef.current;
                  const hit = getCellFromPoint(e.clientX, e.clientY);
                  if (hit && hit.row > 0) {
                    const { row, col } = hit;
                    const inExistingRange =
                      effectiveRange &&
                      row >= Math.min(effectiveRange.startRow, effectiveRange.endRow) &&
                      row <= Math.max(effectiveRange.startRow, effectiveRange.endRow) &&
                      col >= Math.min(effectiveRange.startCol, effectiveRange.endCol) &&
                      col <= Math.max(effectiveRange.startCol, effectiveRange.endCol);

                    if (!inExistingRange) {
                      effectiveRange = {
                        startRow: row,
                        startCol: col,
                        endRow: row,
                        endCol: col,
                      };
                      setSelectedRange(effectiveRange);
                    }
                  }

                  let selectionRows: number[] = [];
                  if (effectiveRange) {
                    const { startRow, endRow } = effectiveRange;
                    const r0 = Math.max(1, Math.min(startRow, endRow));
                    const r1 = Math.min(dataRows.length, Math.max(startRow, endRow));
                    for (let r = r0; r <= r1; r++) selectionRows.push(r);
                  }

                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    row: selectionRows.length > 0 ? selectionRows[0]! : null,
                    selectionRows,
                  });
                }}
              >
                <table
                  className="job-applications-table border-collapse table-fixed text-sm caption-bottom select-none"
                  style={{ width: totalTableWidth, minWidth: totalTableWidth }}
                >
                  <colgroup>
                    {COLUMN_KEYS.map((key) => (
                      <col key={key} style={{ width: columnWidths[key], minWidth: columnWidths[key] }} />
                    ))}
                  </colgroup>
                  <TableBody>
                  {dataRows.map((app, index) => {
                    const row = 1 + index;
                    const isRealApp = !isPlaceholder(app);
                    const appProfileId = isRealApp ? (app as JobApplication).profile_id : null;
                    const appCompanyName = isRealApp ? (app as JobApplication).company_name ?? "" : "";
                    const normCompany = appCompanyName
                      ? normalizeCompanyForDuplicateKey(appCompanyName)
                      : "";
                    const duplicateKey =
                      appProfileId && normCompany
                        ? `${appProfileId}::${normCompany}`
                        : null;
                    const isDuplicate = Boolean(duplicateKey && duplicateApplicationKeys.has(duplicateKey));
                    const isEditing = (key: ColumnKey) =>
                      editingCell && editingCell.rowIndex === index && editingCell.key === key;
                    const renderInput = (_key: ColumnKey, placeholder?: string) => (
                      <div className="absolute inset-0 flex h-6 min-h-6 max-h-6 items-stretch">
                        <input
                          autoFocus
                          className="min-h-0 flex-1 w-full bg-background text-xs outline-none border-none px-2 py-0.5 box-border"
                          value={editingCell?.value ?? ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setEditingCell((prev) =>
                              prev ? { ...prev, value: e.target.value } : prev
                            )
                          }
                          onBlur={() => {
                            void commitEdit();
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void commitEdit();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingCell(null);
                            }
                          }}
                          placeholder={placeholder}
                        />
                      </div>
                    );
                    const renderCellDisplay = (
                      value: string | null,
                      opts?: { asLink?: boolean; href?: string | null }
                    ) => {
                      const text = value ?? "";
                      if (opts?.asLink && opts?.href) {
                        return (
                          <a
                            href={opts.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline block truncate"
                            title={text}
                            onClick={(e) => e.preventDefault()}
                          >
                            {text}
                          </a>
                        );
                      }
                      return (
                        <span className="block truncate" title={text || undefined}>
                          {text}
                        </span>
                      );
                    };
                    return (
                      <TableRow
                        key={app.id}
                        className={cn(
                          "border-b border-border text-xs [&_td]:h-6 [&_td]:max-h-6 [&_td]:leading-tight [&_td]:align-middle [&_td]:overflow-hidden",
                          isDuplicate && "bg-red-200 border-l-2 border-red-500"
                        )}
                        style={{ height: 24, minHeight: 24, maxHeight: 24 }}
                      >
                        <TableCell
                          data-row={row}
                          data-col={0}
                          className={cn(
                            "border border-border px-2 py-0.5 whitespace-nowrap text-right tabular-nums font-medium text-muted-foreground",
                            getSelectionBorderClass(row, 0)
                          )}
                          style={{ width: columnWidths.no, minWidth: columnWidths.no, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 0)}
                        >
                          {index + 1}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={1}
                          className={cn(
                            "relative border border-border px-2 py-0.5 whitespace-nowrap",
                            getSelectionBorderClass(row, 1)
                          )}
                          style={{ width: columnWidths.date, minWidth: columnWidths.date, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 1)}
                          onDoubleClick={() => startEdit(index, "date", app.date, app.id)}
                        >
                          {isEditing("date") ? renderInput("date") : renderCellDisplay(formatDateForDisplay(app.date))}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={2}
                          className={cn(
                            "relative border border-border px-2 py-0.5",
                            getSelectionBorderClass(row, 2)
                          )}
                          style={{ width: columnWidths.company, minWidth: columnWidths.company, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 2)}
                          onDoubleClick={() =>
                            startEdit(index, "company", app.company_name, app.id)
                          }
                        >
                          {isEditing("company") ? renderInput("company") : renderCellDisplay(app.company_name)}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={3}
                          className={cn(
                            "relative border border-border px-2 py-0.5",
                            getSelectionBorderClass(row, 3)
                          )}
                          style={{ width: columnWidths.title, minWidth: columnWidths.title, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 3)}
                          onDoubleClick={() => startEdit(index, "title", app.title, app.id)}
                        >
                          {isEditing("title") ? renderInput("title") : renderCellDisplay(app.title)}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={4}
                          className={cn(
                            "relative border border-border px-2 py-0.5",
                            getSelectionBorderClass(row, 4)
                          )}
                          style={{ width: columnWidths.jobUrl, minWidth: columnWidths.jobUrl, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 4)}
                          onDoubleClick={() =>
                            startEdit(index, "jobUrl", app.job_url ?? "", app.id)
                          }
                        >
                          {isEditing("jobUrl") ? (
                            renderInput("jobUrl", "https://...")
                          ) : app.job_url ? (
            <div className="flex items-center gap-1 min-w-0">
              <span className="flex-1 min-w-0 truncate">
                {renderCellDisplay(app.job_url, { asLink: true, href: app.job_url })}
              </span>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded hover:bg-muted p-0.5"
onClick={(ev: React.MouseEvent<HTMLButtonElement>) => {
                                  ev.stopPropagation();
                                  const raw = (app.job_url ?? "").trim();
                  if (!raw) return;
                  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
                  window.open(url, "_blank", "noopener,noreferrer");
                }}
                title="Open job URL"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            </div>
                          ) : (
                            ""
                          )}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={5}
                          className={cn(
                            "relative border border-border px-2 py-0.5",
                            getSelectionBorderClass(row, 5)
                          )}
                          style={{ width: columnWidths.jobDescription, minWidth: 160, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 5)}
                          onDoubleClick={() =>
                            startEdit(index, "jobDescription", app.job_description ?? "", app.id)
                          }
                        >
                          {isEditing("jobDescription") ? (
                            renderInput("jobDescription")
                          ) : (
                            <div className="flex items-center gap-1 min-w-0">
                              <span className="flex-1 min-w-0">
                                {renderCellDisplay(app.job_description ?? "")}
                              </span>
                              {(app.job_description ?? "").trim() ? (
                                <button
                                  type="button"
                                  className="inline-flex items-center justify-center rounded hover:bg-sky-100 dark:hover:bg-sky-900/40 p-1 text-sky-500"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    setViewJobDescriptionId(app.id);
                                  }}
                                  title="View job description"
                                >
                                  <FileText className="h-4 w-4" />
                                </button>
                              ) : null}
                            </div>
                          )}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={6}
                          className={cn(
                            "border border-border px-2 py-0.5 text-center",
                            getSelectionBorderClass(row, 6)
                          )}
                          style={{ width: columnWidths.resume, minWidth: 56, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 6)}
                        >
                          {(() => {
                            const isBulkProcessing = bulkInProgressIds.has(app.id);
                            const hasJobInfo = (app.company_name ?? "").trim() !== "" || (app.title ?? "").trim() !== "";
                            const alreadyApplied = Boolean(app.resume_file_name);
                            if (isBulkProcessing) {
                              return (
                                <div className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  <span>Generating…</span>
                                </div>
                              );
                            }
                            if (alreadyApplied) {
                              const lastDownload =
                                user?.role === "admin"
                                  ? (app as JobApplication).last_resume_download_at
                                  : null;
                              return (
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    className={cn(
                                      "inline-flex items-center justify-center rounded p-1",
                                      "hover:bg-muted"
                                    )}
                                    draggable={true}
                                    onMouseEnter={() => {
                                      if (pdfBlobCacheRef.current.has(app.id)) return;
                                      fetch(`/api/job-applications/${app.id}/pdf`)
                                        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("Failed to fetch"))))
                                        .then((blob) => {
                                          pdfBlobCacheRef.current.set(app.id, blob);
                                          return blob.arrayBuffer();
                                        })
                                        .then((ab) => {
                                          pdfBufferCacheRef.current.set(app.id, ab);
                                        })
                                        .catch(() => {});
                                    }}
                                    onMouseDown={() => {
                                      if (pdfBlobCacheRef.current.has(app.id)) return;
                                      fetch(`/api/job-applications/${app.id}/pdf`)
                                        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("Failed to fetch"))))
                                        .then((blob) => {
                                          pdfBlobCacheRef.current.set(app.id, blob);
                                          return blob.arrayBuffer();
                                        })
                                        .then((ab) => {
                                          pdfBufferCacheRef.current.set(app.id, ab);
                                        })
                                        .catch(() => {});
                                    }}
                                    onDragStart={(ev) => {
                                      const baseName =
                                        profileName(app.profile_id) ||
                                        (app.company_name ?? "").trim() ||
                                        (app.title ?? "").trim() ||
                                        "Resume";
                                      const safeName = (baseName.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "Resume") + ".pdf";
                                      const startResumeDrag = (window as unknown as { electron?: { startResumeDrag?: (b: ArrayBuffer, n: string, appId: string) => void } }).electron?.startResumeDrag;
                                      if (typeof startResumeDrag === "function") {
                                        const buffer = pdfBufferCacheRef.current.get(app.id);
                                        if (buffer) {
                                          ev.preventDefault();
                                          ev.stopPropagation();
                                          startResumeDrag(buffer, safeName, app.id);
                                          return;
                                        }
                                      }
                                      const blob = pdfBlobCacheRef.current.get(app.id);
                                      if (!blob) {
                                        ev.preventDefault();
                                        return;
                                      }
                                      ev.dataTransfer.effectAllowed = "copy";
                                      ev.dataTransfer.items.add(new File([blob], safeName, { type: "application/pdf" }));
                                    }}
                                    onContextMenu={(ev) => {
                                      ev.preventDefault();
                                      ev.stopPropagation();
                                      setResumeContextMenu({ x: ev.clientX, y: ev.clientY, app });
                                    }}
                                    onClick={async (ev) => {
                                      ev.stopPropagation();
                                      try {
                                        const res = await fetch(`/api/job-applications/${app.id}/pdf`);
                                        if (!res.ok) throw new Error("Failed to fetch PDF");
                                        const blob = await res.blob();
                                        const url = URL.createObjectURL(blob);
                                        window.open(url, "_blank", "noopener,noreferrer");
                                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                                      } catch (err) {
                                        console.error("Open PDF failed:", err);
                                      }
                                    }}
                                    title={regeneratingResumeId === app.id ? "Regenerating…" : app.resume_file_name}
                                    disabled={regeneratingResumeId === app.id}
                                  >
                                    {regeneratingResumeId === app.id ? (
                                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                    ) : (
                                      <ResumeDocIcon className="h-4 w-4" />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    className={cn(
                                      "inline-flex items-center justify-center rounded p-1 gap-1",
                                      "hover:bg-muted"
                                    )}
                                    onMouseEnter={() => {
                                      if (pdfBlobCacheRef.current.has(app.id)) return;
                                      if (!app.resume_file_name) return;
                                      fetch(`/api/job-applications/${app.id}/pdf`)
                                        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error("Failed to fetch"))))
                                        .then((blob) => {
                                          pdfBlobCacheRef.current.set(app.id, blob);
                                        })
                                        .catch(() => {});
                                    }}
                                    onClick={async (ev) => {
                                      ev.preventDefault();
                                      ev.stopPropagation();
                                      const log = (msg: string, data?: unknown) => {
                                        console.log("[ResumeDownload]", msg, data ?? "");
                                      };
                                      toast.info("Preparing download…", { duration: 1200, id: "resume-download-start" });
                                      try {
                                        const ensureBlob = async (): Promise<Blob | null> => {
                                          const cached = pdfBlobCacheRef.current.get(app.id);
                                          if (cached) return cached;
                                          const res = await fetch(`/api/job-applications/${app.id}/pdf`);
                                          if (!res.ok) {
                                            if (res.status === 404) {
                                              toast.error("No resume PDF for this application. Generate or save a resume first.");
                                            } else {
                                              toast.error("Failed to load PDF");
                                            }
                                            return null;
                                          }
                                          const b = await res.blob();
                                          pdfBlobCacheRef.current.set(app.id, b);
                                          return b;
                                        };

                                        const blob = await ensureBlob();
                                        if (!blob) return;

                                        const baseName =
                                          profileName(app.profile_id) ||
                                          (app.company_name ?? "") ||
                                          (app.title ?? "") ||
                                          "Resume";
                                        const safeBase = baseName
                                          .replace(/[\\/:*?"<>|]/g, "_")
                                          .trim()
                                          .slice(0, 80) || "Resume";
                                        const fileName = `${safeBase}.pdf`;

                                        const api = (window as unknown as {
                                          electron?: {
                                            saveResumeToTemp?: (
                                              buffer: ArrayBuffer,
                                              name: string,
                                              profileName: string
                                            ) => Promise<{ filePath: string; clipboardFile: boolean } | string | null>;
                                          };
                                        }).electron;
                                        log("Download click", { hasElectron: !!api?.saveResumeToTemp });

                                        const buffer = await blob.arrayBuffer();
                                        let savedPath: string | null = null;
                                        if (api?.saveResumeToTemp) {
                                          const result = await api.saveResumeToTemp(buffer, fileName, baseName);
                                          if (result != null) {
                                            if (typeof result === "string") {
                                              savedPath = result;
                                            } else {
                                              savedPath = result.filePath ?? null;
                                            }
                                          }
                                        } else {
                                          const url = URL.createObjectURL(blob);
                                          const a = document.createElement("a");
                                          a.href = url;
                                          a.download = fileName;
                                          document.body.appendChild(a);
                                          a.click();
                                          document.body.removeChild(a);
                                          setTimeout(() => URL.revokeObjectURL(url), 5000);
                                          savedPath = fileName;
                                        }

                                        if (!savedPath) {
                                          toast.error("Download failed");
                                          return;
                                        }

                                        const displayPath = savedPath.split(/[/\\]/).pop() ?? savedPath;
                                        toast.success(`Downloaded: ${displayPath}`, { duration: 3500 });

                                        const nowIso = new Date().toISOString();
                                        fetch(`/api/job-applications/${app.id}`, {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ last_resume_download_at: nowIso }),
                                        }).catch(() => {});

                                        (setApplications as React.Dispatch<React.SetStateAction<RowItem[]>>)((prev) =>
                                          prev.map((rowItem) =>
                                            !isPlaceholder(rowItem) && rowItem.id === app.id
                                              ? { ...(rowItem as JobApplication), last_resume_download_at: nowIso }
                                              : rowItem
                                          )
                                        );
                                      } catch (err) {
                                        console.error("[ResumeDownload] error:", err);
                                        toast.error("Download failed");
                                      }
                                    }}
                                    title="Download resume PDF"
                                  >
                                    <Download className="h-4 w-4" />
                                    {lastDownload && (() => {
                                      const d = new Date(lastDownload);
                                      const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                                      const date = d.toLocaleDateString();
                                      return (
                                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                          {time} {date}
                                        </span>
                                      );
                                    })()}
                                  </button>
                                </div>
                              );
                            }
                            if (hasJobInfo) {
                              return (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-6 text-xs px-1.5"
                                  onClick={(ev: React.MouseEvent<HTMLButtonElement>) => {
                                    ev.stopPropagation();
                                    setForm({
                                      date: app.date,
                                      company_name: app.company_name ?? "",
                                      title: app.title ?? "",
                                      job_url: app.job_url ?? "",
                                      profile_id: app.profile_id ?? currentProfileId ?? "",
                                      job_description: app.job_description ?? "",
                                    });
                                    setApplyApplication(app);
                                    setAddOpen(true);
                                  }}
                                >
                                  Apply
                                </Button>
                              );
                            }
                            return "";
                          })()}
                        </TableCell>
                        <TableCell
                          data-row={row}
                          data-col={7}
                          className={cn(
                            "border border-border px-2 py-0.5 text-center",
                            getSelectionBorderClass(row, 7)
                          )}
                          style={{ width: columnWidths.applied, minWidth: 56, maxWidth: 120 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 7)}
                        >
                          {(() => {
                            const hasResume = Boolean(app.resume_file_name);
                            const hasJd = Boolean((app.job_description ?? "").trim());
                            const canApply = hasResume && hasJd;
                            const isApplied = Boolean(app.applied_manually);
                            return (
                              <input
                                type="checkbox"
                                className="h-3 w-3"
                                checked={isApplied}
                                disabled={!canApply && !isApplied}
                                onChange={async (ev) => {
                                  ev.stopPropagation();
                                  if (isApplied) {
                                    const ok = window.confirm(
                                      "Mark this application as not applied?"
                                    );
                                    if (!ok) return;
                                    try {
                                      const res = await fetch(`/api/job-applications/${app.id}`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          applied_manually: false,
                                        }),
                                      });
                                      if (!res.ok) return;
                                      const updated = (await res.json()) as JobApplication;
                                      setApplications((prev) =>
                                        prev.map((a) => (a.id === app.id ? updated : a))
                                      );
                                    } catch (e) {
                                      console.error("Failed to mark not applied:", e);
                                    }
                                    return;
                                  }
                                  if (!canApply) return;
                                  const today = new Date().toISOString().slice(0, 10);
                                  try {
                                    const res = await fetch(`/api/job-applications/${app.id}`, {
                                      method: "PATCH",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({
                                        applied_manually: true,
                                        date: today,
                                      }),
                                    });
                                    if (!res.ok) return;
                                    const updated = (await res.json()) as JobApplication;
                                    setApplications((prev) =>
                                      prev.map((a) => (a.id === app.id ? updated : a))
                                    );
                                  } catch (e) {
                                    console.error("Failed to mark applied:", e);
                                  }
                                }}
                              />
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {showEmptyRows && Array.from({ length: emptyRowCount }, (_, i) => {
                    const row = 1 + dataRows.length + i;
                    return (
                      <TableRow key={`empty-${i}`} className="border-b border-border [&_td]:h-6 [&_td]:max-h-6 [&_td]:leading-tight [&_td]:align-middle [&_td]:overflow-hidden">
                        <TableCell
                          data-row={row}
                          data-col={0}
                          className={cn(
                            "border border-border px-2 py-0.5 bg-background text-right tabular-nums text-muted-foreground/70 font-medium text-xs",
                            getSelectionBorderClass(row, 0)
                          )}
                          style={{ width: columnWidths.no, minWidth: columnWidths.no, maxWidth: 480 }}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, 0)}
                        >
                          {dataRows.length + i + 1}
                        </TableCell>
                        {[1, 2, 3, 4, 5, 6, 7].map((col) => {
                          const colKey: ColumnKey | null =
                            col === 1
                              ? "date"
                              : col === 2
                              ? "company"
                              : col === 3
                              ? "title"
                              : col === 4
                              ? "jobUrl"
                              : col === 5
                              ? "jobDescription"
                              : col === 6
                              ? "resume"
                              : col === 7
                              ? "applied"
                              : null;
                          const isEditableCol = colKey != null && EDITABLE_COLUMNS.includes(colKey);
                          return (
                            <TableCell
                              key={col}
                              data-row={row}
                              data-col={col}
                              className={cn(
                                "border border-border px-2 py-0.5 bg-background text-xs",
                                getSelectionBorderClass(row, col)
                              )}
                              style={{
                                width:
                                  col === 1
                                    ? columnWidths.date
                                    : col === 2
                                    ? columnWidths.company
                                    : col === 3
                                    ? columnWidths.title
                                    : col === 4
                                    ? columnWidths.jobUrl
                                    : columnWidths.resume,
                                minWidth:
                                  col === 1
                                    ? columnWidths.date
                                    : col === 2
                                    ? columnWidths.company
                                    : col === 3
                                    ? columnWidths.title
                                    : col === 4
                                    ? columnWidths.jobUrl
                                    : columnWidths.resume,
                                maxWidth: 480,
                              }}
                              onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, row, col)}
                              onDoubleClick={async () => {
                                if (!isEditableCol) return;
                                try {
                                  const profileId = effectiveProfileFilterId || null;
                                  const insertIndex = dataRows.length + i;
                                  const res = await fetch("/api/job-applications", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      date: "",
                                      company_name: "",
                                      title: "",
                                      job_url: null,
                                      profile_id: profileId,
                                      resume_file_name: "",
                                    }),
                                  });
                                  if (!res.ok) return;
                                  const rowCreated = (await res.json()) as JobApplication;
                                  setApplications((prev) => {
                                    pushHistory(prev);
                                    if (insertIndex <= prev.length) {
                                      return [
                                        ...prev.slice(0, insertIndex),
                                        rowCreated,
                                        ...prev.slice(insertIndex),
                                      ];
                                    }
                                    const placeholders: RowItem[] = Array.from(
                                      { length: insertIndex - prev.length },
                                      (_, i) => ({
                                        id: `placeholder-${prev.length + i}`,
                                        date: "",
                                        company_name: "",
                                        title: "",
                                        job_url: null,
                                        profile_id: profileId,
                                        resume_file_name: "",
                                        created_at: "",
                                        _placeholder: true as const,
                                      })
                                    );
                                    return [...prev, ...placeholders, rowCreated];
                                  });
                                  setEditingCell({
                                    rowIndex: insertIndex,
                                    key: colKey,
                                    value: "",
                                    appId: rowCreated.id,
                                  });
                                  setSelectedRange({
                                    startRow: row,
                                    startCol: col,
                                    endRow: row,
                                    endCol: col,
                                  });
                                  queueScrollCellIntoView(row, col);
                                } catch (err) {
                                  console.error("Failed to create empty application row:", err);
                                }
                              }}
                            />
                          );
                        })}
                      </TableRow>
                    );
                  })}
                  {showEmptyRows && showAddMoreButton && (() => {
                    const addMoreRow = 1 + dataRows.length + emptyRowCount;
                    return (
                      <TableRow className="border-b border-border bg-muted/30">
                        <TableCell
                          data-row={addMoreRow}
                          data-col={0}
                          colSpan={6}
                          className={cn("border border-border px-4 py-3 text-center", getSelectionBorderClass(addMoreRow, 0))}
                          onMouseDown={(e: React.MouseEvent<HTMLTableCellElement>) => handleCellMouseDown(e, addMoreRow, 0)}
                        >
                          <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleAddMoreRows}
                        >
                          Add more (next {EMPTY_ROW_BATCH} rows)
                        </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })()}
                </TableBody>
                </table>
              </div>
              </div>
            </div>
            </>
          )}
          {profileDropdown && (
            <div
              ref={profileDropdownRef}
              className="fixed z-30 max-h-60 overflow-auto rounded-md border bg-popover text-sm shadow-md min-w-[160px] py-1"
              style={{ left: profileDropdown.left, top: profileDropdown.top }}
            >
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-muted"
                onClick={() => applyProfileToRows(null)}
              >
                None
              </button>
              {profiles.map((p: ProfileMeta) => (
                <button
                  key={p.id}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left hover:bg-muted truncate"
                  onClick={() => applyProfileToRows(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {contextMenu && (
            <div
              ref={contextMenuRef}
              className="fixed z-30 rounded-md border bg-popover text-sm shadow-md min-w-[160px]"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {contextMenu.selectionRows.length > 0 &&
                contextMenu.selectionRows.some(
                  (r) => dataRows[r - 1] && !isPlaceholder(dataRows[r - 1] as RowItem)
                ) && (
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-muted"
                    onClick={() => {
                      void handleDeleteSelectedRows(contextMenu.selectionRows);
                      setContextMenu(null);
                    }}
                  >
                    {contextMenu.selectionRows.length > 1
                      ? "Delete selected rows"
                      : "Delete row"}
                  </button>
                )}
            </div>
          )}
          {resumeContextMenu && (
            <div
              ref={resumeContextMenuRef}
              className="fixed z-30 rounded-md border bg-popover text-sm shadow-md min-w-[160px]"
              style={{ top: resumeContextMenu.y, left: resumeContextMenu.x }}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  const { app } = resumeContextMenu;
                  setForm({
                    date: app.date,
                    company_name: app.company_name ?? "",
                    title: app.title ?? "",
                    job_url: app.job_url ?? "",
                    profile_id: app.profile_id ?? currentProfileId ?? "",
                    job_description: app.job_description ?? "",
                  });
                  setApplyApplication(app);
                  setAddOpen(true);
                  setResumeContextMenu(null);
                }}
              >
                Update resume
              </button>
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-muted flex items-center gap-2"
                disabled={!resumeContextMenu.app.job_description?.trim() || !!regeneratingResumeId}
                onClick={async () => {
                  const { app } = resumeContextMenu;
                  setResumeContextMenu(null);
                  if (!app.job_description?.trim()) {
                    toast.error("Job description required to regenerate");
                    return;
                  }
                  setRegeneratingResumeId(app.id);
                  toast.info("Regenerating resume…", { duration: 2000 });
                  if (!deepSeekPanelOpen) toggleDeepSeekPanel();
                  try {
                    const stored = await runGptPipelineForApplication(app);
                    if (!stored) {
                      toast.error("Regenerate failed (no content generated)");
                      return;
                    }
                    const templateId = formatIdToTemplateId(getJobApplicationFormatId(app));
                    const pdfRes = await fetch("/api/pdf", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ data: stored, templateId: templateId ?? undefined }),
                    });
                    if (!pdfRes.ok) {
                      toast.error("Failed to generate PDF");
                      return;
                    }
                    const blob = await pdfRes.blob();
                    const uploadRes = await fetch(`/api/job-applications/${app.id}/pdf`, {
                      method: "POST",
                      headers: { "Content-Type": "application/pdf" },
                      body: blob,
                    });
                    if (!uploadRes.ok) {
                      toast.error("Failed to upload resume");
                      return;
                    }
                    pdfBlobCacheRef.current.delete(app.id);
                    pdfBufferCacheRef.current.delete(app.id);
                    const rowRes = await fetch(`/api/job-applications/${app.id}`);
                    if (rowRes.ok) {
                      const updated = (await rowRes.json()) as JobApplication;
                      setApplications((prev) =>
                        prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
                      );
                    }
                    toast.success("Resume regenerated and GPT chat link updated");
                  } catch (err) {
                    console.error("Regenerate resume failed:", err);
                    toast.error("Regenerate failed");
                  } finally {
                    setRegeneratingResumeId(null);
                  }
                }}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", regeneratingResumeId === resumeContextMenu.app.id && "animate-spin")} />
                Regenerate
              </button>
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* DeepSeek panel: webview always mounted so close/open does not refresh; toggle only hides/shows */}
      <aside
        className={cn(
          "flex-shrink-0 flex flex-col border-l border-border bg-background",
          deepSeekPanelOpen ? "w-[20%] min-w-[200px]" : "w-10"
        )}
        aria-label="DeepSeek Chat"
      >
        {deepSeekPanelOpen && (
          <div className="flex-shrink-0 px-2 py-1.5 border-b border-border flex items-center justify-between gap-1">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              DeepSeek Chat
            </span>
            <div className="flex items-center gap-1">
              {user?.role === "admin" && isDesktopDeepSeekSync && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={async () => {
                    const electron = (window as unknown as { electron?: { getDeepSeekCookies: () => Promise<unknown[]> } }).electron;
                    if (!electron?.getDeepSeekCookies) return;
                    setStatus("Saving session…");
                    try {
                      const cookies = await electron.getDeepSeekCookies();
                      const res = await fetch("/api/deepseek-cookies", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ cookies }),
                      });
                      if (res.ok) {
                        setStatus("Session saved. Others can sync with manager's session.");
                        toast.success("Session saved. Others can sync with manager's session.");
                      } else {
                        setStatus("Failed to save session");
                        toast.error("Failed to save session");
                      }
                    } catch {
                      setStatus("Failed to save session");
                      toast.error("Failed to save session");
                    }
                  }}
                  title="Sync with manager's session"
                  aria-label="Save session"
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  const wv = deepSeekWebViewRef.current as unknown as { reload?: () => void };
                  if (typeof wv?.reload === "function") wv.reload();
                }}
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={toggleDeepSeekPanel}
                title="Close DeepSeek panel"
                aria-label="Close DeepSeek panel"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
        {/* Always mounted so closing/opening panel does not reload the page */}
        <webview
          ref={deepSeekWebViewRef}
          src={deepSeekWebViewSrc}
          partition="persist:deepseek"
          className={cn(
            "w-full min-h-0 border-0",
            deepSeekPanelOpen ? "flex-1 flex min-h-0" : "hidden"
          )}
          allowpopups
        />
        {!deepSeekPanelOpen && (
          <div className="flex flex-1 flex-col items-center justify-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={toggleDeepSeekPanel}
              title="Open DeepSeek panel"
              aria-label="Open DeepSeek panel"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        )}
      </aside>

      <Dialog open={addOpen} onOpenChange={(open: boolean) => { setAddOpen(open); if (!open) setApplyApplication(null); }}>
        <DialogContent className="w-[90vw] max-w-6xl h-[90vh] min-h-[80vh] overflow-hidden flex flex-col p-0 gap-0 antialiased" aria-describedby={undefined} showClose={false} noZoomAnimation>
          <DialogTitle className="sr-only">{applyApplication ? "Apply" : "Add"} application</DialogTitle>
          <DialogHeader className="flex-shrink-0 px-6 pt-4 pb-3 flex-row items-center justify-between gap-3">
            <form onSubmit={handleAdd} id="add-application-form" className="flex flex-1 items-center gap-2 min-w-0">
              <Input
                id="add-company"
                value={form.company_name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, company_name: e.target.value }))}
                placeholder="Company"
                required
                className="h-7 text-xs px-2 flex-1 min-w-0 max-w-[140px]"
              />
              <Input
                id="add-title"
                value={form.title}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Job title"
                required
                className="h-7 text-xs px-2 flex-1 min-w-0 max-w-[180px]"
              />
              <div className="flex items-center gap-1 flex-1 min-w-0 max-w-[220px]">
                <Input
                  id="add-job_url"
                  type="url"
                  value={form.job_url}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, job_url: e.target.value }))}
                  placeholder="Job URL"
                  className="h-7 text-xs px-2 flex-1 min-w-0"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={!form.job_url.trim()}
                  title="Open job URL"
                  onClick={() => {
                    const raw = form.job_url.trim();
                    if (!raw) return;
                    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
                    window.open(url, "_blank", "noopener,noreferrer");
                  }}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={!form.job_url.trim()}
                  title="Copy job URL"
                  onClick={async () => {
                    const raw = form.job_url.trim();
                    if (!raw) return;
                    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
                    try {
                      await writeTextToClipboard(url);
                      setCopiedJobUrl(true);
                      setTimeout(() => setCopiedJobUrl(false), 1500);
                    } catch (err) {
                      console.error("Copy job URL failed:", err);
                    }
                  }}
                >
                  {copiedJobUrl ? (
                    <Check className="h-3 w-3 text-green-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>
            </form>
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              <span className="text-xs text-muted-foreground mr-1">Style:</span>
              {FORMAT_LIST.map((f: { formatId: FormatId; name: string; description: string }) => {
                const num = f.formatId.replace("format", "") || "1";
                return (
                  <button
                    key={f.formatId}
                    type="button"
                    onClick={async () => {
                      setApplicationModalFormatId(f.formatId);
                      applicationModalFormatIdRef.current = f.formatId;
                      try {
                        localStorage.setItem(APPLICATION_MODAL_TEMPLATE_KEY, f.formatId);
                      } catch {}
                      if (applyApplication?.id) {
                        try {
                          await persistApplicationResumeFormat(applyApplication.id, f.formatId);
                        } catch (error) {
                          console.error("Failed to persist application resume style:", error);
                          toast.error("Failed to save resume style");
                        }
                      }
                      runPdfRefreshNowRef.current();
                    }}
                    title={f.name}
                    className={cn(
                      "rounded-sm border transition-colors flex items-center justify-center w-8 h-9 text-xs font-semibold shadow-sm",
                      "bg-background border-border",
                      applicationModalFormatId === f.formatId
                        ? "ring-2 ring-primary border-primary text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground hover:border-muted-foreground/30"
                    )}
                  >
                    <span className="flex items-center gap-0.5">
                      <ResumeDocIcon className="h-3.5 w-3 shrink-0" />
                      <span>{num}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </DialogHeader>
          {/* Split: left = text areas (50%), right = PDF preview (50%) */}
          <div className="flex-1 flex min-h-0 gap-4 px-6 pb-4">
            {/* Left: resume editor */}
            <div className="basis-1/2 min-w-0 flex flex-col gap-1.5 overflow-y-auto border-r pr-3">
              <div className="flex-shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="job-description" className="text-xs text-muted-foreground">Job description</Label>
                  <div className="flex items-center gap-1">
                    {jobDescriptionTokenEstimate > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        ~{jobDescriptionTokenEstimate} tokens
                      </span>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={!form.job_description.trim() || aiPipelineRunning}
                      onClick={async () => {
                        if (!form.job_description.trim()) return;
                        const jd = form.job_description.trim();
                        const expList = (modalResumeData ?? defaultResumeData).experience ?? [];
                        const currentCompanyName =
                          expList[0]?.company?.trim() || form.company_name.trim();
                        const currentRole = expList[0]?.role?.trim() ?? form.title?.trim() ?? "";
                        const key =
                          typeof window !== "undefined"
                            ? window.localStorage.getItem("resume-builder-ai-api-key") || ""
                            : "";
                        if (!aiPrompts) return;
                        setAiPipelineRunning(true);
                        setHighlightTarget(null);
                        setRoleContext(null);
                        setChatMessages([]);
                        try {
                          // Step 0: extract core role context from JD (API flow, in-memory only)
                          let extractedContext = "";
                          try {
                            const res0 = await fetch("/api/ai/generate", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                apiKey: key,
                                mode: "extractCoreContext",
                                jobDescription: jd,
                                currentCompany: currentCompanyName,
                                lastCompany: "",
                                currentRole,
                              }),
                            });
                            if (res0.ok) {
                              const json0 = (await res0.json()) as { text?: string };
                              extractedContext = (json0.text ?? "").trim();
                            }
                          } catch (e) {
                            console.error("AI extractCoreContext error (desktop API):", e);
                          }
                          if (!extractedContext) {
                            setAiPipelineRunning(false);
                            return;
                          }
                          setRoleContext(extractedContext);
                          setChatMessages([
                            {
                              role: "assistant",
                              content: extractedContext,
                            },
                          ]);

                          // Step 1: current company bullets (skip when first experience has static content)
                          setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 1: true }));
                          const firstExpData = (modalResumeData ?? defaultResumeData).experience?.[0];
                          const staticBullets =
                            firstExpData?.useStaticBullets &&
                            (firstExpData.staticBulletContent ?? "").trim()
                              ? (firstExpData.staticBulletContent ?? "").trim()
                              : "";
                          let currentBullets = staticBullets || "";
                          try {
                            if (!staticBullets) {
                              const history1 = [
                                {
                                  role: "assistant" as const,
                                  content: extractedContext,
                                },
                              ];
                              const res1 = await fetch("/api/ai/generate", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  apiKey: key,
                                  mode: "bulletsCurrent",
                                  jobDescription: jd,
                                  currentCompany: currentCompanyName,
                                  lastCompany: "",
                                  currentRole,
                                  prompts: aiPrompts,
                                  roleContext: extractedContext,
                                  messages: history1,
                                }),
                              });
                              if (res1.ok) {
                                const json1 = (await res1.json()) as { text?: string };
                                currentBullets = (json1.text ?? "").trim();
                                if (currentBullets) {
                                  setModalResumeData((prev: ResumeData | null) => {
                                    const cur = prev ?? defaultResumeData;
                                    const exps = [...(cur.experience ?? [])];
                                    if (exps[0]) exps[0] = { ...exps[0], description: currentBullets };
                                    return { ...cur, experience: exps };
                                  });
                                  setModalContentVersion((v) => v + 1);
                                  schedulePdfRefreshRef.current();
                                  setChatMessages((prev) => [
                                    ...prev,
                                    { role: "assistant", content: currentBullets },
                                  ]);
                                }
                              }
                            } else {
                              setChatMessages((prev) => [
                                ...prev,
                                { role: "assistant", content: currentBullets },
                              ]);
                            }
                          } finally {
                            setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 1: false }));
                          }

                          // Step 2: last-company prompt (or static content) for each non-current experience (index 1, 2, ...)
                          setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 2: true }));
                          const lastBulletsParts: string[] = [];
                          try {
                            const expList = (modalResumeData ?? defaultResumeData).experience ?? [];
                            for (let i = 1; i < expList.length; i++) {
                              const exp = expList[i];
                              const lastCompanyName = exp?.company?.trim() ?? "";
                              if (!lastCompanyName) continue;
                              const staticLast =
                                exp?.useStaticBullets && (exp.staticBulletContent ?? "").trim()
                                  ? (exp.staticBulletContent ?? "").trim()
                                  : "";
                              let bullets = staticLast;
                              if (!staticLast) {
                                const history2 = [
                                  {
                                    role: "assistant" as const,
                                    content: extractedContext,
                                  },
                                  ...(currentBullets
                                    ? [{ role: "assistant" as const, content: currentBullets }]
                                    : []),
                                  ...lastBulletsParts.map((c) => ({ role: "assistant" as const, content: c })),
                                ];
                                const res2 = await fetch("/api/ai/generate", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    apiKey: key,
                                    mode: "bulletsLast",
                                    jobDescription: jd,
                                    currentCompany: currentCompanyName,
                                    lastCompany: lastCompanyName,
                                    currentRole,
                                    prompts: aiPrompts,
                                    roleContext: extractedContext,
                                    messages: history2,
                                  }),
                                });
                                if (res2.ok) {
                                  const json2 = (await res2.json()) as { text?: string };
                                  bullets = (json2.text ?? "").trim();
                                }
                              }
                              if (bullets) {
                                lastBulletsParts.push(bullets);
                                const idx = i;
                                setModalResumeData((prev: ResumeData | null) => {
                                  const cur = prev ?? defaultResumeData;
                                  const exps = [...(cur.experience ?? [])];
                                  if (exps[idx]) exps[idx] = { ...exps[idx], description: bullets };
                                  return { ...cur, experience: exps };
                                });
                                setModalContentVersion((v) => v + 1);
                                schedulePdfRefreshRef.current();
                                setChatMessages((prev) => [
                                  ...prev,
                                  { role: "assistant", content: bullets },
                                ]);
                              }
                            }
                          } finally {
                            setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 2: false }));
                          }
                          const lastBullets = lastBulletsParts.join("\n\n");

                          // Step 3: summary
                          setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 3: true }));
                          try {
                            const history3 = [
                              {
                                role: "assistant" as const,
                                content: extractedContext,
                              },
                              ...(currentBullets
                                ? [{ role: "assistant" as const, content: currentBullets }]
                                : []),
                              ...(lastBullets
                                ? [{ role: "assistant" as const, content: lastBullets }]
                                : []),
                            ];
                            const res3 = await fetch("/api/ai/generate", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                apiKey: key,
                                mode: "summary",
                                jobDescription: jd,
                                currentCompany: currentCompanyName,
                                lastCompany: "",
                                currentRole,
                                prompts: aiPrompts,
                                generatedBullets: { current: currentBullets, last: lastBullets },
                                roleContext: extractedContext,
                                messages: history3,
                              }),
                            });
                            if (res3.ok) {
                              const json3 = (await res3.json()) as { text?: string };
                              const summary = (json3.text ?? "").trim();
                              if (summary) {
                                setModalResumeData((prev: ResumeData | null) => {
                                  const cur = prev ?? defaultResumeData;
                                  return {
                                    ...cur,
                                    profile: { ...cur.profile, summary },
                                  };
                                });
                                setModalContentVersion((v) => v + 1);
                                schedulePdfRefreshRef.current();
                              }
                            }
                          } finally {
                            setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 3: false }));
                          }

                          // Step 4: skills
                          setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 4: true }));
                          try {
                            const history4 = [
                              {
                                role: "assistant" as const,
                                content: extractedContext,
                              },
                              ...(currentBullets
                                ? [{ role: "assistant" as const, content: currentBullets }]
                                : []),
                              ...(lastBullets
                                ? [{ role: "assistant" as const, content: lastBullets }]
                                : []),
                            ];
                            const res4 = await fetch("/api/ai/generate", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                apiKey: key,
                                mode: "skills",
                                jobDescription: jd,
                                currentCompany: currentCompanyName,
                                lastCompany: "",
                                currentRole,
                                prompts: aiPrompts,
                                generatedBullets: { current: currentBullets, last: lastBullets },
                                roleContext: extractedContext,
                                messages: history4,
                              }),
                            });
                            if (res4.ok) {
                              const json4 = (await res4.json()) as { text?: string };
                              const skillsText = (json4.text ?? "").trim();
                              if (skillsText) {
                                const skillsArr = parseSkillsText(skillsText);
                                setModalResumeData((prev: ResumeData | null) => {
                                  const cur = prev ?? defaultResumeData;
                                  return { ...cur, skills: skillsArr };
                                });
                                setModalContentVersion((v) => v + 1);
                                schedulePdfRefreshRef.current();
                              }
                            }
                          } finally {
                            setAiButtonLoading((s: Record<PromptId, boolean>) => ({ ...s, 4: false }));
                          }
                        } finally {
                          setAiPipelineRunning(false);
                        }
                      }}
                    >
                      API
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={!form.job_description.trim() || !aiPrompts || gptPipelineRunning || aiPipelineRunning}
                      title="Run 4-step AI using DeepSeek chat in panel"
                      onClick={async () => {
                        if (!form.job_description.trim() || !aiPrompts) return;
                        const jd = form.job_description.trim();
                        const expList = (modalResumeData ?? defaultResumeData).experience ?? [];
                        const currentCompanyName =
                          expList[0]?.company?.trim() || form.company_name.trim();
                        const currentRole = expList[0]?.role?.trim() ?? form.title?.trim() ?? "";
                        const params = {
                          currentCompany: currentCompanyName,
                          lastCompany: "",
                          jobDescription: jd,
                          currentRole,
                        };
                        setGptPipelineRunning(true);
                        setHighlightTarget(null);
                        // Extract core context using GPT webview only (no API call).
                        const extractionPrompt = buildExtractionPromptForGpt(jd);
                        const extractedContext = extractionPrompt
                          ? (await runGptStepInWebview(extractionPrompt))?.trim() ?? ""
                          : "";
                        if (!extractedContext) {
                          setGptPipelineRunning(false);
                          return;
                        }
                        const firstExpForStatic = expList[0];
                        const staticBullets =
                          firstExpForStatic?.useStaticBullets &&
                          (firstExpForStatic.staticBulletContent ?? "").trim()
                            ? (firstExpForStatic.staticBulletContent ?? "").trim()
                            : "";
                        let currentBullets = staticBullets;
                        const lastBulletsParts: string[] = [];
                        try {
                          // Step 1: current company bullets (skip when first experience has static content)
                          if (!staticBullets) {
                            const prompt1 = buildFullPromptForGptStep(1, aiPrompts, params, undefined, extractedContext);
                            const result1 = await runGptStepInWebview(prompt1);
                            if (!result1?.trim()) {
                              setGptPipelineRunning(false);
                              return;
                            }
                            currentBullets = result1.trim();
                            setModalResumeData((prev: ResumeData | null) => {
                              const cur = prev ?? defaultResumeData;
                              const exps = [...(cur.experience ?? [])];
                              if (exps[0]) exps[0] = { ...exps[0], description: currentBullets };
                              return { ...cur, experience: exps };
                            });
                            setModalContentVersion((v) => v + 1);
                            schedulePdfRefreshRef.current();
                          }

                          // Step 2: last-company prompt (or static content) for each non-current experience
                          for (let i = 1; i < expList.length; i++) {
                            const exp = expList[i];
                            const lastCompanyName = exp?.company?.trim() ?? "";
                            if (!lastCompanyName) continue;
                            const staticLast =
                              exp?.useStaticBullets && (exp.staticBulletContent ?? "").trim()
                                ? (exp.staticBulletContent ?? "").trim()
                                : "";
                            let bullets = staticLast;
                            if (!staticLast) {
                              const paramsLast = { ...params, lastCompany: lastCompanyName };
                              const prompt2 = buildFullPromptForGptStep(2, aiPrompts, paramsLast, undefined, extractedContext);
                              const result2 = await runGptStepInWebview(prompt2);
                              if (!result2?.trim()) {
                                setGptPipelineRunning(false);
                                return;
                              }
                              bullets = result2.trim();
                            }
                            lastBulletsParts.push(bullets);
                            const idx = i;
                            setModalResumeData((prev: ResumeData | null) => {
                              const cur = prev ?? defaultResumeData;
                              const exps = [...(cur.experience ?? [])];
                              if (exps[idx]) exps[idx] = { ...exps[idx], description: bullets };
                              return { ...cur, experience: exps };
                            });
                            setModalContentVersion((v) => v + 1);
                            schedulePdfRefreshRef.current();
                          }
                          const lastBullets = lastBulletsParts.join("\n\n");

                          // Step 3: summary
                          const prompt3 = buildFullPromptForGptStep(
                            3,
                            aiPrompts,
                            params,
                            {
                              current: currentBullets,
                              last: lastBullets,
                            },
                            extractedContext
                          );
                          const result3 = await runGptStepInWebview(prompt3);
                          if (!result3?.trim()) {
                            setGptPipelineRunning(false);
                            return;
                          }
                          const summary = result3.trim();
                          setModalResumeData((prev: ResumeData | null) => {
                            const cur = prev ?? defaultResumeData;
                            return { ...cur, profile: { ...cur.profile, summary } };
                          });
                          setModalContentVersion((v) => v + 1);
                          schedulePdfRefreshRef.current();

                          // Step 4: skills
                          const prompt4 = buildFullPromptForGptStep(
                            4,
                            aiPrompts,
                            params,
                            {
                              current: currentBullets,
                              last: lastBullets,
                            },
                            extractedContext
                          );
                          const result4 = await runGptStepInWebview(prompt4);
                          if (!result4?.trim()) {
                            setGptPipelineRunning(false);
                            return;
                          }
                          const skillsText = result4.trim();
                          const skillsArr = parseSkillsText(skillsText);
                          setModalResumeData((prev: ResumeData | null) => {
                            const cur = prev ?? defaultResumeData;
                            return { ...cur, skills: skillsArr };
                          });
                          setModalContentVersion((v) => v + 1);
                          schedulePdfRefreshRef.current();
                          await captureCurrentGptChatUrl(applyApplication?.id ?? null);
                        } finally {
                          setGptPipelineRunning(false);
                        }
                      }}
                    >
                      {gptPipelineRunning ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "GPT"
                      )}
                    </Button>
                  </div>
                </div>
                <textarea
                  id="job-description"
                  rows={1}
                  className="mt-0.5 h-7 w-full resize-none rounded border border-input bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring overflow-hidden"
                  placeholder="Paste job description here (saved per application)"
                  value={form.job_description}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setForm((f) => ({
                      ...f,
                      job_description: stripGoogleRefSuffixFromText(e.target.value),
                    }))
                  }
                  style={{ minHeight: "1.75rem", maxHeight: "2.25rem", overflowY: "auto" }}
                />
              </div>
              {form.job_description.trim() && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {(() => {
                    const dataForPrompts = modalResumeData ?? defaultResumeData;
                    const exps = dataForPrompts.experience ?? [];
                    const firstExp = exps[0];
                    const secondExp = exps[1];
                    const firstDescFilled = Boolean(firstExp?.description?.trim());
                    const secondDescFilled = Boolean(secondExp?.description?.trim());
                    const summaryText = (dataForPrompts.profile?.summary ?? "").trim();
                    const summaryFilled = summaryText.length > 0;
                    const skillsFilled = (dataForPrompts.skills ?? []).length > 0;
                    const buttons: PromptId[] = [1, 2, 3, 4];
                    return buttons.map((id) => {
                      let disabled = false;
                      if (id === 1) {
                        disabled = !firstExp || firstDescFilled;
                      } else if (id === 2) {
                        disabled = !secondExp || secondDescFilled;
                      } else if (id === 3) {
                        disabled = summaryFilled;
                      } else if (id === 4) {
                        disabled = skillsFilled;
                      }
                      const baseClasses =
                        "inline-flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors";
                      const enabledClasses =
                        "bg-slate-900 text-white hover:bg-slate-700 border-slate-900";
                      const copiedClasses =
                        "bg-emerald-600 text-white border-emerald-600";
                      const disabledClasses =
                        "bg-muted text-muted-foreground border-muted cursor-not-allowed";
                      const stateClasses = disabled
                        ? disabledClasses
                        : copiedPromptId === id
                          ? copiedClasses
                          : enabledClasses;
                          const currentCompanyName =
                            firstExp?.company?.trim() || form.company_name.trim();
                          const lastCompanyName = secondExp?.company?.trim() || "";
                          const currentRole = firstExp?.role?.trim() ?? form.title?.trim() ?? "";
                          const jobDesc = form.job_description.trim();
                      return (
                        <button
                          key={id}
                          type="button"
                          className={cn(baseClasses, stateClasses)}
                          disabled={disabled || aiButtonLoading[id]}
                          onClick={async () => {
                            if (disabled) return;
                            try {
                              const promptText = buildPromptForButton(id, aiPrompts, {
                                currentCompany: currentCompanyName,
                                lastCompany: lastCompanyName,
                                jobDescription: jobDesc,
                                roleContext: roleContext ?? undefined,
                                currentRole,
                              });
                              if (!promptText) return;
                              await writeTextToClipboard(promptText);
                              setCopiedPromptId(id);
                              setTimeout(() => {
                                setCopiedPromptId((prev) =>
                                  prev === id ? null : prev
                                );
                              }, 1500);
                            } catch (err) {
                              console.error("Copy prompt failed:", err);
                            }
                              if (id === 1) setHighlightTarget("currentCompany");
                              else if (id === 2) setHighlightTarget("lastCompany");
                              else if (id === 3) setHighlightTarget("summary");
                              else setHighlightTarget("skills");
                          }}
                          title={
                            id === 1
                              ? "Copy prompt for current company bullets"
                              : id === 2
                                ? "Copy prompt for last company bullets"
                                : id === 3
                                  ? "Copy prompt for summary prompt"
                                  : "Copy prompt for summary text"
                          }
                        >
                          {aiButtonLoading[id] ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            id
                          )}
                        </button>
                      );
                    });
                  })()}
                </div>
              )}
              <div ref={applyModalContentRef} className="flex-1 min-h-0 border rounded bg-muted/40 p-2 overflow-y-auto flex flex-col gap-2">
                {modalDataLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : (
                  <ApplicationResumeEditor
                      data={modalResumeData ?? defaultResumeData}
                      highlightTarget={highlightTarget ?? undefined}
                      onSummaryChange={
                        (modalResumeData as StoredProfileData)?.style?.showSummary !== false
                          ? (value: string) => {
                            setModalContentVersion((v) => v + 1);
                            setModalResumeData((prev: ResumeData | null) => {
                              const current = prev ?? defaultResumeData;
                              return {
                                ...current,
                                profile: { ...current.profile, summary: value },
                              };
                            });
                            schedulePdfRefreshRef.current();
                          }
                        : undefined
                    }
                    onSkillsChange={(value: string) => {
                      setModalContentVersion((v) => v + 1);
                      const lines = value.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
                      const skills: { id: string; name: string; category: string }[] = [];
                      let id = 0;
                      for (const line of lines) {
                        const idx = line.indexOf(":");
                        if (idx > 0) {
                          const category = line.slice(0, idx).trim();
                          const rest = line.slice(idx + 1).trim();
                          const names = rest ? rest.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
                          for (const name of names) {
                            skills.push({ id: `skill-${id++}`, name, category: category || "Other" });
                          }
                        } else {
                          const names = line.split(",").map((s: string) => s.trim()).filter(Boolean);
                          for (const name of names) {
                            skills.push({ id: `skill-${id++}`, name, category: "Other" });
                          }
                        }
                      }
                      setModalResumeData((prev: ResumeData | null) => {
                        const current = prev ?? defaultResumeData;
                        return { ...current, skills };
                      });
                      schedulePdfRefreshRef.current();
                    }}
                    onExperienceDescriptionChange={(expId: string, description: string) => {
                      setModalContentVersion((v) => v + 1);
                      setModalResumeData((prev: ResumeData | null) => {
                        const current = prev ?? defaultResumeData;
                        return {
                          ...current,
                          experience: current.experience.map((exp: Experience) =>
                            exp.id === expId ? { ...exp, description } : exp
                          ),
                        };
                      });
                      schedulePdfRefreshRef.current();
                    }}
                    onExperienceRoleChange={(expId: string, role: string) => {
                      setModalContentVersion((v) => v + 1);
                      setModalResumeData((prev: ResumeData | null) => {
                        const current = prev ?? defaultResumeData;
                        return {
                          ...current,
                          experience: current.experience.map((exp: Experience) =>
                            exp.id === expId ? { ...exp, role } : exp
                          ),
                        };
                      });
                      schedulePdfRefreshRef.current();
                    }}
                  />
                )}
              </div>
            </div>
            {/* Right: PDF preview */}
            <div className="basis-1/2 min-w-0 flex flex-col gap-2 overflow-hidden bg-muted/30 rounded-md p-4">
              {pdfPreviewUrl && pdfPreviewIframeSrc ? (
                <>
                  <div className="flex items-center justify-between gap-2 flex-shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => window.open(pdfPreviewUrl!, "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink className="h-3 w-3 mr-1" />
                      Open in new tab
                    </Button>
                    <span className="text-[11px] text-muted-foreground">
                      {modalResumeTokenEstimate > 0
                        ? `~${modalResumeTokenEstimate} tokens (approx)`
                        : "Token estimate unavailable"}
                    </span>
                  </div>
                  <iframe
                    key={pdfPreviewUrl}
                    src={pdfPreviewIframeSrc}
                    title="Resume PDF preview"
                    className="flex-1 w-full min-h-[60vh] rounded border bg-white"
                  />
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    {modalDataLoading
                      ? "Loading resume…"
                      : downloadingPdf
                        ? "Generating PDF…"
                        : "Preparing PDF preview…"}
                  </p>
                  {pdfError && <p className="text-xs text-destructive">{pdfError}</p>}
                  {!modalDataLoading && !downloadingPdf && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => schedulePdfRefreshRef.current()}
                    >
                      Retry
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Bottom: actions */}
          <div className="flex flex-shrink-0 items-center justify-between gap-2 px-6 py-2 border-t bg-muted/20">
            <div className="flex flex-col gap-1.5" />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => { setAddOpen(false); setApplyApplication(null); }}
              >
                Cancel
              </Button>
              <Button type="submit" form="add-application-form" size="sm" className="h-8 px-3 text-xs">
                {applyApplication ? "Apply" : "Add"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewJobDescriptionId} onOpenChange={(open: boolean) => !open && setViewJobDescriptionId(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Job description</DialogTitle>
            <DialogDescription id="job-description-modal-desc">
              {viewJobDescriptionId
                ? (() => {
                    const app = applications.find((a) => !isPlaceholder(a) && a.id === viewJobDescriptionId) as JobApplication | undefined;
                    return app ? `${app.company_name ?? ""} – ${app.title ?? ""}`.trim() || "Application" : "";
                  })()
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto rounded border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
            {viewJobDescriptionId
              ? (() => {
                  const app = applications.find((a) => !isPlaceholder(a) && a.id === viewJobDescriptionId) as JobApplication | undefined;
                  return app?.job_description?.trim() ?? "(No description saved)";
                })()
              : ""}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setViewJobDescriptionId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
