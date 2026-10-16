// Wave 3 parity commands in any namespace (notices.escalate, routines.set_autonomy, people.list_milestones,
// onboarding.ready_check, contractors.list_tax_forms; docs/wave3.md). Owner: w3-parity-routines. Append here only;
// commands/index.ts concatenates it, so the other namespace files stay untouched in wave 3.
//
// Landed: onboarding.ready_check (R0), onboarding.flag_not_ready (R1, an Inbox suggestion per blocked hire),
// reports.exec_figures (R0), comms.send_exec_report (R3 like comms.send_message; the text is built and grounded in
// code), routines.set_autonomy (R1, only ever executed as an approved proposal), people.list_milestones (R0).
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ChatChannel, MilestoneKind, Refused, RoutineAutonomy, W3_SETTINGS } from "@weft/contracts";
import { check } from "@weft/grounding";
import { routines, settings } from "@weft/db";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, ptDateOf, readCommand, responseFormatField, riskOf, writeCommand } from "../demo/define";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import { blockedText, readyCheck } from "../parity/ready-check";
import { execFigures, execReportText } from "../parity/exec-report";
import { upsertSuggestion } from "../parity/suggestions";
import { listMilestones } from "../parity/milestones";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Month = z.string().regex(/^\d{4}-\d{2}$/);

// ---------------------------------------------------------------- New Hire Ready Check

const ReadyInput = z.object({ business_days: z.number().int().min(1).max(10).optional(), as_of: Day.optional(), worker_id: z.string().optional(), ...responseFormatField });
type ReadyInput = z.infer<typeof ReadyInput>;
const readyCheckCommand = readCommand({
  name: "onboarding.ready_check", domain: "people",
  summary: "Day-one readiness for hires starting within the next business days.",
  description: "For each employee starting within business_days (default 3) of as_of (default today), check accounts, laptop, direct deposit, W-4, state form, I-9, benefits and state registration, and name the owner of each blocking item (the hire, IT, payroll). Example: {\"business_days\":null,\"as_of\":null,\"worker_id\":null}",
  input: ReadyInput,
  async run(i: ReadyInput, ctx, deps) {
    const r = await readyCheck(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { businessDays: i.business_days, workerId: i.worker_id });
    const blocked = r.hires.filter((h) => !h.ready).length;
    return { data: r, summary: `${r.hires.length} hires start by ${r.window_end}: ${r.hires.length - blocked} ready, ${blocked} blocked` };
  },
});

const FlagInput = z.object({ worker_ids: z.array(z.string().startsWith("wrk_")).max(20).optional(), as_of: Day.optional() });
type FlagInput = z.infer<typeof FlagInput>;
const flagNotReady = writeCommand<FlagInput>({
  name: "onboarding.flag_not_ready", summary: "Add Inbox suggestions to unblock hires' first days",
  description: "For each listed hire (default: every hire in the ready-check window) whose check is blocked, add or refresh one Inbox suggestion naming each blocking item and its owner. Items are recomputed here; ready hires are skipped. Example: {\"worker_ids\":[\"wrk_0049\"],\"as_of\":null}",
  input: FlagInput, domain: "people", needs: "edit", effect: "draft", risk: riskOf("R1"), approval: "never", reversible: false,
  tiers: { main: "executable", task: "unavailable" }, mcp: "hidden", preview: null,
  async run(i, ctx, deps) {
    const asOf = i.as_of ?? ptDateOf(ctx.now);
    const out: { worker_id: string; ready: boolean; suggestion_id: string | null; blocked: string[] }[] = [];
    const ids = i.worker_ids ?? (await readyCheck(deps.tx, ctx.companyId, asOf)).hires.map((h) => h.worker_id);
    for (const wid of [...new Set(ids)].sort()) {
      const h = (await readyCheck(deps.tx, ctx.companyId, asOf, { workerId: wid })).hires[0];
      if (!h) throw new DomainRefusal("DOMAIN_NOT_FOUND", `No employee ${wid} in this company`, "Use worker ids from onboarding.ready_check", null);
      if (h.ready) { out.push({ worker_id: wid, ready: true, suggestion_id: null, blocked: [] }); continue; }
      const s = await upsertSuggestion(deps.tx, deps, ctx.now, {
        companyId: ctx.companyId, command: "onboarding.flag_not_ready", subjectRef: h.worker_id,
        headline: `Unblock day one for ${h.name} (${h.worker_id}), starting ${h.start_date}`,
        content: [{ label: "Blocking items", text: blockedText(h) }, ...h.blocked.map((b) => ({ label: b.owner, text: b.label }))],
        evidence: [{ label: "worker", ref: h.worker_id }], domain: "people", onBehalfOf: ctx.onBehalfOf, runId: ctx.run?.id ?? null,
        routineRunId: ctx.routineRunId, taintedBy: ctx.tainted ? "run" : null,
      });
      out.push({ worker_id: wid, ready: false, suggestion_id: s.id, blocked: h.blocked.map((b) => b.item) });
    }
    const n = out.filter((o) => o.suggestion_id).length;
    return { data: { flagged: out }, summary: n ? `Added ${n} Inbox suggestions for blocked hires` : "Every hire is ready; no suggestion needed" };
  },
});

