// comms.send_message (harness 5.4, 5.6): R3, auto-allowed for an untainted main agent, delegated for task agents,
// afterPending "propose". Recipients only from the closed channel enum; plain text only (no card markup);
// numbers in the text must be grounded in company facts or, in a routine run, in the figures its precheck computed.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ChatChannel, Refused } from "@weft/contracts";
import { check, computedFigures } from "@weft/grounding";
import type { DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, ptDateOf, riskOf, writeCommand } from "../demo/define";

export const MAX_MESSAGE_CHARS = 1500;
const MARKUP = /<\s*\/?\s*[a-z!][^>]*>|\[\[?\s*card|"card_json"|card_json\s*[:=]/i;

/**
 * A row id in parentheses after a name ("Please welcome Noor Castellanos (demo) (wrk_0063)") means nothing in a
 * channel, so it goes from the text that is shown and posted. "(demo)" and other words in parentheses stay.
 */
const ROW_ID = "[a-z]{2,5}_[A-Za-z0-9_]*\\d[A-Za-z0-9_]*";
export const withoutRowIds = (t: string): string => t.replace(new RegExp(`\\s*\\(\\s*${ROW_ID}(?:\\s*,\\s*${ROW_ID})*\\s*\\)`, "g"), "");

const SendInput = z.object({ channel: ChatChannel.optional(), worker_id: z.string().optional(), text: z.string().min(1).max(MAX_MESSAGE_CHARS) });
type SendInput = z.infer<typeof SendInput>;

/** Deterministic company facts the message's numbers may cite (headcounts, pending approvals, onboarding dates). */
export async function groundingFacts(tx: DbTx, companyId: string, now: string) {
  const one = async (q: ReturnType<typeof sql>) => Number((await tx.all<{ n: number }>(q))[0]?.n ?? 0);
  const byState = await tx.all<{ s: string; n: number }>(sql`SELECT work_state AS s, COUNT(*) AS n FROM workers WHERE company_id = ${companyId} AND type = 'employee' GROUP BY work_state`);
  const onboarding = await tx.all<{ id: string; start_date: string }>(sql`SELECT id, start_date FROM workers WHERE company_id = ${companyId} AND status = 'onboarding'`);
  return {
    today: ptDateOf(now),
    employees_count: await one(sql`SELECT COUNT(*) AS n FROM workers WHERE company_id = ${companyId} AND type = 'employee' AND status IN ('active', 'onboarding', 'offboarding')`),
    contractors_count: await one(sql`SELECT COUNT(*) AS n FROM workers WHERE company_id = ${companyId} AND type = 'contractor'`),
    onboarding_count: onboarding.length, onboarding_start_dates: onboarding.map((o) => o.start_date),
    departures_count: await one(sql`SELECT COUNT(*) AS n FROM workers WHERE company_id = ${companyId} AND end_date IS NOT NULL`),
    pending_approvals_count: await one(sql`SELECT COUNT(*) AS n FROM proposals WHERE company_id = ${companyId} AND status = 'pending'`),
    open_notices_count: await one(sql`SELECT COUNT(*) AS n FROM notices WHERE company_id = ${companyId} AND status != 'resolved'`),
    by_state: Object.fromEntries(byState.map((r) => [r.s ?? "none", r.n])),
  };
}

/**
 * The figures a routine run computed in code (after the wave 4 model comparison): its precheck's findings and derived
 * arguments, stored on routine_runs before the agent run started, as one evidence item, or null. A prebuilt routine's
 * derived text quotes counts, totals and dates its precheck computed (the people digest's per-state counts after a
 * departure, a hire's start date), which no company fact holds, so the message was refused until the step cap.
 * computedFigures keeps only structured figures, never the derived text or any other prose, so a figure with no source
 * is still refused. The routine run comes from the executor's own context (never from the model's arguments) and must
 * belong to this company. A routine whose definition is tainted (a person's upload) contributes nothing: its precheck
 * read untrusted input.
 */
export async function routineFigures(tx: DbTx, companyId: string, routineRunId: string | null): Promise<unknown | null> {
  if (!routineRunId) return null;
  const [row] = await tx.all<{ p: string | null; t: string | null }>(sql`SELECT rr.precheck_json AS p, r.tainted_by AS t FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE rr.id = ${routineRunId} AND r.company_id = ${companyId} LIMIT 1`);
  if (!row?.p || row.t) return null;
  let pre: { action?: unknown; findings?: unknown; derivedArgs?: unknown };
  try { pre = JSON.parse(row.p) as typeof pre; } catch { return null; }
  if (!pre || pre.action !== "run") return null;
  const figures = computedFigures({ findings: pre.findings ?? null, derived: pre.derivedArgs ?? null });
  return figures === null ? null : { routine_precheck: figures };
}

function validate(i: SendInput): ChatChannel {
  if (!i.channel || i.worker_id) {
    throw new DomainRefusal("DOMAIN_RECIPIENT", i.worker_id ? "Direct messages are not available in the chat simulator yet; post to a channel" : "channel is required", "Pick one channel from the enum", { channel: "#new-hires", text: i.text.slice(0, 80) });
  }
  if (MARKUP.test(i.text)) throw new DomainRefusal("DOMAIN_MARKUP", "Messages are plain text; markup and approval cards are not allowed", "Remove HTML tags and card markup", null);
  return i.channel;
}

export const sendMessage = writeCommand({
  name: "comms.send_message", summary: "Post a plain-text message to a company chat channel.",
  description: "Post a plain-text message (text, up to 1500 characters) to one company channel: #people-ops, #payroll, #new-hires or #general. No markup or cards. Numbers must match company facts or, in a routine run, its findings and derived arguments; post a derived text as is. R3: runs without approval for an untainted main agent; otherwise it becomes a proposal with the text shown in full.",
  input: SendInput, domain: "comms", needs: "edit", effect: "external", risk: riskOf("R3"), approval: "always", autoAllow: "untainted",
  afterPending: "propose", reversible: false, tiers: { main: "executable", task: "delegated" },
  async preview(i, ctx) {
    const channel = validate(i);
    return { title: `Post a message to ${channel}`, diff: [], content: [{ label: "Content to be sent", text: withoutRowIds(i.text) }], moneyCents: null, subjectRef: `chat:${channel}`, subjectHash: sha256Hex(canonicalJson({ channel, text: sha256Hex(i.text), at: ctx.now.slice(0, 10) })), evidence: [] };
  },
  async run(i, ctx, deps) {
    const channel = validate(i);
    const computed = await routineFigures(deps.tx, ctx.companyId, ctx.routineRunId);
    const g = check(i.text, [await groundingFacts(deps.tx, ctx.companyId, ctx.now), ...(computed ? [computed] : [])]);
    if (!g.ok) {
      const hint = computed
        ? "Use only numbers from company facts or from this routine's findings and derived arguments; post the derived text as is"
        : "Use only numbers from company facts (headcounts, pending approvals, onboarding dates), or leave the numbers out";
      throw new Refused("UNGROUNDED", `Ungrounded numbers in the message: ${g.offending.join(", ")}`, { hint, example: null });
    }
    const text = withoutRowIds(i.text);
    const { id } = await deps.sims.chat.post({ channel, author: "Weft agent", text });
    return { data: { message_id: id, channel, chars: text.length }, summary: `Posted to ${channel} (${id})` };
  },
});
