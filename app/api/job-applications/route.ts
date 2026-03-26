import { NextResponse } from "next/server";
import { listJobApplications, createJobApplication } from "@/lib/db";
import { getUnifiedJobSummary } from "@/lib/unified/store";
import { requireActiveUser } from "@/lib/auth";

function withUnifiedJob(row: Record<string, unknown>) {
  const unifiedJobId = typeof row.unified_job_id === "string" ? row.unified_job_id.trim() : "";
  if (!unifiedJobId) return row;
  return {
    ...row,
    unifiedJob: getUnifiedJobSummary(unifiedJobId) ?? null,
  };
}

export async function GET(request: Request) {
  try {
    const r = requireActiveUser(request);
    if ("status" in r) return NextResponse.json({ error: r.status === 403 ? "Account inactive" : "Unauthorized" }, { status: r.status });
    const user = r.user;
    const { searchParams } = new URL(request.url);
    const profileId =
      user.role === "admin"
        ? searchParams.get("profile_id") ?? undefined
        : user.assigned_profile_id ?? undefined;
    if (user.role === "user" && !profileId) {
      return NextResponse.json([], { status: 200 });
    }
    const rows = listJobApplications(profileId);
    return NextResponse.json(rows.map((row) => withUnifiedJob(row as unknown as Record<string, unknown>)));
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to list job applications" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const r = requireActiveUser(request);
    if ("status" in r) return NextResponse.json({ error: r.status === 403 ? "Account inactive" : "Unauthorized" }, { status: r.status });
    const user = r.user;
    const body = await request.json();
    let date: string;
    if ("date" in body) {
      // Allow explicit empty string for date (keeps cell visually empty).
      date = typeof body.date === "string" ? body.date.trim() : "";
    } else {
      // If date is omitted entirely, default to today.
      date = new Date().toISOString().slice(0, 10);
    }
    const company_name =
      typeof body.company_name === "string" ? body.company_name.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const job_url =
      typeof body.job_url === "string" ? body.job_url.trim() || null : null;
    let profile_id =
      typeof body.profile_id === "string" ? body.profile_id || null : null;
    if (user.role === "user") {
      profile_id = user.assigned_profile_id;
    }
    // Allow explicit "" so new row has empty resume file cell (no auto-fill).
    const resume_file_name =
      typeof body.resume_file_name === "string" ? body.resume_file_name.trim() : null;
    const job_description =
      typeof body.job_description === "string" ? body.job_description : "";
    const applied_manually =
      typeof body.applied_manually === "boolean" || typeof body.applied_manually === "number"
        ? body.applied_manually
        : 0;
    const gpt_chat_url =
      typeof body.gpt_chat_url === "string" ? body.gpt_chat_url.trim() || null : null;
    const row = createJobApplication({
      date,
      company_name,
      title,
      job_url,
      profile_id,
      resume_file_name,
      job_description,
      applied_manually,
      gpt_chat_url,
    });
    return NextResponse.json(withUnifiedJob(row as unknown as Record<string, unknown>));
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Failed to create job application" },
      { status: 500 }
    );
  }
}
