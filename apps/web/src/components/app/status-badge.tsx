// One status map for the whole app (research/wave3/topbar-design.md 7.7). Owner: w3-topbar-shell. Every record
// status renders in sentence case with one tone per meaning: green done or healthy, blue moving, amber waiting on a
// person, red failed or blocked, gray inert. <StatusBadge> is the default; <StatusText> is plain colored text for
// dense tables only. A status whose tone depends on the record kind takes a `kind` override.
import { Badge } from "@weft/ui/components";
import { cn } from "@weft/ui";

export type StatusTone = "gray" | "blue" | "green" | "amber" | "red";

/** Tone by status word, shared by every record kind unless a kind overrides it below. */
export const STATUS_TONES: Record<string, StatusTone> = {
  // done or healthy
  active: "green", processed: "green", accepted: "green", resolved: "green", done: "green", complete: "green", completed: "green",
  elected: "green", delivered: "green", paid: "green", settled: "green", approved: "green", approved_taxable: "green", taken: "green",
  complete_clear: "green", assigned: "green", signed: "green",
  // moving
  onboarding: "blue", invited: "blue", sent: "blue", viewed: "blue", processing: "blue", running: "blue", in_progress: "blue",
  in_review: "blue", new: "blue", provisioning: "blue", shipped: "blue", ordered: "blue", submitted: "blue", scheduled: "blue",
  consented: "blue", open: "blue",
  // waiting on a person
  pending: "amber", proposed: "amber", awaiting_state: "amber", waiting_approval: "amber", waiting_event: "amber", needs_review: "amber",
  offboarding: "amber", not_started: "amber", returned: "amber", expired: "amber", complete_review: "amber", disputed: "amber", nudged: "amber",
  // failed or blocked
  failed: "red", blocked: "red", escalated: "red", needs_info: "red", declined: "red", denied: "red", suspended: "red",
  // inert
  draft: "gray", inactive: "gray", voided: "gray", cancelled: "gray", canceled: "gray", excluded: "gray", skipped: "gray",
  dismissed: "gray", terminated: "gray", waived: "gray", not_registered: "gray", queued: "gray",
};

/** Where one kind of record reads a status word differently from the shared map. */
export const KIND_TONES: Record<string, Record<string, StatusTone>> = {
  offboarding_step: { pending: "gray" },
  reconciliation: { open: "amber", disputed: "blue" },
  payout: { returned: "red" },
  sim_batch: { returned: "red" },
};

/** Labels that sentence case alone would get wrong. */
const LABELS: Record<string, string> = {
  approved_taxable: "Approved, taxable",
  complete_clear: "Clear",
  complete_review: "Needs review",
  awaiting_state: "Awaiting state",
  needs_info: "Needs info",
  not_registered: "Not registered",
  waiting_approval: "Waiting for approval",
  waiting_event: "Waiting for an event",
};

/** "needs_review" reads "Needs review". */
export function statusLabel(status: string): string {
  if (LABELS[status]) return LABELS[status];
  const s = status.replace(/_/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function statusTone(status: string, kind?: string): StatusTone {
  return (kind ? KIND_TONES[kind]?.[status] : undefined) ?? STATUS_TONES[status] ?? "gray";
}

const TEXT: Record<StatusTone, string> = { gray: "text-gray-11", blue: "text-blue-11", green: "text-green-11", amber: "text-amber-11", red: "text-red-11" };

export function StatusBadge({ status, kind, className, ...props }: { status: string; kind?: string; className?: string } & Record<`data-${string}`, string | undefined>) {
  return <Badge tone={statusTone(status, kind)} size="md" data-status={status} className={className} {...props}>{statusLabel(status)}</Badge>;
}

/** Plain colored status text, for dense tables where a badge per row would be noise. */
export function StatusText({ status, kind, className }: { status: string; kind?: string; className?: string }) {
  return <span data-status={status} className={cn("font-medium", TEXT[statusTone(status, kind)], className)}>{statusLabel(status)}</span>;
}
