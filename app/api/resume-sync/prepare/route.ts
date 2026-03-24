import { NextResponse } from "next/server";
import { prepareResumeSync } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import type { ResumeSyncManifestFile } from "@/lib/unified/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const body = (await request.json()) as { rootPath?: string; isFullSync?: boolean; files?: ResumeSyncManifestFile[] };
  if (!body.rootPath || !Array.isArray(body.files)) {
    return NextResponse.json({ error: "rootPath and files are required" }, { status: 400 });
  }
  const result = prepareResumeSync({ requestedBy: user.id, rootPath: body.rootPath, isFullSync: body.isFullSync, files: body.files });
  return NextResponse.json(result);
}
