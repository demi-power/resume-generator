import { NextResponse } from "next/server";
import { processNextUnifiedTask } from "@/lib/unified/queue";
import { requireUnifiedTaskOperator } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const operator = requireUnifiedTaskOperator(request);
  if (operator instanceof NextResponse) return operator;
  const body = (await request.json().catch(() => ({}))) as {
    workerId?: string;
    taskTypes?: Array<"job_extract" | "job_rank" | "tailor_local">;
  };
  const workerId = body.workerId?.trim() || (operator.kind === "worker" ? operator.id : "inline-" + operator.user.id);
  const result = await processNextUnifiedTask({ workerId, taskTypes: body.taskTypes });
  if (!result) {
    return NextResponse.json({ item: null, processed: false });
  }
  return NextResponse.json({ item: result.task, result: result.result, processed: true });
}
