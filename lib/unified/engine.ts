import { chromium } from "playwright";
import type { ResumeData } from "@/lib/resume-store";
import { applyResumePatchToResumeData, parseImportedResumeHtml } from "@/lib/unified/resume-parser";
import type {
  ImportedResumeDocument,
  JobFetchResultCode,
  JobProfile,
  RankedResumeCandidate,
  ResumePatch,
  VerifierResult,
} from "@/lib/unified/types";
import { clampScore, extractLikelyTechnologies, pickTop, sentenceSplit, tokenizeText, uniqueTokens } from "@/lib/unified/utils";

export interface JobFetchResult {
  code: JobFetchResultCode;
  method: "direct_html" | "playwright" | "invalid";
  canonicalUrl: string;
  title: string;
  text: string;
  rawHtml: string;
  statusCode?: number;
  error?: string;
}

function htmlToText(html: string): string {
  return parseImportedResumeHtml("_job/job.html", html).rawText;
}

function extractTitleFromTitleTag(pageTitle: string): { title: string; company: string } {
  const trimmed = pageTitle.trim();
  if (!trimmed) return { title: "", company: "" };
  const separators = [" at ", " - ", " | "];
  for (const separator of separators) {
    const parts = trimmed.split(separator);
    if (parts.length >= 2) {
      return { title: parts[0].trim(), company: parts[1].trim() };
    }
  }
  return { title: trimmed, company: "" };
}

function classifyFetchFailure(statusCode: number, bodyText: string): JobFetchResultCode {
  const haystack = bodyText.toLowerCase();
  if (statusCode === 404 || statusCode === 410) return "EXPIRED";
  if (statusCode === 401 || statusCode === 403) return "AUTH_REQUIRED";
  if (statusCode === 429 || haystack.includes("captcha")) return "CAPTCHA_BLOCKED";
  if (haystack.includes("job is no longer available") || haystack.includes("no longer accepting applications")) return "EXPIRED";
  return "RETRYABLE_ERROR";
}

async function directFetch(url: string): Promise<JobFetchResult> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      },
      redirect: "follow",
    });
    const html = await response.text();
    const titleMatch = html.match(/<title.*?>(.*?)<\/title>/is);
    const pageTitle = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const text = htmlToText(html);
    if (!response.ok) {
      return {
        code: classifyFetchFailure(response.status, html),
        method: "direct_html",
        canonicalUrl: url,
        title: pageTitle,
        text,
        rawHtml: html,
        statusCode: response.status,
        error: `Direct fetch failed with ${response.status}`,
      };
    }
    if (text.trim().length < 400) {
      return {
        code: "CONTENT_TOO_THIN",
        method: "direct_html",
        canonicalUrl: url,
        title: pageTitle,
        text,
        rawHtml: html,
        statusCode: response.status,
        error: "Fetched HTML but extracted text was too thin",
      };
    }
    return {
      code: "SUCCESS",
      method: "direct_html",
      canonicalUrl: url,
      title: pageTitle,
      text,
      rawHtml: html,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      code: "RETRYABLE_ERROR",
      method: "direct_html",
      canonicalUrl: url,
      title: "",
      text: "",
      rawHtml: "",
      error: error instanceof Error ? error.message : "Unknown fetch failure",
    };
  }
}

async function playwrightFetch(url: string): Promise<JobFetchResult> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const html = await page.content();
    const text = htmlToText(html);
    const pageTitle = await page.title();
    if (!text.trim()) {
      return {
        code: "CONTENT_TOO_THIN",
        method: "playwright",
        canonicalUrl: url,
        title: pageTitle,
        text,
        rawHtml: html,
        statusCode: response?.status(),
        error: "Playwright rendered page but text extraction remained thin",
      };
    }
    return {
      code: text.trim().length < 400 ? "CONTENT_TOO_THIN" : "SUCCESS",
      method: "playwright",
      canonicalUrl: url,
      title: pageTitle,
      text,
      rawHtml: html,
      statusCode: response?.status(),
    };
  } catch (error) {
    return {
      code: "PERMANENT_ERROR",
      method: "playwright",
      canonicalUrl: url,
      title: "",
      text: "",
      rawHtml: "",
      error: error instanceof Error ? error.message : "Unknown Playwright failure",
    };
  } finally {
    await browser.close();
  }
}

export async function fetchJobContent(canonicalUrl: string): Promise<JobFetchResult> {
  let direct = await directFetch(canonicalUrl);
  if (direct.code === "SUCCESS") return direct;
  if (direct.code === "EXPIRED" || direct.code === "AUTH_REQUIRED" || direct.code === "CAPTCHA_BLOCKED") return direct;
  const rendered = await playwrightFetch(canonicalUrl);
  if (rendered.code === "SUCCESS") return rendered;
  return rendered.text.length > direct.text.length ? rendered : direct;
}

