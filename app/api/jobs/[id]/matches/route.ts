import { NextResponse } from "next/server";
import { listMatchResults } from "@/lib/unified/store";
import { requireUnifiedUser } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedUser(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  return NextResponse.json({ items: listMatchResults(id) });
}
