import { NextResponse } from "next/server";
import { getTailorTaskDetails } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const task = getTailorTaskDetails(id);
  if (!task) {
    return NextResponse.json({ error: "Tailor task not found" }, { status: 404 });
  }
  return NextResponse.json(task);
}
