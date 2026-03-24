import { NextResponse } from "next/server";
import { claimTailorTask } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  return NextResponse.json(claimTailorTask(id, user.id));
}