// ---------------------------------------------------------------- exec reports

const ReportKind = z.enum(["monthly", "weekly"]);
const FiguresInput = z.object({ kind: ReportKind.optional(), month: Month.optional(), as_of: Day.optional(), ...responseFormatField });
type FiguresInput = z.infer<typeof FiguresInput>;
const execFiguresCommand = readCommand({
  name: "reports.exec_figures", domain: "payroll",
  summary: "Headcount, hires, departures, turnover and payroll cost for an exec report.",
  description: "Computed figures for the monthly exec report (kind monthly; month defaults to the one that just ended in the first week) or the Monday briefing (kind weekly adds the next payday, hires starting in two weeks and registrations not active). Example: {\"kind\":\"monthly\",\"month\":null,\"as_of\":null}",
  input: FiguresInput,
  async run(i: FiguresInput, ctx, deps) {
    const f = await execFigures(deps.tx, ctx.companyId, { kind: i.kind ?? "monthly", asOf: i.as_of ?? ptDateOf(ctx.now), month: i.month });
    return { data: f, summary: `Exec figures for ${f.month_label}: ${f.headcount} employees, payroll cost ${f.cost.total_cost_display}` };
  },
});

export const EXEC_REPORT_CHANNEL: ChatChannel = "#leadership";
export const EXEC_REPORT_EMAIL = "leadership@larkspur.example";
const SendReportInput = z.object({ kind: ReportKind.optional(), month: Month.optional(), as_of: Day.optional() });
type SendReportInput = z.infer<typeof SendReportInput>;
async function reportOf(i: SendReportInput, ctx: { companyId: string; now: string }, deps: Parameters<WeftCommand["run"]>[2]) {
  const f = await execFigures(deps.tx, ctx.companyId, { kind: i.kind ?? "monthly", asOf: i.as_of ?? ptDateOf(ctx.now), month: i.month });
  const text = execReportText(f);
  const g = check(text, [f]);
  if (!g.ok) throw new Refused("UNGROUNDED", `Ungrounded numbers in the report: ${g.offending.join(", ")}`, { hint: "The report text is built from reports.exec_figures only", example: null });
  return { f, text };
}
const sendExecReport = writeCommand<SendReportInput>({
  name: "comms.send_exec_report", summary: "Post the exec report to #leadership and email it to the leadership list",
  description: "Build the monthly exec report or the Monday briefing from computed figures (the text is written in code, so every number is grounded), post it to #leadership and email it to the leadership list. R3 like comms.send_message. Example: {\"kind\":\"monthly\",\"month\":\"2026-10\",\"as_of\":null}",
  input: SendReportInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx, deps) {
    const { f, text } = await reportOf(i, ctx, deps);
    return { title: `Post the ${f.kind === "monthly" ? `${f.month_label} exec report` : "Monday exec briefing"} to ${EXEC_REPORT_CHANNEL}`, diff: [], content: [{ label: "Content to be sent", text }], moneyCents: null,
      subjectRef: `chat:${EXEC_REPORT_CHANNEL}`, subjectHash: sha256Hex(canonicalJson({ kind: f.kind, month: f.month, text: sha256Hex(text) })), evidence: [] };
  },
  async run(i, ctx, deps) {
    const { f, text } = await reportOf(i, ctx, deps);
    const { id } = await deps.sims.chat.post({ channel: EXEC_REPORT_CHANNEL, author: "Weft agent", text });
    const subject = f.kind === "monthly" ? `Exec report for ${f.month_label}` : `Monday exec briefing (${f.as_of})`;
    const mail = await deps.sims.email.send({ to: EXEC_REPORT_EMAIL, from: "agent@larkspur.example", subject, body: text, kind: "generic", relatedRef: f.month });
    return { data: { message_id: id, email_id: mail.id, channel: EXEC_REPORT_CHANNEL, month: f.month, kind: f.kind }, summary: `Posted the ${subject.toLowerCase()} to ${EXEC_REPORT_CHANNEL} and emailed ${EXEC_REPORT_EMAIL}` };
  },
});

