// The guided tour's steps as pure data (owner: tour). The app, vitest and the Playwright tour specs all read this
// file, so it imports nothing from React or the browser. Targets are [data-tour~="..."] tokens kept apart from
// data-testid, so the tests and the tour evolve independently. Placeholders in braces ({noticeRunId}, {draftId},
// ...) are filled from the tour memo at step entry; a target whose placeholder is still empty is treated as missing.

export const TOUR_BUDGET_MS = 180_000;
/** The prompt the chart step types into the composer. scenarios/chat_payroll_cost.json matches it ("payroll cost"). */
export const TOUR_CHART_PROMPT = "Show payroll cost by month";
/** The DE 2088 scenario the tour delivers (3.4% to 1.5%, from the simulator). */
export const TOUR_NOTICE_SCENARIO = "ca_de2088_rate_change";
/** The person page the tour opens: Lena Brooks (demo), whose raise flags GROSS_CHANGE on the Oct 30 draft. */
export const TOUR_PERSON = "wrk_0026";
/** The persona the tour views as (approve and undo need an admin); restored on exit. */
export const TOUR_PRINCIPAL = "usr_dana";
export const TOUR_STATE_KEY = "weft.tour.v1";
export const TOUR_SEEN_KEY = "weft.tour.seen";

export type TourAction = "next" | "click" | "wait-run" | "ask" | "finish";
export type TourRoute =
  | { kind: "path"; path: string }
  | { kind: "draft" }      // /app/payroll/<current draft id>
  | { kind: "portal" }     // /portal?as=<persona>
  | { kind: "same" };      // no navigation

/** What the tour remembers between steps (sessionStorage weft.tour.v1). */
export interface TourMemo {
  noticeRunId?: string | null;
  delivered?: boolean;
  rateProposalId?: string | null;
  /** True only when rateProposalId came from this session's own notice run (autoplay may approve only that one). */
  rateProposalOwn?: boolean;
  approved?: boolean;
  approveError?: string | null;
  rateSeq?: number | null;
  undoneSeq?: number | null;
  draftId?: string | null;
  personaId?: string | null;
  hireName?: string | null;
  chartRunId?: string | null;
  asked?: boolean;
}

