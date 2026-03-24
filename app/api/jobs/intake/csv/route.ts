import { NextResponse } from "next/server";
import { createJobsFromUrls, enqueueJobExtraction } from "@/lib/unified/store";
import { requireUnifiedOwner } from "@/lib/unified/route-helpers";
import { parseCsvText } from "@/lib/unified/utils";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  const body = (await request.json()) as { csvText?: string; batchId?: string | null };
  if (!body.csvText?.trim()) {
    return NextResponse.json({ error: "csvText is required" }, { status: 400 });
  }
  const rows = parseCsvText(body.csvText);
  const urls = rows
    .map((row) => ({
      url: row.URL || row.Url || row.url || "",
      titleHint: row.Job || row.Title || row.job || null,
      companyHint: row.Company || row.company || null,
      batchId: body.batchId ?? null,
    }))
    .filter((row) => row.url.trim());
  const items = createJobsFromUrls({ submittedBy: user.id, sourceType: "csv", urls });
  const tasks = items
    .map((item) => enqueueJobExtraction(String(item.id), user.id))
    .filter(Boolean);
  return NextResponse.json({ items, tasks, queued: tasks.length });
}
