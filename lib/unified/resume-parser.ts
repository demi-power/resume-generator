import type { Education, Experience, ResumeData, Skill } from "@/lib/resume-store";
import type { ImportedResumeDocument, ParsedResumeSourceMeta, ResumeChunk } from "@/lib/unified/types";
import {
  createId,
  decodeHtmlEntities,
  extractLikelyTechnologies,
  normalizeWhitespace,
  sanitizeRelativePath,
  sentenceSplit,
  tokenizeText,
} from "@/lib/unified/utils";

const SECTION_ALIASES: Record<string, string> = {
  summary: "summary",
  profile: "summary",
  "professional summary": "summary",
  experience: "experience",
  "work experience": "experience",
  "professional experience": "experience",
  skills: "skills",
  "technical skills": "skills",
  education: "education",
  projects: "projects",
  certifications: "certifications",
};

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li.*?>/gi, "- ")
      .replace(/<.*?>/g, " ")
  );
}

function extractLines(html: string): string[] {
  return stripHtml(html)
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function deriveSourceMeta(relativePath: string): ParsedResumeSourceMeta {
  const safePath = sanitizeRelativePath(relativePath);
  const parts = safePath.split("/");
  const fileName = parts[parts.length - 1] ?? "resume.html";
  const stem = fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName || "Resume";
  return {
    relativePath: safePath,
    profileName: parts[0] || stem,
    dateLabel: parts.length >= 2 ? parts[1] : null,
    variantName: parts.length >= 3 ? parts[2] : stem,
    fileName,
  };
}

function canonicalHeading(line: string): string | null {
  const cleaned = line.replace(/[:-]+$/, "").trim().toLowerCase();
  if (cleaned.length > 40) return null;
  return SECTION_ALIASES[cleaned] ?? null;
}

function splitSections(lines: string[]): Record<string, string> {
  const sections: Record<string, string[]> = { intro: [] };
  let current = "intro";
  for (const line of lines) {
    const heading = canonicalHeading(line);
    if (heading) {
      current = heading;
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (!sections[current]) sections[current] = [];
    sections[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(sections)
      .map(([key, value]) => [key, value.join("\n").trim()])
      .filter(([, value]) => Boolean(value))
  );
}

function detectEmail(text: string): string {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
}

function detectPhone(text: string): string {
  return text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/)?.[0] ?? "";
}

function detectWebsite(text: string): string {
  return text.match(/https?:\/\/\S+/i)?.[0] ?? "";
}

function detectLinkedIn(text: string): string {
  return text.match(/https?:\/\/\S*linkedin\.com\S*/i)?.[0] ?? "";
}

function buildSkills(skillsSection: string, rawText: string): Skill[] {
  const fromSection = skillsSection
    .split(/[\n,;|]+/)
    .map((item) => item.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
  const technologies = extractLikelyTechnologies(rawText);
  const names = Array.from(new Set([...fromSection, ...technologies])).slice(0, 30);
  return names.map((name) => ({
    id: createId(),
    name,
    category: technologies.includes(name) ? "Technology" : "General",
  }));
}

function parseExperienceBlock(block: string): Experience {
  const lines = block.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const headline = lines[0] ?? "Experience";
  const headlineParts = headline.split(/\s+[|-]\s+/);
  const company = headlineParts[0] || "Experience";
  const role = headlineParts[1] || headlineParts[0] || "Experience";
  const dateMatch = block.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{4})\s*(?:-|to|–)\s*((?:Present|Current|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{4}))/i);
  const description = lines.slice(1).join("\n") || sentenceSplit(block).slice(1).join("\n");
  return {
    id: createId(),
    company,
    role,
    startDate: dateMatch?.[1]?.trim() ?? "",
    endDate: dateMatch?.[2]?.trim() ?? "",
    current: /present|current/i.test(dateMatch?.[2] ?? ""),
    description: description.trim() || block.trim(),
  };
}

function buildExperience(experienceSection: string): Experience[] {
  if (!experienceSection.trim()) return [];
  const blocks = experienceSection
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  const sourceBlocks = blocks.length ? blocks : [experienceSection];
  return sourceBlocks.slice(0, 8).map(parseExperienceBlock);
}

function buildEducation(educationSection: string): Education[] {
  if (!educationSection.trim()) return [];
  const blocks = educationSection
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.slice(0, 4).map((block) => {
    const lines = block.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    return {
      id: createId(),
      school: lines[0] ?? "Education",
      degree: lines[1] ?? "",
      field: "",
      startDate: "",
      endDate: "",
      description: lines.slice(2).join("\n") || undefined,
    };
  });
}

function buildChunks(sections: Record<string, string>, experience: Experience[]): ResumeChunk[] {
  const chunks: ResumeChunk[] = [];
  for (const [section, text] of Object.entries(sections)) {
    if (!text.trim()) continue;
    chunks.push({
      id: createId(),
      section,
      text,
      keywords: Array.from(new Set(tokenizeText(text))).slice(0, 20),
    });
  }
  for (const item of experience) {
    chunks.push({
      id: createId(),
      section: "experience",
      text: `${item.company} ${item.role}\n${item.description}`.trim(),
      keywords: Array.from(new Set(tokenizeText(`${item.company} ${item.role} ${item.description}`))).slice(0, 20),
    });
  }
  return chunks;
}

export function applyResumePatchToResumeData(
  baseResume: ResumeData,
  patch: { summary: string; skillsOrder: string[]; experienceEdits: { experienceId: string; tailoredText: string }[] }
): ResumeData {
  const skillOrder = patch.skillsOrder.map((item) => item.trim()).filter(Boolean);
  const skillRank = new Map(skillOrder.map((name, index) => [name.toLowerCase(), index]));
  const experienceEditMap = new Map(patch.experienceEdits.map((item) => [item.experienceId, item.tailoredText]));
  return {
    ...baseResume,
    profile: {
      ...baseResume.profile,
      summary: patch.summary?.trim() || baseResume.profile.summary,
    },
    skills: [...baseResume.skills].sort((left, right) => {
      const leftRank = skillRank.get(left.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = skillRank.get(right.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.name.localeCompare(right.name);
    }),
    experience: baseResume.experience.map((item) => ({
      ...item,
      description: experienceEditMap.get(item.id)?.trim() || item.description,
    })),
  };
}

export function parseImportedResumeHtml(relativePath: string, html: string): ImportedResumeDocument {
  const source = deriveSourceMeta(relativePath);
  const lines = extractLines(html);
  const sections = splitSections(lines);
  const headerLines = (sections.intro ?? "").split(/\n+/).filter(Boolean);
  const rawText = normalizeWhitespace(lines.join("\n"));
  const skills = buildSkills(sections.skills ?? "", rawText);
  const experience = buildExperience(sections.experience ?? "");
  const education = buildEducation(sections.education ?? "");
  const summary = sections.summary ?? sentenceSplit(rawText).slice(0, 2).join(" ");
  const name = headerLines[0] ?? source.profileName;
  const title = headerLines[1] ?? source.variantName;
  const resumeData: ResumeData = {
    profile: {
      name,
      title,
      email: detectEmail(rawText),
      phone: detectPhone(rawText),
      address: "",
      city: "",
      state: "",
      postalCode: "",
      location: "",
      birthday: "",
      summary: summary.trim(),
      linkedin: detectLinkedIn(rawText),
      website: detectWebsite(rawText),
    },
    experience,
    education,
    skills,
  };
  return {
    source,
    rawText,
    sections,
    chunks: buildChunks(sections, experience),
    resumeData,
  };
}
