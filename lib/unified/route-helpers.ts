import { NextResponse } from "next/server";
import { requireActiveUser } from "@/lib/auth";
import type { UserRow } from "@/lib/db";
import { isOwner } from "@/lib/unified/roles";

export function requireUnifiedUser(request: Request): UserRow | NextResponse {
  const result = requireActiveUser(request);
  if ("status" in result) {
    return NextResponse.json({ error: result.status === 403 ? "Account inactive" : "Unauthorized" }, { status: result.status });
  }
  return result.user;
}

export function requireUnifiedOwner(request: Request): UserRow | NextResponse {
  const user = requireUnifiedUser(request);
  if (user instanceof NextResponse) return user;
  if (!isOwner(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return user;
}

export function parseJsonBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}
