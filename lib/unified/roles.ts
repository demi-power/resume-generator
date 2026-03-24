import type { UserRow } from "@/lib/db";

export function isOwner(user: Pick<UserRow, "role">): boolean {
  return user.role === "admin";
}

export function isSupporter(user: Pick<UserRow, "role">): boolean {
  return user.role === "user";
}

export function unifiedRole(user: Pick<UserRow, "role">): "owner" | "supporter" {
  return isOwner(user) ? "owner" : "supporter";
}
