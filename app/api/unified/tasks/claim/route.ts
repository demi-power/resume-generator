import { NextResponse } from "next/server";
import { claimUnifiedTasks } from "@/lib/unified/queue";
import { requireUnifiedTaskOperator } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const operator = requireUnifiedTaskOperator(request);
  if (operator instanceof NextResponse) return operator;
  const body = (await request.json().catch(() => ({}))) as {
    workerId?: string;
    taskTypes?: Array<"job_extract" | "job_rank" | "tailor_local">;
    maxTasks?: number;
  };
  const workerId = body.workerId?.trim() || (operator.kind === "worker" ? operator.id : "owner-" + operator.user.id);
  return NextResponse.json({ items: claimUnifiedTasks({ workerId, taskTypes: body.taskTypes, maxTasks: body.maxTasks }) });
}
