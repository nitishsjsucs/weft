// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-integrations-screening-esign.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// rt_screening_follow_up (GP18): when an offer is accepted, a deterministic precheck reads the offer's background check
// status and the package catalog; when no open order exists, the model proposes screening.order (R4, approval always,
// priced from screening_packages by the command, never by the model). It never reads record text (the read commands
// return status, result, ETA and timestamps only) and never touches a review or adverse step (human_only, absent from
// every model surface). It ships disabled.
//
// RT_SCREENING_FOLLOW_UP joins PREBUILT at the wave 3 merge (the engine test pins the wave 1 and 2 ids, owned elsewhere),
// the same way the wave 2 routines did; tests/scenarios/gp18-follow-up.test.ts inserts its row and pins its script.
import type { Precheck, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

export const RT_SCREENING_FOLLOW_UP: RoutineDef = {
  id: "rt_screening_follow_up", name: "Background check follow-up",
  description: "When an offer is accepted, propose the background check from the package catalog so a person can approve it.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "event", event: "offer.accepted" }, filter: null,
  instructions: "Propose screening.order with the derived arguments, unchanged. The price comes from the catalog, never from you. Never ask for or repeat report details. Then write a one-line final message naming the package.",
  tools: ["screening.get_status", "screening.list_packages", "screening.order", "onboarding.get_checklist"],
  precheck: "screening_follow_up",
  checklist: [{ id: "ordered", label: "propose the background check", check: "proposal_exists:screening.order:{offer_id}" }],
  budget: { steps: 4, usd: 0.05, minutes: 5 }, surface: { worthSurfacing: true, channel: "#new-hires" }, source: "prebuilt", taintedBy: null,
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const CLOSED = new Set(["canceled", "expired"]);

interface OrderLine { order_id: string; status: string }
interface PackageLine { slug: string; name: string; price_display: string; phase: string }

/**
 * Skips when the event has no offer, when the offer already has an open check, or when the catalog has no package.
 * Otherwise derives the one screening.order call. The package is left to the command, which picks the default for the
 * hire's location (the non-criminal package first in New York City) and prices it from the database.
 */
export const screeningFollowUp: Precheck = async (ctx, exec) => {
  const offerId = str(obj(ctx.payload).offer_id);
  if (!offerId) return { action: "skip", reason: "The event carries no offer id." };
  const st = await exec.exec(ctx.companyId, "screening.get_status", { offer_id: offerId });
  if (!st.ok || st.status !== "done") return { action: "skip", reason: "Could not read the background check status." };
  const open = ((obj(st.data).orders ?? []) as OrderLine[]).filter((o) => !CLOSED.has(o.status));
  if (open.length) return { action: "skip", reason: `Offer ${offerId} already has background check ${open.map((o) => `${o.order_id} (${o.status})`).join(", ")}.` };
  const pk = await exec.exec(ctx.companyId, "screening.list_packages", {});
  const packages = pk.ok && pk.status === "done" ? ((obj(pk.data).packages ?? []) as PackageLine[]) : [];
  if (!packages.length) return { action: "skip", reason: "No background check package is configured." };
  const workerId = str(obj(ctx.payload).worker_id);
  return {
    action: "run", severity: "digest", subjectRefs: workerId ? [offerId, workerId] : [offerId],
    findings: { offer_id: offerId, worker_id: workerId, vendor: str(obj(pk.data).vendor), packages: packages.map((p) => ({ slug: p.slug, name: p.name, price: p.price_display, phase: p.phase })) },
    derivedArgs: { offer_id: offerId, "screening.order": { offer_id: offerId } },
  };
};

export const routines: RoutineDef[] = [];
export const prechecks: Record<string, Precheck> = { screening_follow_up: screeningFollowUp };
export const predicates: Record<string, Predicate> = {};
