// The closing show of an assist exchange (the cursor assistant): what code, not the model, offers when a run ends,
// built from the run's own steps with no extra model call. A proposal the run filed becomes an approval.card chip
// (the card itself is in the trace's cards, and the intent rings its Inbox card); the records the answer cites
// become "Show me" chips (one per cited worker, pay run or proposal, at most four, the ones the answer names first),
// each through the same validated intents and routes the presentation tools use; and an answer that ends in a
// question while a read returned a few candidates offers them as choices, so the person picks one instead of typing.
// Pure: the trace route calls it on read.
import { ASSIST_ANCHORS, checkIntent, checkRoute, CLOSING_CHIPS, ENTITY_RE, fillSelectors, type AssistClosing, type ClosingChip } from "../../../contracts/src/ext/assist";

export { CLOSING_CHIPS, type AssistClosing, type ClosingChip };
interface StepLike { kind: string; toolName?: string | null; outcome?: string | null; result?: unknown }

/** The intent each kind of record opens through; a proposal shows its approval card (and rings its Inbox card). */
const OPEN: Record<string, { intent: string; param: string }> = { wrk_: { intent: "people.open", param: "workerId" }, pay_: { intent: "payroll.open", param: "payrollId" }, prp_: { intent: "approval.card", param: "proposalId" } };
const ID_KEYS = ["id", "worker_id", "workerId", "run_id", "payroll_run_id", "proposal_id", "proposalId"];
const LABEL_KEYS = ["name", "display_name", "displayName", "worker_name", "workerName", "headline", "title_text"];

/** A read's name often carries its id ("Lena Brooks (wrk_0026)"); the chip shows the name only. */
const bare = (s: string) => s.replace(/\s*\((?:[a-z]{2,5}_[A-Za-z0-9_:]+)\)\s*$/, "").trim().slice(0, 60);

function labelOf(o: Record<string, unknown>, id: string): string {
  for (const k of LABEL_KEYS) {
    const v = o[k];
    if (typeof v === "string" && bare(v)) return bare(v);
    if (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" && bare((v as { name: string }).name)) return bare((v as { name: string }).name);
  }
  if (id.startsWith("pay_")) {
    const a = o.period_start ?? o.periodStart, b = o.period_end ?? o.periodEnd;
    return typeof a === "string" && typeof b === "string" ? `Payroll ${a} to ${b}` : "Pay run";
  }
  return id.startsWith("wrk_") ? "Person" : "Proposal";
}

/** A read's "Name (id)" field, as the concise reads write a person ("worker": "Lena Brooks (wrk_0026)"). */
const NAMED = /^(.{1,80}) \(((?:wrk|pay|prp)_[A-Za-z0-9_]{1,40})\)$/;
const FALLBACK = new Set(["Person", "Pay run", "Proposal"]);

/**
 * The records a value names, in order: objects whose id key holds a worker, pay run or proposal id, with a label, and
 * "Name (id)" fields. A record first met without a name (a flag's evidence) takes the name when a later field has it.
 */
export function entitiesIn(v: unknown, out: Map<string, string> = new Map(), depth = 0): Map<string, string> {
  if (depth > 6 || out.size > 40 || !v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v) entitiesIn(x, out, depth + 1); return out; }
  const o = v as Record<string, unknown>;
  const put = (id: string, label: string) => { if (!out.has(id) || (FALLBACK.has(out.get(id)!) && !FALLBACK.has(label))) out.set(id, label); };
  for (const k of ID_KEYS) {
    const id = o[k];
    if (typeof id === "string" && ENTITY_RE.test(id) && OPEN[id.slice(0, 4)]) { put(id, labelOf(o, id)); break; }
  }
  for (const x of Object.values(o)) {
    const m = typeof x === "string" ? NAMED.exec(x) : null;
    if (m && ENTITY_RE.test(m[2]!) && OPEN[m[2]!.slice(0, 4)]) put(m[2]!, bare(m[1]!));
  }
  for (const x of Object.values(o)) if (x && typeof x === "object") entitiesIn(x, out, depth + 1);
  return out;
}

/** A chip for a record, or null when its intent or route does not validate. */
export function chipFor(id: string, label: string, opts: { hosted?: boolean } = {}): ClosingChip | null {
  const o = OPEN[id.slice(0, 4)];
  if (!o) return null;
  const params = [{ name: o.param, value: id }];
  const c = checkIntent(o.intent, params, []);
  if (!c.ok || (c.route && !checkRoute(c.route, opts).ok)) return null;
  const anchor = c.def.anchor ?? null;
  return { id, label, intent: o.intent, params, route: c.route, anchor, selectors: anchor ? fillSelectors(ASSIST_ANCHORS[anchor]?.selectors ?? [], c.params) : [] };
}

const outcomeOf = (s: StepLike) => (s.result as { outcome?: { ok?: boolean; status?: string; resultId?: string; data?: unknown } } | null)?.outcome;

export function closingShow(steps: readonly StepLike[], summary: string | null, opts: { hosted?: boolean } = {}): AssistClosing {
  const reads = steps.filter((s) => s.kind === "tool_call" && !(s.toolName ?? "").startsWith("ui__") && outcomeOf(s)?.ok && outcomeOf(s)?.status === "done");
  const proposals = [...new Set(steps.flatMap((s) => (s.kind === "tool_call" && s.outcome?.startsWith("pending:") ? [s.outcome.slice("pending:".length)] : [])))].filter((p) => ENTITY_RE.test(p));
  const cited = new Set((summary ?? "").match(/\bres_[A-Za-z0-9_]+\b/g) ?? []);
  const sources = cited.size ? reads.filter((s) => cited.has(outcomeOf(s)!.resultId ?? "")) : [];
  const chips: ClosingChip[] = [];
  const add = (id: string, label: string) => {
    if (chips.length >= CLOSING_CHIPS || chips.some((c) => c.id === id)) return;
    const c = chipFor(id, label, opts);
    if (c) chips.push(c);
  };
  for (const p of proposals) add(p, "The proposal");
  // The records the answer names come first (its id, or its name), then the rest of the cited results in their order,
  // so a long list's first rows never crowd out the one the answer is about.
  const said = (summary ?? "").toLowerCase();
  const word = (t: string) => new RegExp(`(?<![a-z0-9_])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`).test(said);
  const named = ([id, label]: [string, string]) => word(id) || (!FALLBACK.has(label) && label.length > 2 && word(label));
  const cands = sources.flatMap((s) => [...entitiesIn(outcomeOf(s)!.data)]);
  for (const [id, label] of [...cands.filter(named), ...cands.filter((c) => !named(c))]) add(id, label);
  // A question with a few candidates from one read: the person picks one (people first, then any list).
  let choose: AssistClosing["choose"] = null;
  const text = (summary ?? "").trim();
  if (text.endsWith("?")) {
    for (const s of [...reads].reverse()) {
      const found = [...entitiesIn(outcomeOf(s)!.data)].filter(([id]) => id.startsWith("wrk_") || id.startsWith("pay_"));
      if (found.length < 2 || found.length > 5) continue;
      const options = found.map(([id, label]) => chipFor(id, label, opts)).filter((c): c is ClosingChip => !!c);
      if (options.length >= 2) { choose = { question: text.slice(0, 300), options }; break; }
    }
  }
  return { chips: choose ? [] : chips, choose, proposals };
}
