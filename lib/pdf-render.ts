import { chromium } from "playwright";
import { clearExpiredPdfCache, createToken, setPdfData } from "@/lib/pdf-cache";
import {
  LETTER_VIEWPORT,
  LETTER_VIEWPORT_TALL_HEIGHT,
  PDF_MARGIN_TOP_IN,
  PDF_MARGIN_BOTTOM_IN,
  PDF_MARGIN_LEFT_IN,
  PDF_MARGIN_RIGHT_IN,
} from "@/lib/pdf-constants";
import { type StoredProfileData, type ResumeData } from "@/lib/resume-store";
import {
  FORMAT_IDS,
  formatIdToTemplateId,
  getTemplateStyle,
  templateIdToFormatId,
  type FormatId,
} from "@/lib/template-style-file";

function normalizeResumeFormatId(value: string | null | undefined): FormatId {
  return FORMAT_IDS.includes(value as FormatId) ? (value as FormatId) : "format1";
}

function normalizeResumeSkillsForPdf(data: ResumeData): ResumeData["skills"] {
  const normalizedSkills: ResumeData["skills"] = [];
  let id = 0;
  for (const skill of data.skills ?? []) {
    const category = (skill.category || "").trim() || "Other";
    const names = (skill.name || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const name of names) {
      normalizedSkills.push({
        id: `skill-pdf-${id++}`,
        name,
        category,
      });
    }
  }
  return normalizedSkills;
}

export function prepareResumeDataForPdf(params: {
  data: ResumeData;
  formatId?: string | null;
  templateId?: string | null;
}): {
  formatId: FormatId;
  templateId: string;
  effectiveStyle: ReturnType<typeof getTemplateStyle>;
  data: StoredProfileData;
} {
  const formatId = normalizeResumeFormatId(
    params.formatId ?? (params.templateId ? templateIdToFormatId(params.templateId) : null)
  );
  const templateId = formatIdToTemplateId(formatId) ?? "template-1";
  const effectiveStyle = getTemplateStyle(formatId);
  return {
    formatId,
    templateId,
    effectiveStyle,
    data: {
      ...params.data,
      skills: normalizeResumeSkillsForPdf(params.data),
      style: effectiveStyle,
    },
  };
}

export function derivePdfBaseUrl(params: { requestUrl?: string | null; baseUrl?: string | null } = {}): string {
  const requestUrl = params.requestUrl?.trim();
  let baseUrl = params.baseUrl?.trim() || process.env.PDF_BASE_URL?.trim() || "";
  if (!baseUrl && requestUrl) {
    const url = new URL(requestUrl);
    baseUrl = `${url.protocol}//${url.host}`;
  }
  if (!baseUrl) {
    baseUrl = `http://127.0.0.1:${process.env.PORT?.trim() || "3000"}`;
  }
  if (baseUrl.includes("0.0.0.0")) {
    baseUrl = baseUrl.replace("0.0.0.0", "127.0.0.1");
  }
  return baseUrl.replace(/\/+$/, "");
}

export async function renderResumePdfFromPreparedData(params: {
  data: StoredProfileData;
  templateId: string;
  baseUrl?: string | null;
}): Promise<Buffer> {
  clearExpiredPdfCache();
  const token = createToken();
  setPdfData(token, params.data, params.templateId);
  const targetUrl = `${derivePdfBaseUrl({ baseUrl: params.baseUrl })}/print/preview?token=${encodeURIComponent(token)}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({
      width: LETTER_VIEWPORT.width,
      height: LETTER_VIEWPORT_TALL_HEIGHT,
    });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector('[data-pdf-ready="true"]', { timeout: 20000 });
    await page.waitForTimeout(500);
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: true,
      margin: {
        top: `${PDF_MARGIN_TOP_IN}in`,
        bottom: `${PDF_MARGIN_BOTTOM_IN}in`,
        left: `${PDF_MARGIN_LEFT_IN}in`,
        right: `${PDF_MARGIN_RIGHT_IN}in`,
      },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function renderResumePdfFromFormat(params: {
  data: ResumeData;
  formatId?: string | null;
  templateId?: string | null;
  baseUrl?: string | null;
}): Promise<{
  pdfBuffer: Buffer;
  formatId: FormatId;
  templateId: string;
  effectiveStyle: ReturnType<typeof getTemplateStyle>;
  data: StoredProfileData;
}> {
  const prepared = prepareResumeDataForPdf(params);
  const pdfBuffer = await renderResumePdfFromPreparedData({
    data: prepared.data,
    templateId: prepared.templateId,
    baseUrl: params.baseUrl,
  });
  return {
    pdfBuffer,
    formatId: prepared.formatId,
    templateId: prepared.templateId,
    effectiveStyle: prepared.effectiveStyle,
    data: prepared.data,
  };
}
