import { NextResponse } from "next/server";
import { createJobsFromUrls, enqueueJobExtraction } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const body = (await request.json()) as {
    urls?: string[] | Array<{ url: string; titleHint?: string | null; companyHint?: string | null; batchId?: string | null }>;
    batchId?: string | null;
  };
  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    return NextResponse.json({ error: "urls is required" }, { status: 400 });
  }
  const urls = body.urls.map((entry) =>
    typeof entry === "string"
      ? { url: entry, batchId: body.batchId ?? null }
      : { url: entry.url, titleHint: entry.titleHint ?? null, companyHint: entry.companyHint ?? null, batchId: entry.batchId ?? body.batchId ?? null }
  );
  const items = createJobsFromUrls({ submittedBy: user.id, sourceType: "url", urls });
  const tasks = items
    .map((item) => enqueueJobExtraction(String(item.id), user.id))
    .filter(Boolean);
  return NextResponse.json({ items, tasks, queued: tasks.length });
}
