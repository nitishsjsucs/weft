"use client";
import Link from "next/link";
import { Bot, FileText } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { tid, type Flag, type Paycheck } from "@weft/contracts";
import { appMain } from "../shell/main-pane";
import { emptyExplanation, flagEvidence, flagExplanation, flagHeadline } from "./flag-text";

const TONE: Record<Flag["severity"], string> = {
  block: "bg-red-3 text-red-11",
  review: "bg-amber-3 text-amber-11",
  info: "bg-gray-3 text-gray-11",
};
export const RULE_LABEL: Record<Flag["rule"], string> = {
  GROSS_CHANGE: "Gross change", HOURS_SPIKE: "Hours spike", NEW_IN_RUN: "New in run", MISSING_FROM_RUN: "Missing from run", PRORATED: "Prorated",
  MISSING_BANK_ACCOUNT: "No bank account", UNREGISTERED_STATE: "Unregistered state", NEGATIVE_NET: "Negative net", TOTAL_CHANGE: "Total change",
  // wave 3 rules (docs/wave3.md)
  DUPLICATE_SUPPLEMENTAL: "Duplicate supplemental", RAISE_NOT_APPLIED: "Raise not applied", WITHHOLDING_CHANGED: "Withholding changed",
  PENDING_TIME_OFF_IN_PERIOD: "Pending time off", PTO_LINE: "Time off paid", REIMBURSEMENT_SPIKE: "Reimbursement spike",
};

/** Flag chip with an explanation popover showing the grounded explanation and whether the agent or a template wrote it. */
export function FlagChip({ pc, flag }: { pc: Paycheck; flag: Flag }) {
  const src = pc.explanationSource;
  const note = flagExplanation(pc, flag);
  const rows = flagEvidence(flag);
  return (
    <Popover>
      <PopoverTrigger
        data-testid={tid.payrollFlag(pc.workerId, flag.rule)}
        data-severity={flag.severity}
        data-tour="payroll-flag"
        data-rule={flag.rule}
        onClick={(e) => e.stopPropagation()}
        className={cn("inline-flex h-5 items-center rounded-md px-1.5 text-0 font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue-9)]", TONE[flag.severity])}
      >
        {RULE_LABEL[flag.rule]}{flag.severity === "block" ? " (blocks)" : ""}
      </PopoverTrigger>
      <PopoverContent align="start" collisionBoundary={appMain()} className="max-h-[var(--radix-popover-content-available-height)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className={cn("rounded-md px-1.5 py-0.5 text-0 font-medium", TONE[flag.severity])}>{RULE_LABEL[flag.rule]}</span>
          <span className="text-1 text-gray-10">{flag.severity === "block" ? "Blocks the run" : flag.severity === "review" ? "Needs review" : "Info"}</span>
        </div>
        <p className="mt-2 font-medium">{flagHeadline(flag)}</p>
        {note ? (
          <div className="mt-2 rounded-lg bg-gray-2 px-2.5 py-2">
            {note.scope === "paycheck" ? <p className="mb-1 text-1 text-gray-10">Note on this paycheck</p> : null}
            <p data-explanation-scope={note.scope} className="leading-5 whitespace-pre-wrap">{note.text}</p>
            <div data-explanation-source={src ?? ""} className="mt-1.5 flex items-center gap-1 text-1 text-gray-10">
              {src === "agent" ? <><Bot className="size-3.5" /> Explanation written by the agent</> : <><FileText className="size-3.5" /> Explanation from a template</>}
              {pc.explanationRunId ? <Link href={`/app/runs/${pc.explanationRunId}`} className="ml-auto text-blue-11 hover:underline">Run</Link> : null}
            </div>
          </div>
        ) : <p className="mt-2 text-1 text-gray-10">{emptyExplanation(pc.flags)}</p>}
        {rows.length ? (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-1">
            {rows.flatMap((r) => [<dt key={`k${r.label}`} className="text-gray-10">{r.label}</dt>,
              <dd key={`v${r.label}`} className="tabular-nums break-words">{r.href ? <Link href={r.href} className="text-blue-11 hover:underline">{r.value}</Link> : r.value}</dd>])}
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
