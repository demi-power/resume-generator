import { NextResponse } from "next/server";
import {
  getJobApplication,
  updateJobApplication,
  deleteJobApplication,
} from "@/lib/db";
import { derivePdfBaseUrl } from "@/lib/pdf-render";
import { getUnifiedJobSummary, updateJobResumeFormat } from "@/lib/unified/store";
import { requireUser } from "@/lib/auth";
import { deleteJobApplicationPdfIfExists } from "@/lib/job-application-pdf";

function userCanAccessProfile(user: { role: string; assigned_profile_id: string | null }, profileId: string | null): boolean {
  if (user.role === "admin") return true;
  return profileId !== null && profileId === user.assigned_profile_id;
}

function withUnifiedJob(row: Record<string, unknown>) {
  const unifiedJobId = typeof row.unified_job_id === "string" ? row.unified_job_id.trim() : "";
  if (!unifiedJobId) return row;
  return {
    ...row,
    unifiedJob: getUnifiedJobSummary(unifiedJobId) ?? null,
  };
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
      return NextResponse.json(
        { error: "Job application not found" },
        { status: 404 }
      );
    }
    if (!userCanAccessProfile(user, row.profile_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(withUnifiedJob(row as unknown as Record<string, unknown>));
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to get job application" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = requireUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const existing = getJobApplication(id);
    if (!existing) {
      return NextResponse.json({ error: "Job application not found" }, { status: 404 });
    }
    if (!userCanAccessProfile(user, existing.profile_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await request.json();
    const updates: {
      date?: string;
      company_name?: string;
      title?: string;
      job_url?: string | null;
      profile_id?: string | null;
      resume_format_id?: string | null;
      resume_file_name?: string | null;
      job_description?: string | null;
      applied_manually?: number | boolean;
      gpt_chat_url?: string | null;
    } = {};
    if (typeof body.date === "string") updates.date = body.date.trim();
    if (typeof body.company_name === "string")
      updates.company_name = body.company_name.trim();
    if (typeof body.title === "string") updates.title = body.title.trim();
    if ("job_url" in body)
      updates.job_url =
        typeof body.job_url === "string" ? body.job_url.trim() || null : null;
    if ("profile_id" in body)
      updates.profile_id =
        user.role === "admin"
          ? (typeof body.profile_id === "string" ? body.profile_id || null : null)
          : user.assigned_profile_id;
    if ("resume_format_id" in body) {
      updates.resume_format_id =
        typeof body.resume_format_id === "string" ? body.resume_format_id.trim() || "format1" : "format1";
    }
    if (typeof body.resume_file_name === "string")
      updates.resume_file_name = body.resume_file_name.trim() || null;
    if ("job_description" in body)
      updates.job_description =
        typeof body.job_description === "string" ? body.job_description : "";
    if ("applied_manually" in body) {
      if (typeof body.applied_manually === "boolean" || typeof body.applied_manually === "number") {
        updates.applied_manually = body.applied_manually;
      }
    }
    if ("gpt_chat_url" in body) {
      updates.gpt_chat_url =
        typeof body.gpt_chat_url === "string" ? body.gpt_chat_url.trim() || null : null;
    }
    updateJobApplication(id, updates);
    if (updates.resume_format_id && existing.unified_job_id) {
      await updateJobResumeFormat({
        jobId: existing.unified_job_id,
        resumeFormatId: updates.resume_format_id,
        pdfBaseUrl: derivePdfBaseUrl({ requestUrl: request.url }),
      });
    }
    const row = getJobApplication(id)!;
    return NextResponse.json(withUnifiedJob(row as unknown as Record<string, unknown>));
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to update job application" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = requireUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const existing = getJobApplication(id);
    if (!existing) {
      return NextResponse.json({ error: "Job application not found" }, { status: 404 });
    }
    if (!userCanAccessProfile(user, existing.profile_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    deleteJobApplicationPdfIfExists(id);
    deleteJobApplication(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to delete job application" },
      { status: 500 }
    );
  }
}
