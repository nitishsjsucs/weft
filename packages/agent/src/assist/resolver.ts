// The instant path for "where is X" and "how do I Y" (research/cursor-assistant.md 4.3): a deterministic resolver over
// the help corpus, the screen map's labels and the nav registry. When it matches confidently, the assist run plays its
// answer (point, or navigate then point, plus one popover line) through the same presentation tools and the same
// executor checks, on a stand-in provider that makes no model call and costs nothing. Anything else (a question that
// needs data, a request to change something, two equally good matches) goes to the model.
import type { ModelProvider } from "@weft/contracts";
import {
  anchorOn, ASSIST_ANCHORS, ASSIST_HELP, ASSIST_NAV, routePattern, type AssistInput, type ScreenItem,
} from "../../../contracts/src/ext/assist";

export interface AssistCall { name: "ui__point" | "ui__navigate" | "ui__show" | "ui__say" | "ui__handoff" | "ui__steps"; args: Record<string, unknown> }
/** help, screen, nav: an instant answer; choice: a pick from an earlier question's options; handoff: a change request, which code hands to the full agent. */
export interface AssistResolution { via: "help" | "screen" | "nav" | "choice" | "handoff"; id: string; calls: AssistCall[] }

/** A request to change something (not a where or how question): the full agent takes it, with proposals a person approves. */
const CHANGE = /^(?:(?:please|can you|could you|would you|i want to|i need to|help me)\s+)?(?:give|raise|pay|fix|change|update|set|add|remove|delete|terminate|fire|hire|enroll|cancel|submit|run|process|correct|adjust|book|request|schedule|send|email|file|create|reimburse|issue|increase|decrease|transfer|offboard|onboard|correct|rehire)\b/;
/**
 * Decisions on a proposal (approve, deny) are a person's alone, so they are not handed off: the assistant shows the
 * proposal's approval card and the person makes the call (the model's own answer).
 */
export function readsAsChange(question: string): boolean {
  return CHANGE.test(norm(question));
}
/** "Lena Brooks (wrk_0026)": the person picked one of an earlier question's options (contracts choiceText). */
const CHOICE = /^(.{1,80}) \(((?:wrk|pay|prp)_[A-Za-z0-9_]{1,40})\)$/;
/**
 * An earlier request that only asked to open a record ("Open the account executive's record"): a choice answers it by
 * opening the one picked. One that asked for something about the record (a paycheck, a tab, a figure) goes to the
 * model with the earlier turn, so the choice continues that request instead.
 */
const OPEN_ONLY = /^(?:(?:please|can you|could you)\s+)?(?:open|show(?: me)?|go to|take me to|pull up|bring up|find)\b(?:(?!\b(?:paychecks?|pay ?stubs?|pay|tax(?:es)?|withholding|time off|pto|leave|benefits?|salary|expenses?|documents?|onboarding|tab|flags?|history|why|how|when|what)\b).)*$/;
const CHOICE_INTENT: Record<string, { intent: string; param: string }> = { wrk_: { intent: "people.open", param: "workerId" }, pay_: { intent: "payroll.open", param: "payrollId" }, prp_: { intent: "approval.card", param: "proposalId" } };

