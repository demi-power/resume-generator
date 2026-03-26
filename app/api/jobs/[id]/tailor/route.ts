import { NextResponse } from "next/server";
import type { GenerationProviderId, VerifierProviderId } from "@/lib/unified/types";
import { createTailorTask, getJobStatus } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const body = (await request.json()) as { matchResultId?: string; provider?: GenerationProviderId; verifierProvider?: VerifierProviderId };
  if (!body.matchResultId) {
    return NextResponse.json({ error: "matchResultId is required" }, { status: 400 });
  }
  const provider = body.provider ?? "local_ollama";
  const task = await createTailorTask({
    jobId: id,
    matchResultId: body.matchResultId,
    provider,
    verifierProvider: body.verifierProvider ?? (provider === "deepseek_webview" ? "chatgpt_webview" : "local_ollama"),
    requestedBy: user.id,
  });
  const status = provider === "deepseek_webview" ? 200 : 202;
  return NextResponse.json({ job: getJobStatus(id), task, queued: provider !== "deepseek_webview" }, { status });
}
