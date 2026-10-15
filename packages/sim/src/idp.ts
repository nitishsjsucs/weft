// Identity provider simulator (Google Workspace, chat, GitHub, SSO). Accounts are active at once; a `delay`
// fault keeps one in provisioning until the next tick.
import { asc, eq } from "drizzle-orm";
import type { FaultInjector, IdpAccount, IdpSim, ItSystem, SimClock } from "@weft/contracts";
import { simIdpAccounts, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId } from "./ids";

export const IDP_VAULT = "vault:idp-admin" as const;
const HANDLE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export interface IdpSimInternal extends IdpSim { tick(now: string): Promise<void> }

export function createIdpSim(db: DbTx, clock: SimClock, faults: FaultInjector): IdpSimInternal {
  const toAccount = (r: typeof simIdpAccounts.$inferSelect): IdpAccount => ({
    ref: r.id, workerId: r.workerId, system: r.system as ItSystem, handle: r.handle, groups: JSON.parse(r.groupsJson) as string[], status: r.status as IdpAccount["status"],
  });
  return {
    async createAccount(req) {
      const fault = await firstFault(faults, ["idp.createAccount", `idp.${req.system}.createAccount`]);
      if (fault === "error") throw new SimFaultError("idp.createAccount");
      if (typeof req.credential !== "string" || req.credential.length < 8) throw new Error("SIM_AUTH: the sim IdP rejected the admin credential");
      if (!HANDLE.test(req.handle)) throw new Error(`idp.createAccount: invalid handle ${req.handle}`);
      const existing = (await db.select().from(simIdpAccounts).where(eq(simIdpAccounts.workerId, req.workerId))).find((r) => r.system === req.system);
      if (existing) return { ref: existing.id, status: existing.status === "provisioning" ? "provisioning" : "active" };
      const ref = await mintId(db, "simi_");
      const status = fault === "delay" ? "provisioning" : "active";
      await db.insert(simIdpAccounts).values({ id: ref, workerId: req.workerId, system: req.system, handle: req.handle, groupsJson: JSON.stringify(req.groups), status, createdAt: clock.now() });
      return { ref, status };
    },
    async suspend(ref) {
      await db.update(simIdpAccounts).set({ status: "suspended" }).where(eq(simIdpAccounts.id, ref));
    },
    async list(workerId) {
      const rows = workerId
        ? await db.select().from(simIdpAccounts).where(eq(simIdpAccounts.workerId, workerId)).orderBy(asc(simIdpAccounts.id))
        : await db.select().from(simIdpAccounts).orderBy(asc(simIdpAccounts.id));
      return rows.map(toAccount);
    },
    async tick() {
      await db.update(simIdpAccounts).set({ status: "active" }).where(eq(simIdpAccounts.status, "provisioning"));
    },
  };
}