export interface TourStep {
  id: string;
  n: number;
  route: TourRoute;
  /** Primary target; null centers the card as a dialog. */
  target: string | null;
  /** Tried in order when the primary target is missing (or its placeholder is empty). */
  fallbacks?: string[];
  /** Dashed secondary marks. */
  secondary?: string[];
  /** What the copy names next to the target: the card keeps clear of it when it can (secondary marks count too). */
  avoid?: string[];
  /** Controls the tour clicks before it rings the target (a tab, a flag, a row). The first match of each list is used. */
  prepare?: string[][];
  title: string;
  body: string;
  action: TourAction;
  seconds: number;
  /** wait-run: soft timeout turns Next on; hard timeout swaps in the fallback copy (capped by the budget). */
  softMs?: number;
  hardMs?: number;
  /** Deliver and Approve run once: on Back or replay they show the done state with Next. */
  once?: boolean;
  /** Proxy button label for click and ask steps. */
  proxyLabel?: string;
  /** Agent steps open the panel; on a phone the sheet docks at the top. */
  agent?: boolean;
  /** Steps that open an app popover or drawer dock the card beside it. */
  dock?: "side";
  /** Below 1024 px the bridge opens the nav drawer before locating the target. */
  nav?: boolean;
  /** Where the card docks on a phone, when the default (top for agent steps, else away from the target) hides what the copy names. */
  sheet?: "top" | "bottom";
  /** The popover the step opens drops below the target: scroll the target low enough for the card to fit above it. */
  cardAbove?: boolean;
  /** How the target scrolls into view (default center); "start" for a tall target whose head is what matters. */
  block?: ScrollLogicalPosition;
  /** An element inside the target to scroll into view sideways (a column in a table that scrolls on a phone). */
  reveal?: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome", n: 1, route: { kind: "path", path: "/app" }, target: null,
    title: "Welcome to Weft",
    body: "Larkspur Robotics (demo) is a made-up company on simulators. Watch the agent handle a tax notice, then take a fast lap.",
    action: "next", seconds: 6,
  },
  {
    id: "env-pill", n: 2, route: { kind: "path", path: "/app" }, target: '[data-tour~="env-pill"]',
    title: "Your demo controls",
    body: "The agent's model, the simulated clock every date reads, and who you are viewing as. The tour leaves the clock alone.",
    action: "next", seconds: 6,
  },
  {
    id: "agent-panel", n: 3, route: { kind: "path", path: "/app" }, target: '[data-tour~="agent-panel"]', agent: true,
    title: "Meet the agent",
    body: "It uses the tools you click, under your permissions. Anything touching money or records waits for a person.",
    action: "next", seconds: 6,
  },
  {
    id: "deliver-notice", n: 4, route: { kind: "path", path: "/app/simulators" },
    target: `[data-tour~="sim-deliver"][data-scenario="${TOUR_NOTICE_SCENARIO}"]`, agent: true, once: true,
    title: "A letter from the state",
    body: "California just revised Larkspur's unemployment insurance rate. Deliver the simulated notice and watch what happens next.",
    action: "click", proxyLabel: "Deliver notice", seconds: 6, hardMs: 8_000,
  },
  {
    id: "agent-run", n: 5, route: { kind: "same" }, target: '[data-tour~="agent-run"][data-run-id="{noticeRunId}"]', agent: true, sheet: "bottom",
    title: "The agent at work",
    body: "Each line is a tool call: it read the notice, checked the current rate and drafted a reply. The rate change and the filing stop here and wait for you.",
    action: "wait-run", seconds: 10, softMs: 12_000, hardMs: 20_000,
  },
  {
    id: "inbox-proposal", n: 6, route: { kind: "path", path: "/app/inbox" },
    target: '[data-tour~="inbox-card"][data-proposal-id="{rateProposalId}"]', sheet: "bottom", block: "start",
    fallbacks: ['[data-tour~="inbox-card"][data-status="pending"][data-has-diff="true"]', '[data-tour~="inbox-card"][data-status="pending"]'],
    secondary: ['[data-tour~="inbox-card"][data-proposal-id="{rateProposalId}"] [data-tour~="proposal-risk"]', '[data-tour~="inbox-card"][data-proposal-id="{rateProposalId}"] [data-tour~="proposal-diff"]', '[data-tour~="inbox-card"][data-proposal-id="{rateProposalId}"] [data-tour~="proposal-evidence"]'],
    title: "One proposal, all the facts",
    body: "The risk class says what kind of change this is, the table shows the money before and after, and the evidence links to the notice and the current rate. Nothing has changed yet.",
    action: "next", seconds: 11,
  },
  {
    id: "approve", n: 7, route: { kind: "same" }, target: '[data-tour~="inbox-card"][data-proposal-id="{rateProposalId}"] [data-tour~="proposal-approve"]', once: true,
    title: "Approve it",
    body: "Approving runs every check again on the stored arguments, then executes exactly once.",
    action: "click", proxyLabel: "Approve", seconds: 5, hardMs: 8_000,
  },
  {
    id: "rate-live", n: 8, route: { kind: "path", path: "/app/compliance" },
    prepare: [['[data-tour~="compliance-tab"][data-tab="rates"]']],
    target: '[data-tour~="rate-row"][data-jurisdiction="CA"][data-code="sui"][data-current="true"][data-source^="notice:"]',
    fallbacks: ['[data-tour~="rate-row"][data-jurisdiction="CA"][data-code="sui"][data-current="true"]'],
    secondary: ['[data-tour~="compliance-tab"][data-tab="calendar"]'],
    // The other states' rows of the same table: the card goes below the table, not over the NY and TX rates.
    avoid: ['[data-tour~="rate-row"]'],
    reveal: '[data-tour~="rate-source"]',
    title: "The new rate is live",
    body: "California SUI now reads 1.5% from January 1, sourced to the notice. The Calendar tab tracks every deposit and filing due.",
    action: "next", seconds: 8,
  },
  {
    id: "audit", n: 9, route: { kind: "path", path: "/app/audit" }, target: '[data-tour~="audit-chain"]',
    secondary: ['[data-tour~="audit-undo"][data-seq="{rateSeq}"]'],
    // The newest rows: the rate change and the row Try Undo acts on.
    avoid: ['[data-tour~="audit-row"][data-seq="{rateSeq}"]', '[data-tour~="audit-row"]:nth-child(-n+2)'],
    title: "Every change, on the record",
    body: "Each row is hash-chained to the one before, and the chain verifies end to end. Undo appends a reversing row; the original stays put.",
    action: "next", seconds: 9,
  },
  {
    id: "payroll-flags", n: 10, route: { kind: "draft" }, target: '[data-tour~="payroll-needs-review"]', dock: "side", cardAbove: true,
    prepare: [['[data-tour~="payroll-flag"][data-severity="block"]', '[data-tour~="payroll-flag"]']],
    title: "Checked before it is paid",
    body: "Before each payroll, fixed rules flag anything unusual: a new hire, a pay change, an hours spike, a missing bank account. Open a flag to read why it fired and what the agent made of it.",
    action: "next", seconds: 11,
  },
  {
    id: "ask-chart", n: 11, route: { kind: "same" }, target: '[data-tour~="agent-composer"]', agent: true,
    title: "Ask in plain words",
    body: "The answer comes from the reports tool, not from memory, and arrives as a chart with the table one click away.",
    action: "ask", proxyLabel: "Ask", seconds: 11, softMs: 8_000, hardMs: 15_000,
  },
  {
    id: "person", n: 12, route: { kind: "path", path: `/app/people/${TOUR_PERSON}` },
    prepare: [['[data-tour~="person-tab"][data-tab="pay"]']],
    target: '[data-tour~="person-tabs"]', secondary: ['[data-tour~="person-pay"]'], block: "start",
    title: "One record per person",
    body: "Pay history, benefits, IT accounts, time off and documents sit on one page, each a tab.",
    action: "next", seconds: 6,
  },
  {
    id: "expenses", n: 13, route: { kind: "path", path: "/app/expenses" }, dock: "side",
    prepare: [['[data-tour~="expense-row"][data-band="needs_review"][data-checks="red"]', '[data-tour~="expense-row"][data-band="needs_review"][data-checks="amber"]', '[data-tour~="expense-row"][data-band="needs_review"]']],
    target: '[data-tour~="expense-checks"]',
    title: "Expenses, one claim at a time",
    body: "Every claim is checked against policy as it arrives, so duplicates, missing receipts and over-limit amounts show before anyone decides. Approvals are per item, never in bulk.",
    action: "next", seconds: 9,
  },
  {
    id: "time-off", n: 14, route: { kind: "path", path: "/app/time-off" },
    target: '[data-tour~="time-off-request"][data-checks~="COVERAGE_CONFLICT"]',
    fallbacks: ['[data-tour~="time-off-request"][data-status="pending"]'],
    title: "Time off with context",
    body: "A request runs its checks before it reaches the manager. This one would leave the team short that week and includes the Thanksgiving holiday.",
    action: "next", seconds: 8,
  },
  {
    id: "hiring", n: 15, route: { kind: "path", path: "/app/hiring" }, target: '[data-tour~="hiring-offer"]', fallbacks: ['[data-tour~="hiring-offers"]'],
    title: "From offer to first day",
    body: "Offers go out with a portal invite. Once signed, onboarding becomes the new hire's checklist.",
    action: "next", seconds: 6,
  },
  {
    id: "portal", n: 16, route: { kind: "portal" }, target: '[data-tour~="portal-progress"]', fallbacks: ['[data-tour~="portal-checklist"]'], block: "start",
    avoid: ['[data-tour~="portal-checklist"] ol'],
    title: "What the new hire sees",
    body: "{hireName} signs by typing their name, then works through tax forms, direct deposit, the I-9 and benefits. Each item checks off as it is done.",
    action: "next", seconds: 9,
  },
  {
    id: "memory", n: 17, route: { kind: "path", path: "/app/memory#knowledge%2Fprocedures%2Fstate-sui-rate-notice.md" },
    // The hash opens the procedure on a fresh load; the tree click opens it when the page was already showing another file.
    prepare: [['[data-tour~="memory-tree-file"][data-path="knowledge/procedures/state-sui-rate-notice.md"]']],
    target: '[data-tour~="memory-file"][data-path="knowledge/procedures/state-sui-rate-notice.md"]',
    fallbacks: ['[data-tour~="memory-file"]'],
    secondary: ['[data-tour~="memory-backlinks"]', '[data-tour~="memory-history"]'],
    title: "Memory you can read",
    body: "The agent's memory is Markdown in a git repo: procedures, people, preferences and a timeline. Wiki-links tie files together and every edit is a commit.",
    action: "next", seconds: 8,
  },
  {
    // The gallery is taller than a phone screen: its head and first routine go at the top, the sheet at the bottom.
    id: "routines", n: 18, route: { kind: "path", path: "/app/routines" }, target: '[data-tour~="routine-gallery"]', block: "start", sheet: "bottom",
    title: "Work that runs itself",
    body: "Routines run on a schedule or an event. Cheap checks decide first whether a model is needed.",
    action: "next", seconds: 6,
  },
  {
    // The card's title and badges name which integration is ringed: on a phone they go at the top, the sheet below.
    id: "integrations", n: 19, route: { kind: "path", path: "/app/integrations" }, target: '[data-tour~="integration-card"]', fallbacks: ['[data-tour~="integrations-list"]'], block: "start", sheet: "bottom",
    title: "Plugs into your tools",
    body: "Greenhouse, Workday, Checkr, HireRight and DocuSign run as simulators until you add credentials.",
    action: "next", seconds: 6,
  },
  {
    id: "permissions", n: 20, route: { kind: "path", path: "/app/settings/permissions" }, target: '[data-tour~="permissions-agent-row"]', fallbacks: ['[data-tour~="permissions-matrix"]'],
    avoid: ['[data-tour~="permissions-matrix"]'],
    title: "Who can do what",
    body: "View, Edit and Approve per person. The agent never exceeds the person it acts for, and never approves.",
    action: "next", seconds: 6,
  },
  {
    id: "finish", n: 21, route: { kind: "same" }, target: null,
    title: "Yours to run",
    body: "Ask the agent anything from the panel, or replay the tour. Weft is Apache-2.0 and runs on a laptop.",
    action: "finish", seconds: 8,
  },
];

