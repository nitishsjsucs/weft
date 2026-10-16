// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-integrations-hr.
// rt_ats_hire: when a Greenhouse hire becomes a Weft draft offer (offer.imported), read the hire and the open sync
// items for the offer, point out values Weft could not map (an unmapped office stays on Remote US until someone maps
// it), and propose sending the offer through the existing documents.send_offer lifecycle. Candidate fields from the
// applicant tracking system are untrusted, so the run is tainted and every write is a proposal. Enabled: GP17 needs it.
// prebuilt.ts, prechecks.ts and checks.ts spread these in. Its scripted run is scenarios/rt_ats_hire.json.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";


export const RT_ATS_HIRE: RoutineDef = {
  id: "rt_ats_hire", name: "Greenhouse hire to offer",
  description: "When a Greenhouse hire arrives as a draft offer, check it against Weft's departments, offices and tax registrations, flag what is unmapped and propose sending the offer.",
  ownerPrincipalId: "usr_dana", enabled: true, autonomy: "approve", trigger: { type: "event", event: "offer.imported" }, filter: null,
  instructions: "Use the derived arguments. In one batch: read the open sync items for the offer with integrations.list_sync_items and propose documents.send_offer for the offer. Then write a short final message that names any unmapped value from the findings.",
  tools: ["ats.get_hire", "integrations.list_sync_items", "integrations.map_value", "documents.send_offer", "tax.list_registrations", "people.search", "integrations.status", "comms.send_message"],
  precheck: "ats_hire",
  checklist: [{ id: "send", label: "propose documents.send_offer", check: "proposal_exists:documents.send_offer:{offer_id}" }],
  budget: { steps: 6, usd: 0.05, minutes: 10 }, surface: { worthSurfacing: true, channel: "#new-hires" }, source: "prebuilt", taintedBy: null,
};

const data = async <T>(exec: ReadOnlyExecutor, companyId: string, cmd: string, args: unknown): Promise<T | null> => {
  const o = await exec.exec(companyId, cmd, args);
  return o.ok && o.status === "done" ? (o.data as T) : null;
};

export const atsHire: Precheck = async (ctx, exec) => {
  const p = (ctx.payload ?? {}) as Record<string, unknown>;
  const offerId = typeof p.offer_id === "string" ? p.offer_id : null;
  if (!offerId || p.vendor !== "greenhouse") return { action: "skip", reason: "The event names no Greenhouse offer." };
  const items = await data<{ items: { id: string; kind: string; detail: Record<string, string> }[] }>(exec, ctx.companyId, "integrations.list_sync_items", { subject_ref: offerId });
  const open = items?.items ?? [];
  return {
    action: "run", severity: "interrupt", subjectRefs: [offerId],
    findings: { offer_id: offerId, unmapped: open.filter((i) => i.kind === "unmapped_value").map((i) => ({ sync_item_id: i.id, field: i.detail.field, ext_name: i.detail.ext_name, fallback: i.detail.fallback })), conflicts: open.filter((i) => i.kind === "sync_conflict").length },
    derivedArgs: { offer_id: offerId, "integrations.list_sync_items": { subject_ref: offerId }, "documents.send_offer": { offer_id: offerId } },
  };
};

export const routines: RoutineDef[] = [RT_ATS_HIRE];
export const prechecks: Record<string, Precheck> = { ats_hire: atsHire };
export const predicates: Record<string, Predicate> = {};
