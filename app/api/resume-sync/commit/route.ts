import { NextResponse } from "next/server";
import { commitResumeSyncRun } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const body = (await request.json()) as { syncRunId?: string };
  if (!body.syncRunId) {
    return NextResponse.json({ error: "syncRunId is required" }, { status: 400 });
  }
  return NextResponse.json(commitResumeSyncRun(body.syncRunId));
}
