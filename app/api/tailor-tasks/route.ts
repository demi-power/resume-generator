import { NextResponse } from "next/server";
import type { GenerationProviderId, TailorTaskStatus, VerifierProviderId } from "@/lib/unified/types";
import { listTailorTasks } from "@/lib/unified/store";
import { requireUnifiedUser } from "@/lib/unified/route-helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = requireUnifiedUser(request);
  if (user instanceof NextResponse) return user;
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") as GenerationProviderId | null;
  const verifierProvider = url.searchParams.get("verifierProvider") as VerifierProviderId | null;
  const statuses = url.searchParams.getAll("status") as TailorTaskStatus[];
  const limit = Number(url.searchParams.get("limit") || "50");
  return NextResponse.json({
    items: listTailorTasks({
      provider,
      verifierProvider,
      statuses: statuses.length > 0 ? statuses : undefined,
      limit,
    }),
  });
}
