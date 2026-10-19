"use client";
// What the "Viewing as" person may do, from their domain grants in the permissions view. The UI uses it only to hide
// what the API would refuse anyway (a manager's Payroll, Mark accepted); the API's grant and scope checks stay the
// rule. While the grants load, or under the mock API, every control shows.
import { useCallback } from "react";
import { useGet, usePrincipal } from "./hooks";

const RANK: Record<string, number> = { none: 0, view: 1, edit: 2, approve: 3 };
export type Level = "view" | "edit" | "approve";

interface PermissionsBody { principals?: { id: string; grants?: Record<string, string> }[] }

/** The viewing person's grants per domain, or null until they are known. */
export function useGrants(): Record<string, string> | null {
  const who = usePrincipal();
  const q = useGet("/v1/settings/permissions", { refreshMs: 60_000 });
  const me = (q.data as PermissionsBody | undefined)?.principals?.find((p) => p.id === who);
  return me?.grants ?? null;
}

/** True unless the viewer's grants are known and below `level` on `domain`. */
export function canWith(grants: Record<string, string> | null, domain: string, level: Level = "view"): boolean {
  if (!grants) return true;
  return (RANK[grants[domain] ?? "none"] ?? 0) >= RANK[level]!;
}

/** `can(domain, level)` for the viewing person. */
export function useCan(): (domain: string, level?: Level) => boolean {
  const grants = useGrants();
  const key = grants ? JSON.stringify(grants) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable while the grants are the same
  return useCallback((domain: string, level: Level = "view") => canWith(grants, domain, level), [key]);
}
