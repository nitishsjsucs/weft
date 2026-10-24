// Seed step "governance" (SPEC 5, 5.2, 5.4, 5.6). Owner: t3-governance.
// Principals, agent grants, ceilings, settings, vault secrets (through executor.vault.put), the demo API keys
// (files mode 0600) and the memory repo init.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { newId } from "@weft/core";
import { agentGrants, apiKeys, companies, limits, principals, settings, workers } from "@weft/db";
import type { SeedContext } from "./context";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

type G = "none" | "view" | "edit" | "approve";
const grants = (g: Partial<Record<"people" | "payroll" | "tax" | "benefits" | "it" | "comms" | "company", G>>) =>
  JSON.stringify({ people: "none", payroll: "none", tax: "none", benefits: "none", it: "none", comms: "none", company: "none", ...g });

export const HUMANS = [
  { id: "usr_dana", first: "Vic", last: "Akisole", role: "admin",
    grants: grants({ people: "approve", payroll: "approve", tax: "approve", benefits: "approve", it: "approve", comms: "approve", company: "approve" }) },
  { id: "usr_theo", first: "Theo", last: "Marsh", role: "payroll_admin",
    grants: grants({ payroll: "approve", tax: "approve", people: "view", comms: "view", company: "view" }) },
  { id: "usr_sam", first: "Sam", last: "Okafor", role: "hr_manager",
    grants: grants({ people: "edit", benefits: "edit", it: "edit", payroll: "view", tax: "view", comms: "edit", company: "view" }) },
] as const;

export const AGENT_GRANTS: Record<string, G> = { people: "edit", payroll: "edit", tax: "edit", benefits: "view", it: "edit", comms: "edit", company: "view" };
export const LIMITS: Record<string, number> = {
  "agent.payroll_run_cents": 150000000, "agent.device_cents": 300000, "agent.off_cycle_cents": 1000000,
  "agent.device_day_cents": 600000, "agent.off_cycle_day_cents": 2000000,
};
export const VAULT_SECRETS = [
  ["ca-edd-portal", "CA EDD employer portal"], ["ny-dol-portal", "NY DOL employer portal"], ["ny-dtf-portal", "NY DTF withholding portal"],
  ["tx-twc-portal", "TX TWC employer portal"], ["co-dor-portal", "CO DOR withholding portal"], ["co-cdle-portal", "CO CDLE UI portal"],
  ["irs-efile", "IRS e-file"], ["sim-bank-operating", "Tidepool Federal Credit Union operating account"], ["idp-admin", "Identity provider admin"],
] as const;
export const SYSTEM_PRINCIPALS = ["svc_scheduler", "svc_events", "svc_sim", "svc_digest"] as const;

export function hashKey(plaintext: string): string { return createHash("sha256").update(plaintext).digest("hex"); }
export function newKeyPlaintext(): string { return `weft_sk_${randomBytes(24).toString("hex")}`; }

function writeSecretFile(path: string, text: string): void {
  fs().writeFileSync(path, text + "\n", { mode: 0o600 });
  fs().chmodSync(path, 0o600);
}

export async function seedGovernance(ctx: SeedContext): Promise<void> {
  const { db, companyId, clock } = ctx;
  // principals.company_id references companies. The company step (t2-world) normally wrote this row already; the
  // fallback carries the SPEC 5.1 values so a governance-only world (track tests) still satisfies the foreign key.
  await db.insert(companies).values({ id: companyId, legalName: "Larkspur Robotics, Inc.", domain: "larkspur.example", ein: "00-4817265", hqState: "CA",
    foundedOn: "2023-03-01", createdAt: clock.now() }).onConflictDoNothing();
  for (const h of HUMANS) {
    const [w] = await db.select({ id: workers.id, email: workers.workEmail }).from(workers)
      .where(and(eq(workers.companyId, companyId), eq(workers.firstName, h.first), eq(workers.lastName, h.last))).limit(1);
    await db.insert(principals).values({
      id: h.id, companyId, kind: "human", workerId: w?.id ?? null, display: `${h.first} ${h.last}`,
      email: w?.email ?? `${h.first.toLowerCase()}.${h.last.toLowerCase()}@larkspur.example`, role: h.role, grantsJson: h.grants,
    }).onConflictDoNothing();
  }
  await db.insert(principals).values({ id: "agt_weft", companyId, kind: "agent", workerId: null, display: "Weft agent", email: "agent@weft.example", role: "agent", grantsJson: JSON.stringify(AGENT_GRANTS) }).onConflictDoNothing();
  for (const s of SYSTEM_PRINCIPALS) {
    await db.insert(principals).values({ id: s, companyId, kind: "service", workerId: null, display: s, email: null, role: "system", grantsJson: grants({}) }).onConflictDoNothing();
  }
  for (const [domain, level] of Object.entries(AGENT_GRANTS)) await db.insert(agentGrants).values({ companyId, domain, level }).onConflictDoNothing();
  for (const [key, cents] of Object.entries(LIMITS)) await db.insert(limits).values({ companyId, key, cents }).onConflictDoNothing();
  const set = async (key: string, v: unknown) => db.insert(settings).values({ key, valueJson: JSON.stringify(v) }).onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(v) } });
  await set("require_second_approver", false);
  await set("notify.quiet_hours", { start: "19:00", end: "07:00", tz: "America/Los_Angeles" });

  // Simulator portal credentials: random values, stored encrypted; the redactor learns each one.
  // (The scaffold's seed digest test runs without an executor; vault and memory steps need one.)
  const executor = ctx.executor as Partial<SeedContext["executor"]> | undefined;
  if (executor?.vault) for (const [name, description] of VAULT_SECRETS) {
    await executor.vault.put({ name, kind: "portal_password", value: `sim-${name}-${randomBytes(12).toString("hex")}`, description, by: "usr_dana" });
  }

  // Seeded API keys (SPEC 5.6): admin and mcp scope, principal Vic, files mode 0600. Only the hash is stored.
  fs().mkdirSync(ctx.dataDir, { recursive: true });
  for (const k of [{ label: "admin", scope: "admin", surface: "api", file: "demo-api-key.txt" }, { label: "mcp", scope: "mcp", surface: "mcp", file: "demo-mcp-key.txt" }]) {
    const plaintext = newKeyPlaintext();
    const id = await newId(db, "key_");
    await db.insert(apiKeys).values({ id, companyId, principalId: "usr_dana", prefix: plaintext.slice(0, 16), hash: hashKey(plaintext), label: k.label, scope: k.scope, surface: k.surface, createdAt: clock.now(), revokedAt: null });
    writeSecretFile(join(ctx.dataDir, k.file), plaintext);
  }

  if (executor?.memory) await executor.memory.init(companyId);
}


