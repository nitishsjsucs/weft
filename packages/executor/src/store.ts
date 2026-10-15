// Executor reads of governance rows: principals, grants, limits, settings.
import { and, eq } from "drizzle-orm";
import type { Domain, Grant } from "@weft/contracts";
import { agentGrants, limits, principals, settings, type DbTx } from "@weft/db";

export const DOMAINS: Domain[] = ["people", "payroll", "tax", "benefits", "it", "comms", "company"];
export const GRANT_RANK: Record<Grant, number> = { none: 0, view: 1, edit: 2, approve: 3 };
export type Grants = Record<Domain, Grant>;

export const noGrants = (): Grants => ({ people: "none", payroll: "none", tax: "none", benefits: "none", it: "none", comms: "none", company: "none" });
export function minGrant(a: Grant, b: Grant): Grant { return GRANT_RANK[a] <= GRANT_RANK[b] ? a : b; }
export function intersect(a: Grants, b: Grants): Grants {
  const out = noGrants();
  for (const d of DOMAINS) out[d] = minGrant(a[d], b[d]);
  return out;
}
/** Approve is never effective for agents (SPEC 5.2). */
export function capAgent(g: Grants): Grants {
  const out = { ...g };
  for (const d of DOMAINS) if (out[d] === "approve") out[d] = "edit";
  return out;
}

export interface PrincipalRow { id: string; companyId: string; kind: "human" | "agent" | "service"; role: string | null; display: string; grants: Grants }

export async function loadPrincipal(db: DbTx, id: string): Promise<PrincipalRow | null> {
  const [p] = await db.select().from(principals).where(eq(principals.id, id)).limit(1);
  if (!p) return null;
  let grants = noGrants();
  try { grants = { ...grants, ...(JSON.parse(p.grantsJson) as Partial<Grants>) }; } catch { /* keep none */ }
  return { id: p.id, companyId: p.companyId, kind: p.kind as PrincipalRow["kind"], role: p.role, display: p.display, grants };
}

export async function agentPrincipalId(db: DbTx, companyId: string): Promise<string> {
  const [p] = await db.select({ id: principals.id }).from(principals).where(and(eq(principals.companyId, companyId), eq(principals.kind, "agent"))).limit(1);
  return p?.id ?? "agt_weft";
}

export async function loadAgentGrants(db: DbTx, companyId: string): Promise<Grants> {
  const out = noGrants();
  for (const r of await db.select().from(agentGrants).where(eq(agentGrants.companyId, companyId))) {
    if ((DOMAINS as string[]).includes(r.domain)) out[r.domain as Domain] = r.level as Grant;
  }
  return capAgent(out);
}

export async function loadLimits(db: DbTx, companyId: string): Promise<Map<string, number>> {
  const rows = await db.select().from(limits).where(eq(limits.companyId, companyId));
  return new Map(rows.map((r) => [r.key, r.cents]));
}

export async function readSetting<T>(db: DbTx, key: string, fallback: T): Promise<T> {
  const [r] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!r) return fallback;
  try { return JSON.parse(r.valueJson) as T; } catch { return fallback; }
}