function inferWorkModel(text: string): JobProfile["workModel"] {
  const haystack = text.toLowerCase();
  if (haystack.includes("hybrid")) return "hybrid";
  if (haystack.includes("remote") || haystack.includes("work from home") || haystack.includes("distributed")) return "remote";
  if (haystack.includes("onsite") || haystack.includes("on-site") || haystack.includes("in office")) return "onsite";
  return "unknown";
}

function inferSeniority(text: string): JobProfile["seniority"] {
  const haystack = text.toLowerCase();
  if (haystack.includes("principal")) return "principal";
  if (haystack.includes("staff")) return "staff";
  if (haystack.includes("senior")) return "senior";
  if (haystack.includes("junior") || haystack.includes("entry level")) return "junior";
  if (haystack.includes("mid") || haystack.includes("intermediate")) return "mid";
  return "unknown";
}

function inferDomain(text: string): string[] {
  const haystack = text.toLowerCase();
  const domains: string[] = [];
  if (haystack.includes("frontend") || haystack.includes("ui") || haystack.includes("browser")) domains.push("frontend");
  if (haystack.includes("backend") || haystack.includes("api") || haystack.includes("distributed systems")) domains.push("backend");
  if (haystack.includes("data") || haystack.includes("etl") || haystack.includes("analytics")) domains.push("data");
  if (haystack.includes("machine learning") || haystack.includes("llm") || haystack.includes("ai")) domains.push("ai");
  if (haystack.includes("devops") || haystack.includes("infrastructure") || haystack.includes("platform")) domains.push("platform");
  return domains;
}

export function extractJobProfile(input: {
  pageTitle: string;
  descriptionText: string;
  titleHint?: string | null;
  companyHint?: string | null;
}): JobProfile {
  const lines = input.descriptionText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const titleParts = extractTitleFromTitleTag(input.pageTitle);
  const title = input.titleHint?.trim() || titleParts.title || lines[0] || "Unknown Role";
  const company = input.companyHint?.trim() || titleParts.company;
  const technologies = extractLikelyTechnologies(input.descriptionText);
  const keywords = pickTop(uniqueTokens(`${title} ${input.descriptionText}`), 30);
  const primaryStack = technologies.slice(0, 8);
  const secondaryStack = technologies.slice(8, 16);
  const tools = technologies.filter((term) => ["AWS", "Azure", "GCP", "Docker", "Kubernetes", "Terraform", "GitHub Actions", "CircleCI", "Jenkins"].includes(term));
  const hardStops: string[] = [];
  const haystack = input.descriptionText.toLowerCase();
  if (haystack.includes("clearance")) hardStops.push("clearance");
  if (haystack.includes("u.s. citizens") || haystack.includes("us citizens")) hardStops.push("us_only");
  if (haystack.includes("must be onsite") || haystack.includes("5 days onsite")) hardStops.push("onsite_required");
  return {
    title,
    company,
    location: lines.find((line) => /remote|hybrid|onsite|on-site|[A-Z]{2}/.test(line)) ?? "",
    workModel: inferWorkModel(`${title}\n${input.descriptionText}`),
    seniority: inferSeniority(`${title}\n${input.descriptionText}`),
    primaryStack,
    secondaryStack,
    tools,
    keywords,
    domain: inferDomain(`${title}\n${input.descriptionText}`),
    summary: sentenceSplit(input.descriptionText).slice(0, 3).join(" "),
    hardStops,
    confidence: clampScore((primaryStack.length > 0 ? 0.45 : 0.2) + (title ? 0.25 : 0) + (company ? 0.15 : 0) + (keywords.length > 10 ? 0.15 : 0.05)),
  };
}

function overlapRatio(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const matches = left.filter((item) => rightSet.has(item)).length;
  return matches / Math.max(left.length, 1);
}

function scoreAlignment(job: JobProfile, resumeData: ResumeData): number {
  let score = 0;
  const title = `${resumeData.profile.title} ${resumeData.profile.summary}`.toLowerCase();
  const domains = inferDomain(`${resumeData.profile.title}\n${resumeData.profile.summary}\n${resumeData.experience.map((item) => item.description).join("\n")}`);
  if (job.seniority !== "unknown" && title.includes(job.seniority)) score += 0.4;
  if (job.domain.some((item) => domains.includes(item))) score += 0.4;
  if (job.workModel !== "unknown" && title.includes(job.workModel)) score += 0.2;
  return clampScore(score);
}

