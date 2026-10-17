// w4-parity-compliance additive contract (docs/wave4.md rule 2). Additive only; the integrator may export it from
// packages/contracts/src/index.ts. Shared by packages/routines (the notice precheck, which may import only contracts),
// packages/core (the scripted-provider variant chooser) and the web screens.
import { NOTICE_HANDLING, type FilingForm, type HandoffReason, type NoticeHandling } from "../wave4";

/** Form codes printed on agency notices, mapped to the filing they are about. */
export const NOTICE_FORM_CODES: Readonly<Record<string, FilingForm>> = {
  "941": "941", "Form 941": "941", "940": "940", "Form 940": "940", "W-2": "w2_w3", "W-3": "w2_w3", "1099-NEC": "1099_nec",
  "DE 9": "ca_de9", "DE 9C": "ca_de9c", "NYS-45": "ny_nys45", "C-3": "tx_c3", "UITR-1": "co_uitr1", "DR 1094": "co_dr1094",
};

/**
 * The plan for one notice, decided in code from structured fields only (kind, the parser's extract, the filing on
 * record). `update_rate` belongs to rt_agency_notice; every other plan to rt_compliance_notices.
 * - attach_filing: the return is on file, so the reply cites its filing date and confirmation.
 * - file_return: the return is on record but not filed: prepare it, propose filing it, and reply.
 * - update_deposit_schedule: propose the schedule change the notice states.
 * - pay_penalty_or_abate: request abatement in the reply, and hand the payment decision to a tax specialist.
 * - acknowledge: informational; record it as read.
 * - escalate: a tax specialist hand-off with the evidence pack.
 */
export type NoticePlan = "update_rate" | "attach_filing" | "file_return" | "update_deposit_schedule" | "pay_penalty_or_abate" | "acknowledge" | "escalate";
export const NOTICE_PLANS: readonly NoticePlan[] = ["update_rate", "attach_filing", "file_return", "update_deposit_schedule", "pay_penalty_or_abate", "acknowledge", "escalate"];

export interface NoticePlanInput {
  kind: string;
  /** The parser's extract, or null when nothing could be read. `confidence` is set for uploaded notices only. */
  extract: { formCode?: string | null; period?: string | null; effectiveFrom?: string | null; accountNumber?: string | null; confidence?: number | null } | null;
  taxAccountId: string | null;
  /** The filing the notice is about, when one is on record. */
  filing: { id: string; status: string } | null;
  /** `upload` is a person's scan of a mailed notice (T4): its fields are untrusted, so no plan closes it without a person. */
  source?: "simulated" | "upload";
}

/** Extractions below this confidence go to a person (uploaded notices only; the simulator's own text parses exactly). */
export const MIN_EXTRACT_CONFIDENCE = 0.9;

export function planNotice(i: NoticePlanInput): { plan: NoticePlan; handling: NoticeHandling | null; reason: HandoffReason | null } {
  const handling = NOTICE_HANDLING[i.kind] ?? null;
  if (!handling) return { plan: "escalate", handling: null, reason: "unknown_notice_kind" };
  if (!i.extract || (typeof i.extract.confidence === "number" && i.extract.confidence < MIN_EXTRACT_CONFIDENCE)) return { plan: "escalate", handling, reason: "low_confidence_extract" };
  // An uploaded notice's kind and fields came from untrusted bytes: a plan that would change a rate or close the
  // notice with no person in the loop goes to a tax specialist instead. Every other plan ends in a proposal.
  if (i.source === "upload" && (handling === "update_rate" || handling === "acknowledge")) return { plan: "escalate", handling, reason: "judgment_needed" };
  if (handling === "update_rate") return { plan: "update_rate", handling, reason: null };
  if (handling === "attach_filing") {
    if (!i.filing) return { plan: "escalate", handling, reason: "judgment_needed" };
    return { plan: i.filing.status === "filed" || i.filing.status === "accepted" ? "attach_filing" : "file_return", handling, reason: null };
  }
  if (handling === "update_deposit_schedule") {
    const ok = i.taxAccountId && (i.extract.period === "monthly" || i.extract.period === "semiweekly") && i.extract.effectiveFrom;
    return ok ? { plan: "update_deposit_schedule", handling, reason: null } : { plan: "escalate", handling, reason: "judgment_needed" };
  }
  if (handling === "pay_penalty_or_abate") return { plan: "pay_penalty_or_abate", handling, reason: "judgment_needed" };
  if (handling === "acknowledge") return { plan: "acknowledge", handling, reason: null };
  return { plan: "escalate", handling, reason: "judgment_needed" };
}

/** The routine that handles every notice kind except rate changes, and its scripted variants (scenarios/<name>.json). */
export const RT_COMPLIANCE_NOTICES = "rt_compliance_notices";
export const noticeScriptName = (plan: NoticePlan) => `${RT_COMPLIANCE_NOTICES}.${plan}`;

/** The routine for notices a person uploads (trigger notice.uploaded). It is marked tainted, so every run starts tainted. */
export const RT_COMPLIANCE_UPLOADS = "rt_compliance_uploads";
export const uploadScriptName = (plan: NoticePlan) => `${RT_COMPLIANCE_UPLOADS}.${plan}`;
/** The provenance label every rt_compliance_uploads run starts with (routines.tainted_by). */
export const UPLOAD_TAINT = "notice_upload";