/** Copy the card swaps in when a step degrades. Every line is plain and at most two sentences. */
export const TOUR_COPY = {
  missing: "This part of the demo data is missing on this world.",
  stillWorking: "Still working",
  noticeSlow: "The agent is taking longer than usual. Nothing changes without an approval, so carry on; its proposals will be in the Inbox.",
  noticeStopped: "The agent stopped before proposing anything, so nothing changed. The next step shows a proposal from the demo data.",
  chartSlow: "No chart this time. Reports has the same figures as a chart and a table.",
  rateNotApproved: "This is where the new rate lands once a person approves it.",
  alreadyDelivered: "Already delivered",
  alreadyDecided: "Already decided",
  leftPage: "You left the tour's page",
  closed: "Tour closed. Start it again from Home or the Viewing as menu.",
  agentWorking: "Agent working...",
  agentWaiting: "Waiting for you in the Inbox",
  agentDone: "Done",
  noPersona: "No new hire with an open checklist on this world, so this stop is skipped.",
  approveYourself: "Autoplay only approves the rate change this tour's own notice produced. Approve this one yourself, or go on.",
} as const;

export const TOUR_RESET_COPY = {
  title: "Reset the demo world?",
  body: "Weft rebuilds Larkspur Robotics (demo) from the demo data and sets the clock back to Mon, Oct 26, 8:30 AM PT. Approvals, agent runs, audit rows and memory added since then are cleared.",
  start: "Reset and start",
  skip: "Continue without resetting",
  cancel: "Cancel",
  running: "Resetting...",
  live: "Rebuilding the world",
  disabled: "Reset is turned off on this server. You can still take the tour on this world.",
} as const;

