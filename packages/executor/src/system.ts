// System principals (harness 6.10): each svc_ principal has an exact command allowlist with nothing at R2 or above.
// System-record commands are R1 by definition. Events emitted by system calls copy the source event's stamps.
import { sql } from "drizzle-orm";
import type { ReadOnlyExecutor, SystemExecutor, SystemPrincipal } from "@weft/contracts";

import type { Engine } from "./engine";
import { refusal } from "./outcome";
import { runInTx } from "./pipeline";
import { afterCommit } from "./timeline";
import { readonlyScope, type CallScope } from "./scope";
import { DOMAINS, loadPrincipal, noGrants } from "./store";
import { writeLocked } from "./write";

/** System calls are governed by the allowlist; references resolve in every domain. */
const allView = () => { const g = noGrants(); for (const d of DOMAINS) g[d] = "view"; return g; };

export const SYSTEM_PRINCIPALS: SystemPrincipal[] = ["svc_scheduler", "svc_events", "svc_sim", "svc_digest"];

/** Exact allowlists. Additions are requested in docs/tracks/t3-governance.md; nothing at R2 or above is ever allowed. */
export const SYSTEM_ALLOWLISTS: Record<SystemPrincipal, readonly string[]> = {
  svc_scheduler: ["comms.post_update", "documents.expire_offers"],   // expire_offers: wave 2, the offer expiry sweep (R1)
  svc_events: ["tax.record_registration", "payroll.mark_processed", "payroll.mark_failed", "onboarding.complete_task", "it.record_delivery", "comms.post_update"],
  svc_sim: ["tax.record_registration"],
  svc_digest: ["comms.post_update"],
};

export function createSystemExecutor(e: Engine): SystemExecutor {
  return {
    async exec(principal, command, args, source) {
      if (!SYSTEM_PRINCIPALS.includes(principal)) return refusal("NOT_PERMITTED", `${String(principal)} is not a system principal`, false);
      const outcome = await writeLocked(() => e.db.transaction(async (tx) => {
        const p = await loadPrincipal(tx, principal);
        let companyId = p?.companyId ?? null;
        if (!companyId) {
          const [c] = await tx.all<{ id: string }>(sql`SELECT id FROM companies ORDER BY id LIMIT 1`);
          companyId = c?.id ?? null;
        }
        if (!companyId) return refusal("NOT_PERMITTED", "No company", false);
        const def = e.registry.def(command);
        const scope: CallScope = {
          caller: "system",
          ctx: {
            companyId, principal: { id: principal, kind: "service", role: null }, onBehalfOf: source.requestedBy, surface: "system", agentKind: null,
            run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: e.clock.now(),
          },
          grants: allView(), taintedBy: null, nonce: null, actor: { kind: "system", id: principal },
          stamp: { attended: source.attended, requestedBy: source.requestedBy }, run: null, batch: null, callId: null,
          systemAllowed: !!def && SYSTEM_ALLOWLISTS[principal].includes(def.name),
        };
        return (await runInTx(e, tx, scope, command, args)).outcome;
      }));
      await afterCommit(e, outcome);
      return outcome;
    },
  };
}

/** Prechecks and checklist predicates: exec refuses anything but effect "read". Never takes the write lock. */
export function createReadOnlyExecutor(e: Engine): ReadOnlyExecutor {
  return {
    async exec(companyId, command, args) {
      const scope = await readonlyScope(e, e.db, companyId);
      return (await runInTx(e, e.db, scope, command, args)).outcome;
    },
  };
}
