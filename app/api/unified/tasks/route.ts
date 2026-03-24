import { NextResponse } from "next/server";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { listUnifiedTasks } from "@/lib/unified/queue";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const url = new URL(request.url);
  const status = url.searchParams.getAll("status") as Array<"queued" | "claimed" | "completed" | "failed">;
  const jobId = url.searchParams.get("jobId");
  const tailorTaskId = url.searchParams.get("tailorTaskId");
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue ? Number(limitValue) : 50;
  return NextResponse.json({ items: listUnifiedTasks({ statuses: status.length > 0 ? status : undefined, jobId, tailorTaskId, limit }) });
}