/** Questions about where something is or how to do something, in the person's words. */
const WHERE_HOW = /^(?:where(?:'s| is| are| do| can| would| should)?|how (?:do|can|would|should) (?:i|we|you)|how to|take me|go to|bring me|show me where|find)\b/;
/** Questions that need data (a figure, a reason, a time) go to the model, which reads before it answers. */
const NEEDS_DATA = /\b(?:how (?:many|much|long|often)|why|total|sum|average|count|balance|cost|owe|when (?:is|was|does|did|are|were))\b/;

const STOP = new Set(["the", "a", "an", "is", "are", "do", "i", "we", "my", "our", "to", "of", "on", "in", "for", "where", "how", "can", "find", "go", "me", "show", "take", "it", "this", "that", "page", "button", "there", "would", "should", "s", "you", "with", "and"]);

function norm(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[?!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
}
const words = (s: string) => norm(s).split(" ").filter((w) => w && !STOP.has(w));

/**
 * The app's own words: every word of a page's label and words, a help entry's label and an anchor's label. Written in
 * capitals in a question ("Where is the Audit log?", "How do I change Tax rates?") they name a place, not a person.
 */
const APP_WORDS = new Set([
  ...ASSIST_NAV.flatMap((n) => [n.label, ...n.words]), ...ASSIST_HELP.map((h) => h.label), ...Object.values(ASSIST_ANCHORS).map((a) => a.label), "Approve",
].flatMap((l) => l.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length > 2));

/** Capitalized words after the first that are not the app's own words: a name the question points at ("Ruth"). */
export function namesIn(text: string): string[] {
  return text.split(/\s+/).slice(1).map((w) => w.replace(/['’]s$|[^A-Za-z]/g, "")).filter((w) => /^[A-Z][a-z]{2,}$/.test(w) && !APP_WORDS.has(w.toLowerCase()));
}

/**
 * Nav words that are also everyday English: "Where is it?", "How do I access their documents?", "How do I exit this?"
 * name no page. The pages keep their other words ("laptops", "who can", "termination").
 */
const NAV_COMMON = new Set(["it", "access", "accounts", "exit", "start", "history", "leave"]);
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whether a phrase names what the question asks about: a match the question only names as an owner ("the new hire's
 * bank account", "Payroll's owner") asks about a field of that thing, which is no answer for the place it names.
 */
function asksAbout(re: RegExp, text: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) if (!text.startsWith("'s", m.index + m[0].length)) return true;
  return false;
}
/** The words that name a nav page, as patterns: a label in capitals matches only as written ("IT", never "it"). */
function navNames(n: (typeof ASSIST_NAV)[number]): { re: RegExp; cased: boolean; len: number }[] {
  const out: { re: RegExp; cased: boolean; len: number }[] = [];
  const cased = /^[A-Z]{2,4}$/.test(n.label);
  if (cased) out.push({ re: new RegExp(`\\b${esc(n.label)}\\b`), cased: true, len: n.label.length });
  for (const w of [...(cased ? [] : [n.label.toLowerCase()]), ...n.words]) {
    if (NAV_COMMON.has(w) || STOP.has(w)) continue;
    out.push({ re: new RegExp(`\\b${esc(w)}\\b`), cased: false, len: w.length });
  }
  return out;
}

const inside = (inner: ScreenItem, outer: ScreenItem) => {
  const [x, y, w, h] = inner.box, [X, Y, W, H] = outer.box;
  return x >= X - 1 && y >= Y - 1 && x + w <= X + W + 1 && y + h <= Y + H + 1;
};

/**
 * On the current page: the item the answer names (a card for the person, then its control), else the anchor. When the
 * question names someone and no card on the map is theirs, it is never the first card with that anchor (that would
 * ring another person's Approve): the anchor goes with the name as its hint, and the client rings the card holding
 * that name or says plainly that it is not there.
 */
function targetHere(input: AssistInput, anchor: string | null, label: string, names: string[]): string | null {
  const items = input.screen.items.filter((i) => !i.untrusted);
  const cards = names.length ? items.filter((i) => (i.kind === "card" || i.kind === "row") && names.some((n) => i.label.includes(n))) : [];
  if (cards.length === 1) {
    // "Approve it here": the control inside that person's card with the anchor's label, when the map has it.
    const want = norm(label).split(" ")[0] ?? "";
    const control = items.find((i) => i.kind === "button" && inside(i, cards[0]!) && norm(i.label).startsWith(want));
    return `@${(control ?? cards[0]!).n}`;
  }
  if (anchor) {
    const byAnchor = names.length ? undefined : items.find((i) => i.anchor === anchor);
    if (byAnchor) return `@${byAnchor.n}`;
    if (anchorOn(anchor, input.screen.route)) return `#${anchor}`;
  }
  return null;
}

function answer(route: string, anchor: string | null, label: string, text: string, input: AssistInput, names: string[], hosted: boolean): AssistCall[] {
  const here = input.screen.route.split("?")[0]!;
  // The answer's page, or an anchor that is on this page too (the top bar's, on every page): pointed at in place,
  // never a move that loses the page, its drawer or its tab.
  const same = routePattern(here) === route || here === route || (!!anchor && !!anchorOn(anchor, input.screen.route, { hosted }));
  if (same) {
    const t = targetHere(input, anchor, label, names);
    if (t) return [{ name: "ui__point", args: { target: t, label, hint: t.startsWith("#") ? names[0] ?? null : null } }, { name: "ui__say", args: { text } }];
  }
  return [{ name: "ui__navigate", args: { route, target: anchor ? `#${anchor}` : null, label, hint: names[0] ?? null } }, { name: "ui__say", args: { text } }];
}

/**
 * The resolution, or null when the question is not a where or how question the resolver can answer for sure.
 * `earlier`: the thread's last earlier question, when the exchange continues a conversation; a choice continues it.
 */
export function resolveAssist(question: string, input: AssistInput, opts: { hosted?: boolean; earlier?: string | null } = {}): AssistResolution | null {
  const t = norm(question);
  if (!t) return null;
  const choice = CHOICE.exec(question.trim());
  if (choice) {
    const id = choice[2]!;
    const label = choice[1]!.trim();
    const before = opts.earlier?.trim() ?? "";
    // A change the person asked for earlier ("give Lena a raise", two Lenas): the full agent takes it with the one picked.
    if (before && readsAsChange(before)) {
      return { via: "handoff", id: "change", calls: [{ name: "ui__handoff", args: { reason: "change", task: `${before.slice(0, 480)} (the person means ${label.slice(0, 80)}, ${id})` } }] };
    }
    // Anything but a plain open: the model reads the earlier turn and continues it with the id picked.
    if (before && !OPEN_ONLY.test(norm(before))) return null;
    const c = CHOICE_INTENT[id.slice(0, 4)]!;
    return { via: "choice", id, calls: [{ name: "ui__show", args: { intent: c.intent, params: [{ name: c.param, value: id }], target: null, action: null, label: label.slice(0, 40) } }, { name: "ui__say", args: { text: `Here is ${label.slice(0, 80)}.` } }] };
  }
  const where = WHERE_HOW.test(t) && !NEEDS_DATA.test(t);
  // A walkthrough question ("walk me through payroll", "how do I run payroll end to end") is a how question too.
  const walk = ASSIST_HELP.find((h) => h.steps && h.phrases.some((p) => new RegExp(p).test(t)));
  if (walk) {
    const steps = walk.steps!.map((st) => ({ route: st.route, target: `#${st.anchor}`, label: st.label, text: st.text }));
    return { via: "help", id: walk.id, calls: [{ name: "ui__steps", args: { steps } }, { name: "ui__say", args: { text: walk.answer } }] };
  }
  if (!where) return readsAsChange(question) ? { via: "handoff", id: "change", calls: [{ name: "ui__handoff", args: { reason: "change", task: question.trim().slice(0, 600) } }] } : null;
  const names = namesIn(question.trim());

  // 1. The help corpus: the first entry whose phrase matches (the corpus is ordered most specific first).
  const help = ASSIST_HELP.find((h) => !h.steps && h.phrases.some((p) => asksAbout(new RegExp(p), t)));
  if (help) return { via: "help", id: help.id, calls: answer(help.route, help.anchor, help.label, help.answer, input, names, !!opts.hosted) };

  // 2. A label on screen that the question names in full, when exactly one element has it.
  const qw = new Set(words(question));
  const labelled = input.screen.items.filter((i) => !i.untrusted && i.kind !== "landmark" && i.label.trim().length >= 4 && words(i.label).length > 0 && words(i.label).length <= 4 && words(i.label).every((w) => qw.has(w)));
  const distinct = [...new Map(labelled.map((i) => [norm(i.label), i])).values()];
  if (distinct.length === 1) {
    const i = distinct[0]!;
    return { via: "screen", id: `item-${i.n}`, calls: [{ name: "ui__point", args: { target: `@${i.n}`, label: i.label.slice(0, 40) } }, { name: "ui__say", args: { text: `It is here: ${i.label.slice(0, 60)}.` } }] };
  }

  // 3. A page the question names, when exactly one page matches best. A word that is also plain English ("it",
  // "access", "exit") never names a page by itself, and a label in capitals ("IT") counts only as written.
  const scored = ASSIST_NAV.filter((n) => !n.hosted || opts.hosted).map((n) => ({ n, len: Math.max(0, ...navNames(n).filter((w) => asksAbout(w.re, w.cased ? question : t)).map((w) => w.len)) }))
    .filter((x) => x.len > 0).sort((a, b) => b.len - a.len);
  if (scored.length && (scored.length === 1 || scored[0]!.len > scored[1]!.len)) {
    const n = scored[0]!.n;
    const here = input.screen.route.split("?")[0] === n.href;
    const text = here ? `You are on ${n.label}.` : `${n.label} is in the sidebar; here it is.`;
    if (here) return { via: "nav", id: n.slug, calls: [{ name: "ui__say", args: { text } }] };
    return { via: "nav", id: n.slug, calls: [{ name: "ui__navigate", args: { route: n.href, target: null, label: n.label } }, { name: "ui__say", args: { text } }] };
  }
  return null;
}

/** The model label the resolver's runs carry (provider scripted, model resolver): no model call, $0. */
export const RESOLVER_LABEL = "Resolver, no model";

/**
 * The stand-in provider for a resolved run: its first step plays the resolution's calls, and a later step (only when
 * the executor refused one of them) ends with a plain line. Usage is zero.
 */
export function resolverProvider(res: AssistResolution | null | undefined): ModelProvider {
  const zero = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  return {
    id: "scripted", model: "resolver", label: RESOLVER_LABEL, live: false,
    async step(req) {
      const step = req.history.filter((h) => h.kind === "model").length;
      if (step === 0 && res) {
        const toolCalls = res.calls.map((c, i) => ({ callId: `call_resolver_${i + 1}`, name: c.name, argumentsJson: JSON.stringify(c.args) }));
        return { stop: "tool_calls", text: "", toolCalls, native: { resolver: true, id: res.id, calls: toolCalls }, usage: zero, servedBy: "resolver", requestId: null };
      }
      const text = "I could not show that on this page. Ask the agent from the panel for more.";
      return { stop: "final", text, toolCalls: [], native: { resolver: true, step, text }, usage: zero, servedBy: "resolver", requestId: null };
    },
  };
}
