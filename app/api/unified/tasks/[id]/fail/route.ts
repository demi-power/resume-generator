import { NextResponse } from "next/server";
import { failUnifiedTask } from "@/lib/unified/queue";
import { requireUnifiedTaskOperator } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const operator = requireUnifiedTaskOperator(request);
  if (operator instanceof NextResponse) return operator;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { error?: Record<string, unknown>; message?: string };
  const error = body.error ?? { message: body.message || "Task failed" };
  return NextResponse.json({ item: failUnifiedTask(id, error) });
}
