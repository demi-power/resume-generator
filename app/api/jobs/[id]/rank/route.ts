import { NextResponse } from "next/server";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { runRankingForJob } from "@/lib/unified/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  return NextResponse.json(await runRankingForJob(id));
}