export const stepIndex = (id: string): number => TOUR_STEPS.findIndex((s) => s.id === id);

/**
 * Whether autoplay may click Approve: only for the proposal this session's own notice run made. A deep link
 * (?tour=approve&autoplay=1), a delivery that timed out, or a stale pending card from an earlier session never
 * qualifies, so those wait for a person.
 */
export function autoApproveAllowed(memo: TourMemo): boolean {
  return !!memo.noticeRunId && !!memo.rateProposalId && memo.rateProposalOwn === true && !memo.approved;
}

/**
 * How long a finished agent result stays on screen under autoplay: the step's remaining seconds, at least `minMs`
 * while the budget has room for it (never below 1.5 s).
 */
export function lingerMs(index: number, elapsedMs: number, dwellMs: number, minMs: number, steps: readonly TourStep[] = TOUR_STEPS): number {
  const room = TOUR_BUDGET_MS - Math.max(0, elapsedMs) - plannedAfterMs(index, steps);
  return Math.max(dwellMs, Math.min(minMs, Math.max(1_500, room)));
}

/** Planned seconds of every step after `index`, in ms. */
export function plannedAfterMs(index: number, steps: readonly TourStep[] = TOUR_STEPS): number {
  return steps.slice(index + 1).reduce((t, s) => t + s.seconds * 1000, 0);
}

