// IT handles are derived in code from the worker row (HR-entered names), never from candidate or model text.
import type { ItSystem } from "@weft/contracts";
import { slugPart } from "../people/names";

export function handleFor(system: ItSystem, first: string, last: string): string {
  const base = `${slugPart(first)}.${slugPart(last)}`;
  return system === "github" ? `lrk-${slugPart(first)}-${slugPart(last)}` : base;
}

/** Groups that grant admin access; any of them makes it.create_account R4 (harness 5.4). */
export const ADMIN_GROUPS = ["admin", "sso-admin", "github-owners", "workspace-admin"] as const;
export function hasAdminGroup(groups: readonly string[]): boolean {
  return groups.some((g) => (ADMIN_GROUPS as readonly string[]).includes(g));
}

/** Default groups per system and department slug. */
export function defaultGroups(system: ItSystem, deptSlug: string | null): string[] {
  if (system === "github") return [deptSlug ?? "engineering"];
  if (system === "google_ws") return deptSlug ? ["all-staff", deptSlug] : ["all-staff"];
  return ["all-staff"];
}

export const GITHUB_DEPARTMENTS = ["dpt_engineering", "dpt_hardware"] as const;
