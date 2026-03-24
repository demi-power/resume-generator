import { chromium } from "playwright";
import type { ResumeData } from "@/lib/resume-store";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBulletText(value: string): string {
  return escapeHtml(value).replace(/\n+/g, "<br />");
}

export function renderResumeDataToHtml(data: ResumeData, options?: { heading?: string; subheading?: string }): string {
  const heading = options?.heading ? `<div class="meta-heading">${escapeHtml(options.heading)}</div>` : "";
  const subheading = options?.subheading ? `<div class="meta-subheading">${escapeHtml(options.subheading)}</div>` : "";
  const contactParts = [data.profile.email, data.profile.phone, data.profile.linkedin, data.profile.website].filter(Boolean);
  const summaryHtml = data.profile.summary?.trim()
    ? `<section><h2>Summary</h2><p>${renderBulletText(data.profile.summary)}</p></section>`
    : "";
  const experienceHtml = data.experience.length
    ? `<section><h2>Experience</h2>${data.experience
        .map(
          (item) => `
            <article>
              <header>
                <div class="row-between">
                  <strong>${escapeHtml(item.company)}</strong>
                  <span>${escapeHtml([item.startDate, item.endDate].filter(Boolean).join(" - "))}</span>
                </div>
                <div class="role">${escapeHtml(item.role)}</div>
              </header>
              <p>${renderBulletText(item.description)}</p>
            </article>`
        )
        .join("")}</section>`
    : "";
  const educationHtml = data.education.length
    ? `<section><h2>Education</h2>${data.education
        .map(
          (item) => `
            <article>
              <div class="row-between">
                <strong>${escapeHtml(item.school)}</strong>
                <span>${escapeHtml([item.startDate, item.endDate].filter(Boolean).join(" - "))}</span>
              </div>
              <div>${escapeHtml([item.degree, item.field].filter(Boolean).join(" - "))}</div>
              ${item.description ? `<p>${renderBulletText(item.description)}</p>` : ""}
            </article>`
        )
        .join("")}</section>`
    : "";
  const skillsHtml = data.skills.length
    ? `<section><h2>Skills</h2><ul class="skill-list">${data.skills
        .map((item) => `<li><span>${escapeHtml(item.category || "Skill")}</span><strong>${escapeHtml(item.name)}</strong></li>`)
        .join("")}</ul></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(data.profile.name || "Resume")}</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f5f0e8; color: #1f1a17; }
      .page { width: 8.5in; min-height: 11in; margin: 0 auto; background: white; padding: 0.7in; box-sizing: border-box; }
      h1 { margin: 0; font-size: 28px; letter-spacing: 0.01em; }
      .title { margin-top: 6px; font-size: 15px; color: #6b5c52; }
      .contact { margin-top: 10px; font-size: 12px; color: #463d37; }
      section { margin-top: 18px; }
      h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.16em; border-bottom: 1px solid #d8cabc; padding-bottom: 4px; }
      article { margin-bottom: 12px; }
      p { margin: 6px 0 0; font-size: 12px; line-height: 1.45; white-space: normal; }
      .row-between { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
      .role { margin-top: 2px; font-size: 12px; color: #6b5c52; }
      .meta-heading, .meta-subheading { font-size: 11px; color: #8a7666; text-transform: uppercase; letter-spacing: 0.12em; }
      .meta-subheading { margin-top: 4px; }
      .skill-list { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
      .skill-list li { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; border-bottom: 1px solid #f0e6dc; padding-bottom: 4px; }
      .skill-list span { color: #7b6a5f; }
    </style>
  </head>
  <body>
    <div class="page">
      ${heading}
      ${subheading}
      <h1>${escapeHtml(data.profile.name || "Resume")}</h1>
      <div class="title">${escapeHtml(data.profile.title || "")}</div>
      ${contactParts.length ? `<div class="contact">${contactParts.map(escapeHtml).join(" • ")}</div>` : ""}
      ${summaryHtml}
      ${experienceHtml}
      ${skillsHtml}
      ${educationHtml}
    </div>
  </body>
</html>`;
}

export async function renderResumePdfBuffer(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1275, height: 1650 } });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.emulateMedia({ media: "screen" });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.35in", right: "0.35in", bottom: "0.35in", left: "0.35in" } });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
