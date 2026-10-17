// Simulated carrier and 401(k) provider intake for benefit elections (wave 4, T5, R9). Owner: w4-parity-people.
// A filing is one carrier's share of an employee's window elections. The intake checks the carrier is on file and
// that every line is a plan type that carrier takes, then answers with a deterministic receipt: the same filing
// always gets the same reference, so replays and tests are stable. Nothing here stores or needs a credential.
import { createHash } from "node:crypto";

export const CARRIER_INTAKE: Record<string, { code: string; label: string; accepts: readonly string[] }> = {
  "Juniper Mutual (sim)": { code: "JM", label: "medical, dental and vision carrier", accepts: ["medical", "dental", "vision"] },
  "Tidewater Retirement (sim)": { code: "TW", label: "401(k) provider", accepts: ["401k"] },
};

export interface CarrierFiling {
  submissionId: string; carrier: string; workerId: string; effectiveOn: string;
  lines: { plan_id: string; type: string; tier: string | null; deferral_bps: number | null }[];
}
export type CarrierReceipt = { status: "confirmed"; receiptRef: string; reason: null } | { status: "rejected"; receiptRef: null; reason: string };

export function fileElections(f: CarrierFiling): CarrierReceipt {
  const intake = CARRIER_INTAKE[f.carrier];
  if (!intake) return { status: "rejected", receiptRef: null, reason: `${f.carrier} is not a carrier on file` };
  if (f.lines.length === 0) return { status: "rejected", receiptRef: null, reason: "The filing has no elections" };
  const wrong = f.lines.find((l) => !intake.accepts.includes(l.type));
  if (wrong) return { status: "rejected", receiptRef: null, reason: `${f.carrier} does not take ${wrong.type} elections` };
  const digest = createHash("sha256").update(JSON.stringify([f.submissionId, f.carrier, f.workerId, f.effectiveOn, f.lines])).digest("hex").slice(0, 10).toUpperCase();
  return { status: "confirmed", receiptRef: `${intake.code}-${digest}`, reason: null };
}
