import { NextResponse } from "next/server";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { enqueueJobRanking, getJobStatus } from "@/lib/unified/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const task = enqueueJobRanking(id, user.id);
  return NextResponse.json({ job: getJobStatus(id), task, queued: true }, { status: 202 });
}
