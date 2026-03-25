import { NextResponse } from "next/server";
import { requireUnifiedUser } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

function getWorkerBaseUrl(): string | null {
  const value = process.env.UNIFIED_AI_WORKER_BASE_URL?.trim();
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

export async function GET(request: Request) {
  const user = requireUnifiedUser(request);
  if (user instanceof NextResponse) return user;

  const baseUrl = getWorkerBaseUrl();
  if (!baseUrl) {
    return NextResponse.json({
      configured: false,
      connected: false,
      worker: null,
      error: "UNIFIED_AI_WORKER_BASE_URL is not configured",
    });
  }

  const headers: Record<string, string> = {};
  const token = process.env.UNIFIED_AI_WORKER_TOKEN?.trim();
  if (token) headers["x-unified-ai-worker-token"] = token;

  try {
    const response = await fetch(baseUrl + "/worker/status", {
      method: "GET",
      headers,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) {
      return NextResponse.json({
        configured: true,
        connected: false,
        worker: null,
        error: "Worker request failed with " + response.status + ": " + (text || response.statusText),
      });
    }

    const payload = text.trim() ? JSON.parse(text) : null;
    return NextResponse.json({
      configured: true,
      connected: true,
      worker: payload,
      error: null,
    });
  } catch (error) {
    return NextResponse.json({
      configured: true,
      connected: false,
      worker: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
