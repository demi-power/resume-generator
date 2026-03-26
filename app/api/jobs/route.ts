import { NextResponse } from "next/server";
import { listJobs } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const url = new URL(request.url);
  const batchId = url.searchParams.get("batchId");
  const status = url.searchParams.get("status");
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue ? Number(limitValue) : 200;
  return NextResponse.json({ items: listJobs({ batchId, status, limit }) });
}