/**
 * Budget-aware hard timeout: min(step hard, 180 s - elapsed - planned seconds of the steps left), never below the
 * step's own seconds. So autoplay always finishes under 180 s, even on a slow live model.
 */
export function budgetHardMs(index: number, elapsedMs: number, steps: readonly TourStep[] = TOUR_STEPS): number {
  const s = steps[index];
  if (!s) return 0;
  const hard = s.hardMs ?? s.seconds * 1000;
  const room = TOUR_BUDGET_MS - Math.max(0, elapsedMs) - plannedAfterMs(index, steps);
  return Math.max(s.seconds * 1000, Math.min(hard, room));
}

/** Soft timeout (enables Next), never above the hard one. */
export function budgetSoftMs(index: number, elapsedMs: number, steps: readonly TourStep[] = TOUR_STEPS): number {
  const s = steps[index];
  if (!s) return 0;
  return Math.min(s.softMs ?? s.seconds * 1000, budgetHardMs(index, elapsedMs, steps));
}

/** Fills {placeholders} from the memo; returns null when any placeholder has no value. */
export function fill(template: string, memo: TourMemo): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = (memo as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === "") { missing = true; return ""; }
    return String(v).replace(/"/g, "");
  });
  return missing ? null : out;
}

/** The selectors to try for a step's target, in order, with placeholders filled (empty ones dropped). */
export function targetCandidates(step: TourStep, memo: TourMemo): string[] {
  if (!step.target) return [];
  return [step.target, ...(step.fallbacks ?? [])].map((t) => fill(t, memo)).filter((t): t is string => !!t);
}

/** Body copy for the step, with {hireName} filled. */
export function stepBody(step: TourStep, memo: TourMemo): string {
  return step.body.replace("{hireName}", memo.hireName?.replace(/ \(demo\)$/, "") ?? "The new hire");
}

/** Every data-tour token a step selector names (for the unit test that checks each one exists in the source). */
export function tourTokens(steps: readonly TourStep[] = TOUR_STEPS): string[] {
  const all = steps.flatMap((s) => [s.target ?? "", ...(s.fallbacks ?? []), ...(s.secondary ?? []), ...(s.prepare ?? []).flat()]);
  const out = new Set<string>();
  for (const sel of all) for (const m of sel.matchAll(/\[data-tour~="([^"]+)"\]/g)) out.add(m[1]!);
  return [...out].sort();
}
