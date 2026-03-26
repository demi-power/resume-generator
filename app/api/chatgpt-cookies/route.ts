import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getChatGptCookies, setChatGptCookies, type ChatGptCookie } from "@/lib/db";

export const runtime = "nodejs";

function requireAdmin(request: Request) {
  const user = requireUser(request);
  if (!user) return { status: 401 as const, error: "Unauthorized" };
  if (user.role !== "admin") return { status: 403 as const, error: "Forbidden" };
  return { user };
}

export async function GET(request: Request) {
  const user = requireUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cookies = getChatGptCookies();
  return NextResponse.json({ cookies });
}

export async function POST(request: Request) {
  const auth = requireAdmin(request);
  if ("status" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  let body: { cookies?: ChatGptCookie[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const cookies = Array.isArray(body?.cookies) ? body.cookies : [];
  setChatGptCookies(cookies);
  return NextResponse.json({ ok: true });
}
