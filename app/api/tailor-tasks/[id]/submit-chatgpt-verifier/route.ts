import { NextResponse } from "next/server";
import type { VerifierResult } from "@/lib/unified/types";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { submitChatGptVerifierTask } from "@/lib/unified/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = (await request.json()) as { gptChatUrl?: string | null; verifier?: VerifierResult };
  if (!body.verifier) {
    return NextResponse.json({ error: "verifier is required" }, { status: 400 });
  }
  return NextResponse.json(await submitChatGptVerifierTask({ taskId: id, gptChatUrl: body.gptChatUrl ?? null, verifier: body.verifier }));
}
