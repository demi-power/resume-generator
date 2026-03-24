import { NextResponse } from "next/server";
import type { GenerationProviderId } from "@/lib/unified/types";
import { createTailorTask } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = (await request.json()) as { matchResultId?: string; provider?: GenerationProviderId };
  if (!body.matchResultId) {
    return NextResponse.json({ error: "matchResultId is required" }, { status: 400 });
  }
  const provider = body.provider ?? "local_ollama";
  return NextResponse.json(await createTailorTask({ jobId: id, matchResultId: body.matchResultId, provider, requestedBy: user.id }));
}
