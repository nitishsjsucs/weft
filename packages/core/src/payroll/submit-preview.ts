// The words and amounts a payroll.submit_run proposal shows (title and diff). The live preview and the rich seed's
// planted submits both build them here, so a decided submit from September reads like the one waiting today.
import { formatCents } from "@weft/contracts";

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-16" as "Oct 16"; another year than `year` adds it ("Dec 31, 2025"). */
export function shortDay(iso: string, year: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const s = `${MONTH[Number(m[2]) - 1]} ${Number(m[3])}`;
  return Number(m[1]) === year ? s : `${s}, ${m[1]}`;
}

export interface SubmitPreviewInput {
  run: { periodStart: string; periodEnd: string; payday: string };
  included: number;
  totalCostCents: number;
  /** Net pay plus reimbursements: what the bank batch moves. */
  bankCents: number;
  excludedNames: string[];
}

export function submitPreviewText(s: SubmitPreviewInput): { title: string; diff: { label: string; before: string; after: string }[] } {
  const year = Number(s.run.periodEnd.slice(0, 4));
  const period = `${shortDay(s.run.periodStart, year)} to ${shortDay(s.run.periodEnd, year)}`;
  return {
    title: `Submit the ${period} payroll (payday ${shortDay(s.run.payday, year)}): ${s.included} paychecks, total cost ${formatCents(s.totalCostCents)}`,
    diff: [
      { label: "Status", before: "draft", after: "processing" },
      { label: "Net pay to bank", before: "$0.00", after: formatCents(s.bankCents) },
      { label: "Excluded (blocked)", before: "none", after: s.excludedNames.length ? s.excludedNames.join(", ") : "none" },
    ],
  };
}