function chunkSupportScore(jobTokens: string[], doc: ImportedResumeDocument): { score: number; chunkIds: string[] } {
  const ranked = doc.chunks
    .map((chunk) => ({
      id: chunk.id,
      score: overlapRatio(jobTokens, chunk.keywords),
    }))
    .sort((left, right) => right.score - left.score);
  const top = pickTop(ranked, 5);
  return {
    score: clampScore(top.reduce((sum, item) => sum + item.score, 0) / Math.max(top.length, 1)),
    chunkIds: top.filter((item) => item.score > 0).map((item) => item.id),
  };
}

export function rankResumeDocuments(
  jobProfile: JobProfile,
  resumes: Array<{ snapshotId: string; variantId: string; profileName: string; variantName: string; document: ImportedResumeDocument }>
): RankedResumeCandidate[] {
  const jobTokens = uniqueTokens(`${jobProfile.title} ${jobProfile.summary} ${jobProfile.primaryStack.join(" ")} ${jobProfile.secondaryStack.join(" ")} ${jobProfile.tools.join(" ")} ${jobProfile.keywords.join(" ")}`);
  return resumes
    .map(({ snapshotId, variantId, profileName, variantName, document }) => {
      const resumeText = [
        document.resumeData.profile.title,
        document.resumeData.profile.summary,
        document.resumeData.skills.map((item) => item.name).join(" "),
        document.resumeData.experience.map((item) => `${item.company} ${item.role} ${item.description}`).join(" "),
      ].join(" ");
      const resumeTokens = uniqueTokens(resumeText);
      const similarityScore = clampScore(overlapRatio(jobTokens, resumeTokens));
      const resumeSkills = document.resumeData.skills.map((item) => item.name.toLowerCase());
      const mustHaveCoverage = overlapRatio(jobProfile.primaryStack.map((item) => item.toLowerCase()), resumeSkills);
      const secondaryCoverage = overlapRatio(
        [...jobProfile.secondaryStack, ...jobProfile.tools].map((item) => item.toLowerCase()),
        resumeSkills
      );
      const alignmentScore = scoreAlignment(jobProfile, document.resumeData);
      const chunkSupport = chunkSupportScore(jobTokens, document);
      const ruleScore = clampScore((0.45 * mustHaveCoverage) + (0.2 * secondaryCoverage) + (0.2 * alignmentScore) + (0.15 * chunkSupport.score));
      const rerankScore = clampScore((similarityScore + mustHaveCoverage + chunkSupport.score) / 3);
      const hybridScore = clampScore(
        (0.35 * similarityScore) +
          (0.25 * mustHaveCoverage) +
          (0.15 * secondaryCoverage) +
          (0.15 * alignmentScore) +
          (0.10 * chunkSupport.score)
      );
      const matchedRequirements = jobProfile.primaryStack.filter((item) => resumeSkills.includes(item.toLowerCase()));
      const missingRequirements = jobProfile.primaryStack.filter((item) => !resumeSkills.includes(item.toLowerCase()));
      let decision: RankedResumeCandidate["decision"] = "need_tailor";
      if (jobProfile.hardStops.includes("clearance") && !resumeText.toLowerCase().includes("clearance")) {
        decision = "not_eligible";
      } else if (matchedRequirements.length >= Math.max(1, Math.ceil(jobProfile.primaryStack.length * 0.7)) && hybridScore >= 0.65) {
        decision = "use_as_is";
      } else if (matchedRequirements.length >= Math.max(1, Math.ceil(jobProfile.primaryStack.length * 0.5)) || hybridScore >= 0.5) {
        decision = "review";
      }
      return {
        resumeSnapshotId: snapshotId,
        resumeVariantId: variantId,
        profileName,
        variantName,
        similarityScore,
        ruleScore,
        rerankScore,
        hybridScore,
        decision,
        reason: matchedRequirements.length
          ? `Matched ${matchedRequirements.length} core requirements and ${chunkSupport.chunkIds.length} strong evidence chunks.`
          : "Low must-have overlap; tailoring or manual review is required.",
        matchedRequirements,
        missingRequirements,
        supportingChunkIds: chunkSupport.chunkIds,
      };
    })
    .sort((left, right) => right.hybridScore - left.hybridScore);
}

