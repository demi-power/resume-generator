import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { derivePdfBaseUrl, renderResumePdfFromFormat } from "@/lib/pdf-render";
import { templateIdToFormatId } from "@/lib/template-style-file";
import type { ResumeData } from "@/lib/resume-store";

export async function POST(request: Request) {
  try {
    const user = requireUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json();
    const data = body?.data as ResumeData | undefined;
    const templateId = typeof body?.templateId === "string" ? body.templateId.trim() || undefined : undefined;
    const formatId = typeof body?.formatId === "string" ? body.formatId.trim() || undefined : undefined;
    if (!data || !data.profile || !Array.isArray(data.experience) || !Array.isArray(data.education) || !Array.isArray(data.skills)) {
      return NextResponse.json({ error: "Invalid resume data" }, { status: 400 });
    }
    const pdf = await renderResumePdfFromFormat({
      data,
      formatId: formatId ?? (templateId ? templateIdToFormatId(templateId) : undefined),
      templateId,
      baseUrl: derivePdfBaseUrl({ requestUrl: request.url }),
    });

    const name = data.profile?.name?.trim() || "resume";
    const safeName = name.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "resume";

    return new NextResponse(new Uint8Array(pdf.pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${safeName}.pdf"`,
      },
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
  }
}
