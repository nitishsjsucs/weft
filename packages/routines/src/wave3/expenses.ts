// Wave 3 routines, prechecks and checklist predicates (docs/wave3.md). Owner: w3-expenses.
// prebuilt.ts, prechecks.ts and checks.ts spread these in; add entries here only. New routines ship disabled unless their
// golden path needs them enabled, keep their tools at 8 or fewer, and use new ids (rt_ prefix).
// rt_expense_review (research/wave3/expenses-timeoff.md 7.5): on weekday mornings, or on demand ("Review with agent"),
// a deterministic precheck lists the items awaiting a decision with the policy engine's checks and suggestion; the
// model explains each one and proposes exactly one decision per item (expenses.decide takes one id; there is no bulk
// approval). Every decision is a proposal a person approves in the Inbox. Its scripted run is scenarios/rt_expense_review.json.
import type { Precheck, ReadOnlyExecutor, RoutineDef } from "@weft/contracts";
import type { Predicate, RunCall, RunFacts } from "../checks";

const TZ = "America/Los_Angeles";
/** Items one run reviews at most (oldest first); the rest wait for the next run. */
export const EXPENSE_REVIEW_MAX_ITEMS = 8;

export const RT_EXPENSE_REVIEW: RoutineDef = {
  id: "rt_expense_review", name: "Expense review",
  description: "Weekday mornings, check every expense awaiting review against the policy, explain it, and propose one decision per item for a person to approve.",
  ownerPrincipalId: "usr_dana", enabled: false, autonomy: "approve", trigger: { type: "cron", cron: "0 9 * * 1-5", tz: TZ }, filter: null,
  instructions: [
    "For each expense in the derived list, in order: save one explanation with expenses.explain (numbers and dates only from that item's claim and checks; never quote the merchant or purpose),",
    "then propose exactly one decision with expenses.decide for that one expense_id. Never put several items in one decision; there is no bulk approval.",
    "Follow the derived suggestion unless the checks say otherwise: a duplicate is declined as duplicate, a missing receipt is returned with a note, past 60 days is approve_taxable or decline,",
    "and a California item over a category limit is proposed as approve with the note that a person must judge whether it was necessary (never decline it for the limit alone).",
    "Then write a one-line summary of what you proposed.",
  ].join(" "),
  tools: ["expenses.list", "expenses.get", "expenses.check_policy", "expenses.explain", "expenses.decide", "people.get", "comms.send_message", "agent.read_artifact"],
  precheck: "expense_review",
  checklist: [
    { id: "explained", label: "explain every expense awaiting review", check: "expenses_explained:{expense_ids}" },
    { id: "proposed", label: "propose one decision per expense", check: "expense_decisions_proposed:{expense_ids}" },
  ],
  budget: { steps: 24, usd: 0.08, minutes: 15 }, surface: { worthSurfacing: true, channel: null }, source: "prebuilt", taintedBy: null,
};

interface ListItem { expense_id: string; worker: string; category: string; amount_cents: number; amount_display: string; status: string; checks: { rule: string; severity: string; message: string }[] }
interface Suggestion { decision: "approve" | "approve_taxable" | "return" | "decline"; reasonCode: string | null; note: string; humanNote: string | null }
interface GetItem { expense_id: string; allowed_decisions: string[]; suggestion: Suggestion | null }

async function read<T>(exec: ReadOnlyExecutor, companyId: string, command: string, args: unknown): Promise<T | null> {
  const o = await exec.exec(companyId, command, args);
  return o.ok && o.status === "done" ? (o.data as T) : null;
}

/** The decide arguments the engine suggests for one item (one expense_id, never a list). */
export function decisionArgs(id: string, s: Suggestion): Record<string, string> {
  const note = s.humanNote ?? s.note;
  return { expense_id: id, decision: s.decision, ...(s.decision === "decline" ? { reason_code: s.reasonCode ?? "other" } : {}), ...(note ? { note } : {}) };
}

export const expenseReview: Precheck = async (ctx, exec) => {
  const list = await read<{ expenses: ListItem[] }>(exec, ctx.companyId, "expenses.list", { status: "needs_review" });
  if (!list) return { action: "skip", reason: "The expense list could not be read." };
  const open = list.expenses.slice(0, EXPENSE_REVIEW_MAX_ITEMS);
  if (open.length === 0) return { action: "skip", reason: "No expense is waiting for review." };
  const items: { item: ListItem; get: GetItem }[] = [];
  for (const item of open) {
    const got = await read<{ expense: GetItem }>(exec, ctx.companyId, "expenses.get", { expense_id: item.expense_id });
    if (got?.expense.suggestion) items.push({ item, get: got.expense });
  }
  if (items.length === 0) return { action: "skip", reason: "No expense awaiting review has a policy result yet." };
  const decisions = items.map(({ item, get }) => decisionArgs(item.expense_id, get.suggestion!));
  return {
    action: "run", severity: "digest", subjectRefs: items.map(({ item }) => item.expense_id),
    findings: {
      count: items.length, waiting_beyond_this_run: Math.max(0, list.expenses.length - items.length),
      items: items.map(({ item, get }) => ({
        expense_id: item.expense_id, worker: item.worker, category: item.category, amount_display: item.amount_display,
        checks: item.checks.map((c) => `${c.rule} (${c.severity}): ${c.message}`), allowed_decisions: get.allowed_decisions,
        suggested: get.suggestion!.decision, human_note: get.suggestion!.humanNote,
      })),
    },
    derivedArgs: {
      expense_ids: items.map(({ item }) => item.expense_id).join(","),
      "expenses.explain": { items: items.map(({ item }) => ({ expense_id: item.expense_id })) },
      decisions,
    },
  };
};

const wire = (s: string) => s.replace("__", ".");
const callsTo = (f: RunFacts, command: string) => f.calls.filter((c) => wire(c.command) === command);
const live = (f: RunFacts, c: RunCall) => {
  if (c.status !== "pending_approval" || !c.proposalId) return c.status === "done";
  const s = f.proposalStatus(c.proposalId) ?? "pending";
  return !["denied", "expired", "failed", "superseded", "dismissed"].includes(s);
};
const idsOf = (csv: string) => csv.split(",").map((x) => x.trim()).filter(Boolean);

/** Every listed expense got an explanation saved (agent or template) in this run. */
const expensesExplained: Predicate = ([csv = ""], f) => {
  const ids = idsOf(csv);
  const saved = new Set(callsTo(f, "expenses.explain").filter((c) => c.status === "done")
    .flatMap((c) => ((c.data as { results?: { expense_id: string; status: string }[] } | null)?.results ?? []).filter((r) => r.status === "saved").map((r) => r.expense_id)));
  return ids.length > 0 && ids.every((id) => saved.has(id));
};

/** Exactly one live decision proposal per listed expense, each naming exactly that one id. */
const expenseDecisionsProposed: Predicate = ([csv = ""], f) => {
  const ids = idsOf(csv);
  const proposed = callsTo(f, "expenses.decide").filter((c) => c.status === "pending_approval" && live(f, c)).map((c) => (c.args as { expense_id?: unknown } | null)?.expense_id);
  return ids.length > 0 && ids.every((id) => proposed.filter((p) => p === id).length === 1);
};

export const routines: RoutineDef[] = [RT_EXPENSE_REVIEW];
export const prechecks: Record<string, Precheck> = { expense_review: expenseReview };
export const predicates: Record<string, Predicate> = { expenses_explained: expensesExplained, expense_decisions_proposed: expenseDecisionsProposed };