// ---------------------------------------------------------------- autonomy

export const AUTONOMY_SETTING = W3_SETTINGS.allowAutoAutonomy;
export async function allowAutoAutonomy(tx: Parameters<WeftCommand["run"]>[2]["tx"]): Promise<boolean> {
  const [r] = await tx.select().from(settings).where(eq(settings.key, AUTONOMY_SETTING)).limit(1);
  if (!r) return false;
  try { return JSON.parse(r.valueJson) === true; } catch { return false; }
}

const AutonomyInput = z.object({ routine_id: z.string().startsWith("rt_"), autonomy: RoutineAutonomy });
type AutonomyInput = z.infer<typeof AutonomyInput>;
const setAutonomy = writeCommand<AutonomyInput>({
  name: "routines.set_autonomy", summary: "Change a routine's autonomy (recommend, approve or auto)",
  description: "Change how much a routine may do on its own: recommend (writes become Inbox suggestions), approve (writes wait for approval) or auto (allowed R2 commands under their limit run; R4 never). Always a proposal a person approves; auto needs agent.allow_auto_autonomy.",
  input: AutonomyInput, domain: "company", needs: "approve", effect: "write", risk: riskOf("R1"), approval: "never", reversible: false,
  tiers: { main: "unavailable", task: "unavailable" }, mcp: "propose",
  async preview(i, _ctx, deps) {
    const [r] = await deps.tx.select({ id: routines.id, name: routines.name, autonomy: routines.autonomy }).from(routines).where(eq(routines.id, i.routine_id));
    if (!r) throw new Refused("UNKNOWN_REFERENCE", `No routine ${i.routine_id}.`);
    return { title: `Set autonomy of ${r.name} (${r.id}) to ${i.autonomy}`, diff: [{ label: "autonomy", before: r.autonomy, after: i.autonomy }], content: [], moneyCents: null,
      subjectRef: r.id, subjectHash: sha256Hex(canonicalJson({ routine: r.id, from: r.autonomy, to: i.autonomy })), evidence: [{ label: "routine", ref: r.id }] };
  },
  async run(i, ctx, deps) {
    // The route files this as a proposal; only the approved proposal executes it (an API key cannot run it directly).
    if (!ctx.approvedProposalId) throw new Refused("NOT_PERMITTED", "Changing a routine's autonomy is a proposal; approve it in the Inbox.");
    const [r] = await deps.tx.select({ id: routines.id, autonomy: routines.autonomy }).from(routines).where(eq(routines.id, i.routine_id));
    if (!r) throw new Refused("UNKNOWN_REFERENCE", `No routine ${i.routine_id}.`);
    if (i.autonomy === "auto" && !(await allowAutoAutonomy(deps.tx))) {
      throw new DomainRefusal("DOMAIN_AUTO_AUTONOMY_OFF", "Auto autonomy is off for this company", `Turn on ${AUTONOMY_SETTING} in Settings first`, null);
    }
    await deps.tx.update(routines).set({ autonomy: i.autonomy }).where(eq(routines.id, i.routine_id));
    return { data: { routine_id: r.id, autonomy: i.autonomy, previous: r.autonomy }, summary: `Set ${r.id} autonomy from ${r.autonomy} to ${i.autonomy}` };
  },
});

// ---------------------------------------------------------------- milestones

const MilestonesInput = z.object({ as_of: Day.optional(), days: z.number().int().min(0).max(14).optional(), kinds: z.array(MilestoneKind).optional(), ...responseFormatField });
type MilestonesInput = z.infer<typeof MilestonesInput>;
const listMilestonesCommand = readCommand({
  name: "people.list_milestones", domain: "people",
  summary: "Work anniversaries and opted-in birthdays on a day or in the next few days.",
  description: "List work anniversaries (whole years since the start date) and birthdays of people who shared one (month and day only, never a year) on as_of (default today) or within days after it. Example: {\"as_of\":null,\"days\":null,\"kinds\":null}",
  input: MilestonesInput,
  async run(i: MilestonesInput, ctx, deps) {
    const r = await listMilestones(deps.tx, ctx.companyId, i.as_of ?? ptDateOf(ctx.now), { days: i.days ?? 0, kinds: i.kinds });
    return { data: r, summary: `${r.milestones.length} milestones from ${r.as_of} to ${r.until}` };
  },
});

export const parityCommands: WeftCommand[] = [readyCheckCommand, flagNotReady, execFiguresCommand, sendExecReport, setAutonomy, listMilestonesCommand];
