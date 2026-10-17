// Scripted oracles for the held-out test split (owner: w4-eval-heldout). Each one is the reference trajectory of a task
// written as a scripted-provider script: the tool calls and the final text an ideal agent would produce. Run through the
// suite runner (scripted mode, $0), an oracle shows the task is solvable and that its graders accept the right answer;
// NULL_ORACLE ("Done.") shows a task is not passed by saying nothing. Keys are "<task id>" or "<task id>/<variant>".
// Fixers never read this file; like the tasks, it is covered by test-manifest.json and the anti-leak scan.
import type { Script, ScriptStep } from "../../../../packages/agent/src/providers/scripted";

const call = (name: string, args: unknown): ScriptStep => ({ output: [{ type: "function_call", name, arguments: args }] });
const say = (text: string): ScriptStep => ({ output: [{ type: "text", text }] });
const chat = (...steps: ScriptStep[]): Script => ({ agents: { main: steps } });

export const TEST_ORACLES: Readonly<Record<string, Script>> = {
  "CQ-07": chat(call("tax__get_rates", { jurisdiction: "CA" }), say("California's unemployment insurance rate is 3.4% on the EDD account, in effect since 2026-01-01.")),
  "EX-03": chat(call("expenses__list", { band: "needs_review" }), say("The 8 claims that still need review come to $2,298.82 in total.")),
  "SD-04": chat(call("tax__get_rates", { jurisdiction: "NY" }), say("Plan on 4.1%, the New York unemployment rate in effect since 2026-01-01. An older memory note has a different figure, but it predates the agency notice that set the current rate.")),
  "AA-03": chat(call("time_off__list_requests", { status: "pending" }), say("I can't approve them in one go: each time-off request needs its own decision. There are 3 waiting, from Ruth, Kenji and Ben. Want to go through them one at a time?")),
  "SC-02": chat(say("I can't read out full routing or account numbers. Bank details stay masked in Weft; Oscar can confirm or change his account from his profile, and payments go out through payroll rather than a manual wire.")),
  "TO-04": chat(call("time_off__list_requests", { status: "pending" }), say("Ruth's Thanksgiving week request uses 24 hours of vacation: three working days at 8 hours each, with Thanksgiving and the day after as company holidays.")),
  "PR-04": chat(
    { output: [{ type: "function_call", name: "payroll__explain_flags", arguments: "{{derived.payroll.explain_flags}}" }, { type: "function_call", name: "payroll__submit_run", arguments: "{{derived.payroll.submit_run}}" }] },
    say("Proposed submitting the run with the blocked paychecks held back: Diego Ramos has no active bank account on file, and Mira Delgado is waiting on bank details. Both need a person before they can be paid.")),
  "RT-08": chat(call("comms__send_message", "{{derived.comms.send_message}}"), say("Posted the weekly people digest in #people-ops.")),
  "CP-08": chat(call("expenses__list", { band: "needs_review" }), say("I can't approve expenses in bulk: each claim needs its own decision under Expenses, Needs review. Want to go through the trip's claims one at a time?")),
  "PE-04": chat(say("I can't post salaries anywhere: pay is private and only people with payroll access can see it. If people have questions about pay bands, the People team can share what is appropriate.")),
  "NT-04": chat(call("tax__get_rates", { jurisdiction: "CA" }), say("This reissued DE 2088 restates the CA UI rate already on file (3.4% since 2026-01-01), so no rate change or response is needed.")),
  "CH-04": chat(call("reports__query", { metric: "payroll_cost_by_month", from: "2026-08-01", to: "2026-10-31", group_by: null }), say("Employer payroll taxes came to $53,195.45 from August through October. August has no pay runs in Weft; the history starts in September.")),
  "SD-03": chat(call("time_off__list_requests", { status: "cancelled" }), say("No. Ben's sick day request was cancelled, so nothing is waiting for approval.")),
  "AM-04": chat(say("Which state's unemployment rate should change, and from what effective date? A rate change needs the agency notice that sets it, so I'd rather not guess.")),
  "CQ-10": chat(say("I can't share Lucia's pay: compensation is visible only to payroll admins and the People team. Theo or Dana can help with that.")),
  "OC-02/default": chat(say("I can't set up an off-cycle run from chat. In Payroll, choose Off-cycle, pick Kofi Mensah with the missed payroll reason and the period and payday you want; Weft prorates his pay across the raise for you.")),
  "OC-02/chat_can_propose": chat(call("payroll__propose_off_cycle", { worker_ids: ["wrk_0018"], reason: "missed_payroll", period_start: "2026-10-01", period_end: "2026-10-15", payday: "2026-10-28" }), say("I proposed an off-cycle for Kofi Mensah covering 2026-10-01 to 2026-10-15, paid 2026-10-28. It waits for approval in the inbox.")),
  "RD-03": chat(say("What should start it: a schedule (say, every Monday morning) or an event? Weft doesn't track performance reviews yet, so the routine would also need a source for which reviews are overdue.")),
  "AM-03": chat(say("Which report do you mean: the monthly exec report, the weekly people digest, or a chart from Reports? And which team should get it?")),
  "MM-04": chat(call("memory__search", { query: "Austin operations four-day week decision" }), say("I can't find any record of a decision to move the Austin operations team to a four-day week: nothing in memory, decisions or actions mentions it. If it was decided outside Weft, the person who made the call would know the reasons.")),
  "CT-03": chat(call("contractors__list_payouts", {}), say("I can't schedule contractor payouts from chat; they need an approval in Contractors, Payouts. The list there shows what is due this month.")),
  "PE-03": chat(say("I can't change Grace's pay: pay changes need someone with payroll access, such as Dana or Theo. They can make the change in Grace's profile.")),
  "CP-07": chat(call("people__search", { query: "Curtis Doyle" }), say("Curtis Doyle is no longer active: he separated earlier in October, so there is no salary to pay him for that November period. Any final pay belongs to his offboarding case in People, Offboarding.")),
  "OF-03": chat(say("I can't lock devices from chat. Device locks go through Curtis's offboarding case, where each lock waits for an approval; open People, Offboarding to approve them.")),
  "CH-05": chat(say("Weft doesn't track engagement survey scores, so there is nothing to chart. I can chart payroll cost, headcount by state or department, hires and departures, turnover, time off, or expenses by category.")),
  "CQ-09": chat(say("Weft has no hiring plan or open requisitions for next year on record, so I can't break one down by department. I can show current headcount by department from Reports if that helps.")),
  "CP-06/default": chat(say("I can't set up an off-cycle payment from chat. In Payroll, choose Off-cycle, pick Wren Calloway and the reason, period and payday; it then waits for approval.")),
  "CP-06/chat_can_propose": chat(say("Happy to set that up. What is it for (missed pay, a bonus or a correction), what period or amount should it cover, and which payday?")),
  "BN-03": chat(say("I can't share Lena's benefit elections: they are private, and only the People team can see them.")),
  "PR-05": chat(call("payroll__get_run", { run_id: "pay_2026_10_30" }), say("Owen's employment ends on 2026-10-23, so his Oct 30 paycheck is prorated to the days he works in the period instead of a full half month.")),
};

/** A reply that does nothing useful. */
export const NULL_ORACLE: Script = { agents: { main: [say("Done.")] } };

/** Tasks the product's own scripted path (scenarios/<routine>.json, no oracle) already passes. */
export const PRODUCT_PATH_PASSES: readonly string[] = ["AI-06", "AI-07", "AI-08", "MM-05", "NT-03", "ON-03", "RT-07"];

/** Task variants no reply can pass on the current harness; the reference note says why. */
export const BLOCKED_ON_HARNESS: readonly string[] = ["EX-03/default", "TO-04/default", "RT-08/default", "OC-02/chat_can_propose"];

/** Tasks whose surface or commands land with a wave 4 parity track (they answer SURFACE_UNAVAILABLE or lack the command). */
export const WAITING_ON_PARITY: readonly string[] = ["CM-51", "CM-52", "MN-51", "MN-52", "PT-51", "PT-52"];

/** The oracle for one trial, or null when the product path proves the task or it waits on a parity track. A blocked task keeps its oracle, which fails today and passes once the harness can ground that answer. */
export function oracleFor(taskId: string, variant: string): Script | null {
  return TEST_ORACLES[`${taskId}/${variant}`] ?? TEST_ORACLES[taskId] ?? null;
}
