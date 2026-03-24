import { NextResponse } from "next/server";
import { completeUnifiedTask } from "@/lib/unified/queue";
import { requireUnifiedTaskOperator } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const operator = requireUnifiedTaskOperator(request);
  if (operator instanceof NextResponse) return operator;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { result?: Record<string, unknown> };
  return NextResponse.json({ item: completeUnifiedTask(id, body.result ?? {}) });
}
