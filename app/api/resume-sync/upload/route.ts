import { Buffer } from "buffer";
import { NextResponse } from "next/server";
import { uploadResumeSyncFile } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const body = (await request.json()) as { syncRunId?: string; relativePath?: string; html?: string; contentBase64?: string };
  if (!body.syncRunId || !body.relativePath) {
    return NextResponse.json({ error: "syncRunId and relativePath are required" }, { status: 400 });
  }
  const html = typeof body.html === "string" ? body.html : body.contentBase64 ? Buffer.from(body.contentBase64, "base64").toString("utf-8") : "";
  if (!html.trim()) {
    return NextResponse.json({ error: "html or contentBase64 is required" }, { status: 400 });
  }
  return NextResponse.json(uploadResumeSyncFile({ syncRunId: body.syncRunId, relativePath: body.relativePath, html }));
}