export function generateTailoredPatch(
  baseDocument: ImportedResumeDocument,
  jobProfile: JobProfile,
  match: RankedResumeCandidate,
  providerId: "deepseek_webview" | "local_ollama"
): ResumePatch {
  const matchedSkills = baseDocument.resumeData.skills
    .map((item) => item.name)
    .filter((name) => match.matchedRequirements.some((req) => req.toLowerCase() === name.toLowerCase()));
  const remainingSkills = baseDocument.resumeData.skills.map((item) => item.name).filter((name) => !matchedSkills.includes(name));
  const prioritizedSkills = [...matchedSkills, ...remainingSkills].slice(0, 20);
  const experienceEdits = baseDocument.resumeData.experience.slice(0, 3).map((item) => ({
    experienceId: item.id,
    originalText: item.description,
    tailoredText: item.description,
  }));
  const summaryPrefix = match.matchedRequirements.length
    ? `Targeting ${jobProfile.title} work emphasizing ${match.matchedRequirements.slice(0, 4).join(", ")}.`
    : `Targeting ${jobProfile.title}.`;
  return {
    summary: [summaryPrefix, baseDocument.resumeData.profile.summary].filter(Boolean).join(" ").trim(),
    skillsOrder: prioritizedSkills,
    experienceEdits,
    removedItems: [],
    coverageNotes: match.missingRequirements.map((item) => `Requirement not yet evidenced in source resume: ${item}`),
    providerMetadata: {
      requested_provider: providerId,
      effective_provider: "heuristic",
      configured_model: process.env.LOCAL_OLLAMA_MODEL || "qwen2.5:7b-instruct",
    },
  };
}

function findInventedNumbers(baseResume: ResumeData, patch: ResumePatch): string[] {
  const baseNumbers = new Set((JSON.stringify(baseResume).match(/\d+(?:\.\d+)?/g) ?? []));
  const patchNumbers = new Set((JSON.stringify(patch).match(/\d+(?:\.\d+)?/g) ?? []));
  return Array.from(patchNumbers).filter((item) => !baseNumbers.has(item));
}

export function verifyTailoredPatch(baseDocument: ImportedResumeDocument, patch: ResumePatch, jobProfile: JobProfile): VerifierResult {
  const violations: VerifierResult["violations"] = [];
  const baseSkills = new Set(baseDocument.resumeData.skills.map((item) => item.name.toLowerCase()));
  const allowedTechnologies = new Set(
    [...baseDocument.resumeData.skills.map((item) => item.name), ...jobProfile.primaryStack, ...jobProfile.secondaryStack, ...jobProfile.tools]
      .map((item) => item.toLowerCase())
  );
  if (!patch.summary.trim()) {
    violations.push({ type: "format_violation", message: "Tailored summary is empty." });
  }
  for (const skill of patch.skillsOrder) {
    if (!baseSkills.has(skill.toLowerCase())) {
      violations.push({ type: "format_violation", message: `Tailored skills contain an unknown skill ordering entry: ${skill}` });
    }
  }
  for (const tech of extractLikelyTechnologies(JSON.stringify(patch))) {
    if (!allowedTechnologies.has(tech.toLowerCase())) {
      violations.push({ type: "invented_tool", message: `Patch introduced unsupported technology: ${tech}` });
    }
  }
  const inventedNumbers = findInventedNumbers(baseDocument.resumeData, patch);
  for (const number of inventedNumbers) {
    violations.push({ type: "invented_metric", message: `Patch introduced unsupported numeric claim: ${number}` });
  }
  const summaryTokens = tokenizeText(patch.summary);
  for (const keyword of jobProfile.primaryStack.slice(0, 4)) {
    if (jobProfile.primaryStack.length && !summaryTokens.includes(keyword.toLowerCase()) && !patch.skillsOrder.some((item) => item.toLowerCase() === keyword.toLowerCase())) {
      violations.push({ type: "missing_required_keyword", message: `Tailored output still does not foreground ${keyword}.` });
    }
  }
  const repeated = new Map<string, number>();
  for (const token of summaryTokens) {
    repeated.set(token, (repeated.get(token) ?? 0) + 1);
  }
  for (const [token, count] of repeated.entries()) {
    if (count >= 6) {
      violations.push({ type: "keyword_stuffing", message: `Summary repeats '${token}' too many times.` });
    }
  }
  const uniqueViolationMessages = Array.from(new Map(violations.map((item) => [item.type + item.message, item])).values());
  return {
    pass: uniqueViolationMessages.length === 0,
    violations: uniqueViolationMessages,
    retryInstructions: uniqueViolationMessages.map((item) => item.message),
    qualityScore: clampScore(1 - (uniqueViolationMessages.length * 0.18)),
    humanReviewReason: uniqueViolationMessages.length ? "Verifier blocked the tailored output." : null,
    providerMetadata: {
      verifier: "heuristic",
      configured_model: process.env.LOCAL_OLLAMA_MODEL || "qwen2.5:7b-instruct",
    },
  };
}

export function buildTailoredResume(baseDocument: ImportedResumeDocument, patch: ResumePatch): ResumeData {
  return applyResumePatchToResumeData(baseDocument.resumeData, patch);
}
