import { NextResponse } from "next/server";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { getTailorTaskPrompt } from "@/lib/unified/store";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  const mode = new URL(request.url).searchParams.get("mode");
  if (mode !== "generation" && mode !== "verification") {
    return NextResponse.json({ error: "mode must be generation or verification" }, { status: 400 });
  }
  const prompt = await getTailorTaskPrompt(id, mode);
  return NextResponse.json({ prompt });
}
