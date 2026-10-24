// Agency simulators (IRS, CA EDD, NY DTF, NY DOL, TX TWC, CO DOR, CO CDLE), SPEC 8.
// Registration returns awaiting_state and completes 2 sim business days later with a synthetic account number.
// The resolved credential is checked in memory and never stored; rows keep only the agency's vault name.
import { and, asc, eq, lte } from "drizzle-orm";
import type { AgencyCode, AgencySim, FaultInjector, FaultTarget, NoticeScenario, SimClock, SimEvent } from "@weft/contracts";
import { simAgencyMail, simRegistrations, type DbTx } from "@weft/db";
import { firstFault, SimFaultError } from "./faults";
import { mintId, seqOf } from "./ids";
import { renderScenarioAt } from "./notices/scenarios";
import { addBusinessDays } from "./time";

export const AGENCY_JURISDICTION: Readonly<Record<AgencyCode, "US" | "CA" | "NY" | "TX" | "CO">> = {
  irs: "US", ca_edd: "CA", ny_dtf: "NY", ny_dol: "NY", tx_twc: "TX", co_dor: "CO", co_cdle: "CO",
};
/** Vault names of the simulated agency portals (SPEC 5.4). The only credential reference a sim row may hold. */
export const AGENCY_VAULT: Readonly<Record<AgencyCode, `vault:${string}`>> = {
  irs: "vault:irs-efile", ca_edd: "vault:ca-edd-portal", ny_dtf: "vault:ny-dtf-portal", ny_dol: "vault:ny-dol-portal",
  tx_twc: "vault:tx-twc-portal", co_dor: "vault:co-dor-portal", co_cdle: "vault:co-cdle-portal",
};
export const AGENCY_LABEL: Readonly<Record<AgencyCode, string>> = {
  irs: "IRS", ca_edd: "CA EDD", ny_dtf: "NY DTF", ny_dol: "NY DOL", tx_twc: "TX TWC", co_dor: "CO DOR", co_cdle: "CO CDLE",
};
const CONFIRMATION_PREFIX: Readonly<Record<AgencyCode, string>> = {
  irs: "IRS", ca_edd: "CA-EDD", ny_dtf: "NY-DTF", ny_dol: "NY-DOL", tx_twc: "TX-TWC", co_dor: "CO-DOR", co_cdle: "CO-CDLE",
};
export const REGISTRATION_BUSINESS_DAYS = 2;
export const NEEDS_INFO_REASON = "Confirm first wage date in Colorado";

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Synthetic account numbers per research/domain.md section 4, always with a visibly fake 00 prefix. */
export function syntheticAccountNumber(agency: AgencyCode, seq: number): string {
  switch (agency) {
    case "irs": return `00-${pad(4817300 + seq, 7)}`;
    case "ca_edd": return `000-${pad(4900 + seq, 4)}-${seq % 10}`;
    case "ny_dol": return `00-${pad(49000 + seq, 5)} ${seq % 10}`;
    case "ny_dtf": return `004817265-${pad(seq % 100, 2)}-${seq % 10}`;
    case "tx_twc": return `00-${pad(490000 + seq, 6)}-${seq % 10}`;
    case "co_dor": return `00${pad(482600 + seq, 6)}`;
    case "co_cdle": return `00${pad(483600 + seq, 6)}`;
  }
}

function targets(agency: AgencyCode, op: "register" | "fileResponse"): FaultTarget[] {
  return [`agency.${agency}.${op}`, `agency.${AGENCY_JURISDICTION[agency]}.${op}`];
}

function requireCredential(credential: string, agency: AgencyCode): void {
  if (typeof credential !== "string" || credential.length < 8) throw new Error(`SIM_AUTH: the ${AGENCY_LABEL[agency]} portal rejected the credential`);
}

export function createAgencySim(db: DbTx, clock: SimClock, faults: FaultInjector): AgencySim {
  return {
    async register(req) {
      const fault = await firstFault(faults, targets(req.agency, "register"));
      if (fault === "error") throw new SimFaultError(`agency.${req.agency}.register`);
      requireCredential(req.credential, req.agency);
      const now = clock.now();
      const applicationId = await mintId(db, "sima_");
      const completeAt = addBusinessDays(now, REGISTRATION_BUSINESS_DAYS);
      const status = fault === "needs_info" ? "needs_info" : "awaiting_state";
      await db.insert(simRegistrations).values({
        id: applicationId, agency: req.agency, companyId: req.companyId, accountType: req.accountType,
        requestJson: JSON.stringify({ companyId: req.companyId, agency: req.agency, accountType: req.accountType, credentialName: AGENCY_VAULT[req.agency], submittedAt: now }),
        status, completeAt, accountNumber: null, fault: fault === "needs_info" ? `needs_info: ${NEEDS_INFO_REASON}` : null,
      });
      await db.insert(simAgencyMail).values({
        id: await mintId(db, "simm_"), agency: req.agency, direction: "out", kind: "registration_request",
        body: `Registration request for a ${req.accountType} account (application ${applicationId}).`,
        relatedNoticeId: null, confirmation: applicationId, credentialName: AGENCY_VAULT[req.agency], ts: now,
      });
      return { applicationId, status, completeAt };
    },

    async fileResponse(req) {
      const fault = await firstFault(faults, targets(req.agency, "fileResponse"));
      if (fault === "error") throw new SimFaultError(`agency.${req.agency}.fileResponse`);
      requireCredential(req.credential, req.agency);
      const id = await mintId(db, "simm_");
      const confirmation = `${CONFIRMATION_PREFIX[req.agency]}-R-${pad(seqOf(id), 6)}`;
      await db.insert(simAgencyMail).values({
        id, agency: req.agency, direction: "out", kind: "notice_response", body: req.body, relatedNoticeId: req.noticeId,
        confirmation, credentialName: AGENCY_VAULT[req.agency], ts: clock.now(),
      });
      return { confirmation };
    },

    async renderScenario(name: NoticeScenario) {
      return renderScenarioAt(name, clock.now());
    },

    async tick(now) {
      const out: SimEvent[] = [];
      const due = await db.select().from(simRegistrations)
        .where(and(eq(simRegistrations.status, "awaiting_state"), lte(simRegistrations.completeAt, now))).orderBy(asc(simRegistrations.id));
      for (const r of due) {
        const accountNumber = syntheticAccountNumber(r.agency as AgencyCode, seqOf(r.id));
        await db.update(simRegistrations).set({ status: "completed", accountNumber }).where(eq(simRegistrations.id, r.id));
        await db.insert(simAgencyMail).values({
          id: await mintId(db, "simm_"), agency: r.agency, direction: "in", kind: "registration_confirmed",
          body: `Registration complete. Account number ${accountNumber}.`, relatedNoticeId: null, confirmation: r.id, credentialName: null, ts: now,
        });
        out.push({ type: "sim.registration_completed", subjectRef: r.id, payload: { application_id: r.id } });
      }
      const info = await db.select().from(simRegistrations).where(eq(simRegistrations.status, "needs_info")).orderBy(asc(simRegistrations.id));
      for (const r of info) {
        await db.update(simRegistrations).set({ status: "needs_info_sent" }).where(eq(simRegistrations.id, r.id));
        out.push({ type: "sim.registration_needs_info", subjectRef: r.id, payload: { application_id: r.id } });
      }
      return out;
    },
  };
}
