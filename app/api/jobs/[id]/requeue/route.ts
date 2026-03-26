import { NextResponse } from "next/server";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { enqueueJobExtraction, enqueueJobFetch, enqueueJobRanking, getJobStatus, retryTailorVerifyTask } from "@/lib/unified/store";

export const runtime = "nodejs";

type RequeueStage = "job_fetch" | "job_extract" | "job_rank" | "tailor_verify";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { stage?: RequeueStage };
  const stage = body.stage;
  if (!stage) {
    return NextResponse.json({ error: "stage is required" }, { status: 400 });
  }

  let task: Record<string, unknown> | null = null;
  if (stage === "job_fetch") {
    task = enqueueJobFetch(id, user.id);
  } else if (stage === "job_extract") {
    task = enqueueJobExtraction(id, user.id);
  } else if (stage === "job_rank") {
    task = enqueueJobRanking(id, user.id);
  } else if (stage === "tailor_verify") {
    const job = getJobStatus(id) as ({ latestTailorTask?: { id?: string | null } | null } & Record<string, unknown>) | undefined;
    const tailorTaskId = job?.latestTailorTask?.id;
    if (!tailorTaskId) {
      return NextResponse.json({ error: "No tailor task is available to verify" }, { status: 400 });
    }
    task = retryTailorVerifyTask(String(tailorTaskId), user.id);
  } else {
    return NextResponse.json({ error: "Unsupported stage" }, { status: 400 });
  }

  if (!task) {
    return NextResponse.json({ error: "Unable to queue requested stage" }, { status: 400 });
  }

  return NextResponse.json({ job: getJobStatus(id), task, queued: true }, { status: 202 });
}
