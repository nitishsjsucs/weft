// Wave 4 routines, prechecks and checklist predicates (docs/wave4.md). Owner: w4-parity-admin.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
//
// - rt_weekly_cost_by_state (R16): Mondays 08:00 PT. Emails leadership the payroll cost by work state for the year to
//   date as a comms.send_report proposal (approval always): the precheck reads reports.breakdown in code, the email
//   text and every number in it are built and grounded in code from the same rows, and the model only passes the
//   derived arguments. A year with no paid run skips with zero tokens. Disabled.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate } from "../checks";

const TZ = "America/Los_Angeles";
const OWNER = "usr_dana";
export const COST_BY_STATE_RECIPIENTS = ["leadership@larkspur.example"] as const;

export const RT_WEEKLY_COST_BY_STATE: RoutineDef = {
  id: "rt_weekly_cost_by_state", name: "Weekly cost by state",
  description: "Monday mornings, email leadership the payroll cost by work state for the year so far: gross pay, employer taxes, benefits and reimbursements per state. The email waits for approval before it is sent.",
  ownerPrincipalId: OWNER, enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 8 * * 1", tz: TZ }, filter: null,
  instructions: "Call comms.send_report with the derived arguments as is; it builds the email text and its numbers from the report rows. Do not restate numbers yourself. Then write a one-line final message.",
  tools: ["reports.breakdown", "comms.send_report"],
  precheck: "weekly_cost_by_state",
  checklist: [{ id: "proposed", label: "propose the cost by state email to leadership", check: "report_proposed:payroll_cost_by_state:{from}" }],
  budget: { steps: 4, usd: 0.03, minutes: 10 }, surface: { worthSurfacing: false, channel: null }, source: "prebuilt", taintedBy: null,
};

type Obj = Record<string, unknown>;
const ptDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

async function read(exec: ReadOnlyExecutor, companyId: string, command: string, args: Obj): Promise<Obj | null> {
  const o = await exec.exec(companyId, command, args);
  return o.ok && o.status === "done" && o.data && typeof o.data === "object" ? (o.data as Obj) : null;
}

/** Year to date on the company calendar; skip when no paid run falls in it (nothing to report, zero tokens). */
export const weeklyCostByState: Precheck = async (ctx, exec) => {
  const to = ptDate(ctx.now);
  const from = `${to.slice(0, 4)}-01-01`;
  const r = await read(exec, ctx.companyId, "reports.breakdown", { metric: "payroll_cost_by_state", from, to });
  if (!r) return { action: "skip", reason: "The payroll cost by state could not be read." };
  const rows = (Array.isArray(r.rows) ? r.rows : []) as Obj[];
  if (!rows.length) return { action: "skip", reason: `No paid payroll run between ${from} and ${to}.` };
  const totals = (r.range_totals && typeof r.range_totals === "object" ? r.range_totals : {}) as Obj;
  return {
    action: "run", severity: "digest", subjectRefs: [],
    // Findings carry the computed figures for the trace; comms.send_report recomputes the same rows and grounds its text.
    findings: { from, to, states: rows.map((x) => ({ state: x.state, total_cents: x.total_cents })), total_cents: totals.total_cents ?? null },
    derivedArgs: { from, to, "comms.send_report": { metric: "payroll_cost_by_state", from, to, recipients: [...COST_BY_STATE_RECIPIENTS] } },
  };
};

const wireToName = (s: string) => s.replace("__", ".");

export const routines: RoutineDef[] = [RT_WEEKLY_COST_BY_STATE];
export const prechecks: Record<string, Precheck> = { weekly_cost_by_state: weeklyCostByState };
export const predicates: Record<string, Predicate> = {
  /** A live comms.send_report proposal (or a send) for this metric and range start. */
  report_proposed: ([metric = "", from = ""], f) => f.calls.some((c) => {
    if (wireToName(c.command) !== "comms.send_report") return false;
    const a = (c.args ?? {}) as Obj;
    if (a.metric !== metric || (from && a.from !== from)) return false;
    if (c.status === "done") return true;
    if (c.status !== "pending_approval" || !c.proposalId) return false;
    return !["denied", "expired", "failed", "superseded", "dismissed"].includes(f.proposalStatus(c.proposalId) ?? "pending");
  }),
};
