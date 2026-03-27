import path from "path";
import { NextResponse } from "next/server";
import { readArtifactRecordContents } from "@/lib/unified/store";
import { requireUnifiedUser } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUnifiedUser(request);
  if (user instanceof NextResponse) return user;

  const { id } = await params;
  const record = readArtifactRecordContents(id);
  if (!record) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";
  const artifact = record.artifact;
  const mimeType = String(artifact.mime_type || "application/octet-stream");
  const fileName = path.basename(String(artifact.relative_path || "artifact"));

  return new NextResponse(new Uint8Array(record.contents), {
    headers: {
      "content-type": mimeType,
      "content-length": String(record.contents.byteLength),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${fileName}"`,
      "cache-control": "no-store",
      "x-artifact-kind": String(artifact.artifact_kind || "artifact"),
    },
  });
}
