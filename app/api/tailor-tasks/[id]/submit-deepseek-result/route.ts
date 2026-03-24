import { NextResponse } from "next/server";
import type { ResumePatch } from "@/lib/unified/types";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { submitDeepseekTailorTask } from "@/lib/unified/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = (await request.json()) as { gptChatUrl?: string | null; patch?: ResumePatch };
  if (!body.patch) {
    return NextResponse.json({ error: "patch is required" }, { status: 400 });
  }
  return NextResponse.json(await submitDeepseekTailorTask({ taskId: id, gptChatUrl: body.gptChatUrl ?? null, patch: body.patch }));
}
