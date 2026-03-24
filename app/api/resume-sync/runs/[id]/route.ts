import { NextResponse } from "next/server";
import { getResumeSyncRun } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const run = getResumeSyncRun(id);
  if (!run) return NextResponse.json({ error: "Sync run not found" }, { status: 404 });
  return NextResponse.json(run);
}
