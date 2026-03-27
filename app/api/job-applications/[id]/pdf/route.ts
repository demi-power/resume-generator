import { NextResponse } from "next/server";
import { getJobApplication, updateJobApplication } from "@/lib/db";
import { readJobApplicationPdf, saveJobApplicationPdf } from "@/lib/job-application-pdf";
import { requireUser } from "@/lib/auth";

function userCanAccessProfile(user: { role: string; assigned_profile_id: string | null }, profileId: string | null): boolean {
  if (user.role === "admin") return true;
  return profileId !== null && profileId === user.assigned_profile_id;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = requireUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const row = getJobApplication(id);
    if (!row) {
      return NextResponse.json({ error: "Job application not found" }, { status: 404 });
    }
    if (!userCanAccessProfile(user, row.profile_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const pdf = readJobApplicationPdf(id);
    if (!pdf) {
      return NextResponse.json({ error: "PDF not found for this application" }, { status: 404 });
    }
    try {
      const now = new Date().toISOString();
      updateJobApplication(id, { last_resume_download_at: now });
    } catch (e) {
      console.error("Failed to update last_resume_download_at on download", e);
    }
    const fileName = row.resume_file_name || "resume.pdf";
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
      },
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to read application PDF" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = requireUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const row = getJobApplication(id);
    if (!row) {
      return NextResponse.json({ error: "Job application not found" }, { status: 404 });
    }
    if (!userCanAccessProfile(user, row.profile_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const buffer = await request.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      return NextResponse.json({ error: "Empty PDF body" }, { status: 400 });
    }
    saveJobApplicationPdf(id, buffer);
    if (!row.resume_file_name.trim()) {
      updateJobApplication(id, { resume_file_name: "resume.pdf" });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to save application PDF" },
      { status: 500 }
    );
  }
}
