import { NextResponse } from "next/server";
import { getJobStatus } from "@/lib/unified/store";
import { requireUnifiedUser } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedUser(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const job = getJobStatus(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json(job);
}
