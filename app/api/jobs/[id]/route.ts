import { NextResponse } from "next/server";
import { derivePdfBaseUrl } from "@/lib/pdf-render";
import { getUnifiedJobSummary, updateJobResumeFormat } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const item = getUnifiedJobSummary(id);
  if (!item) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  return NextResponse.json({ item });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { resume_format_id?: string | null };
  if (typeof body.resume_format_id !== "string" || !body.resume_format_id.trim()) {
    return NextResponse.json({ error: "resume_format_id is required" }, { status: 400 });
  }
  const item = await updateJobResumeFormat({
    jobId: id,
    resumeFormatId: body.resume_format_id,
    pdfBaseUrl: derivePdfBaseUrl({ requestUrl: request.url }),
  });
  return NextResponse.json({ item });
}
