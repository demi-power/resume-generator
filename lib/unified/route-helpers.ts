import { NextResponse } from "next/server";
import { requireActiveUser } from "@/lib/auth";
import type { UserRow } from "@/lib/db";
import { isOwner } from "@/lib/unified/roles";

export interface UnifiedWorkerPrincipal {
  kind: "worker";
  id: string;
}

export interface UnifiedOwnerPrincipal {
  kind: "owner";
  user: UserRow;
}

export type UnifiedTaskOperator = UnifiedWorkerPrincipal | UnifiedOwnerPrincipal;

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return null;
  const lower = authorization.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

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

export function requireUnifiedInternalWorker(request: Request): UnifiedWorkerPrincipal | null {
  const expectedToken = process.env.UNIFIED_WORKER_TOKEN?.trim();
  if (!expectedToken) return null;
  const providedToken = request.headers.get("x-unified-worker-token")?.trim() || getBearerToken(request);
  if (!providedToken || providedToken !== expectedToken) return null;
  const workerId = request.headers.get("x-unified-worker-id")?.trim() || process.env.UNIFIED_WORKER_ID?.trim() || "python-worker";
  return { kind: "worker", id: workerId };
}

export function requireUnifiedTaskOperator(request: Request): UnifiedTaskOperator | NextResponse {
  const worker = requireUnifiedInternalWorker(request);
  if (worker) return worker;
  const user = requireUnifiedOwner(request);
  if (user instanceof NextResponse) return user;
  return { kind: "owner", user };
}

export function parseJsonBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}
