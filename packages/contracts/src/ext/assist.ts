// The cursor assistant (research/cursor-assistant.md, phases 1 and 2; additive). A small icon follows the pointer in
// the app; a question asked there (typed, or spoken after a double right-click) goes to the agent as an `assist` run
// with a compact picture of the page: a numbered table of the visible meaningful elements (the screen map), what the
// pointer is on, the records the page already holds, the last few things that happened and the named non-mutating
// intents the page offers. The agent answers by pointing at an element, moving to another page, showing something
// through a typed intent, or a short grounded answer in a popover. Changes stay proposals: no intent, anchor or
// presentation tool can approve, submit, save, delete, send or run anything.
//
// This file is the one manifest the client, the executor (which validates every presentation call) and the agent
// share. Types, constants and pure helpers only.
import { z } from "zod";
import { THREAD_ID_RE } from "./agent-page";

export const ASSIST_RECIPE = "assist" as const;

/**
 * The assist run's reads: CHAT_TOOLS without the run-feed post (never offered to chat), actions.get_run (which left
 * chat in wave 3), and agent.read_artifact and tax.list_registrations, which made room for ui.handoff and ui.steps
 * under the cap of 16. A request that needs more is handed to the full agent, which has them all.
 */
export const ASSIST_READS = [
  "people.search", "people.get", "payroll.list_runs", "payroll.get_run", "tax.get_rates", "notices.list", "notices.get",
  "actions.list", "memory.search", "memory.read",
] as const;
/** The presentation tools: R0, they write nothing, and the executor validates each against this manifest and the request's screen map. */
export const ASSIST_UI_TOOLS = ["ui.point", "ui.navigate", "ui.show", "ui.say", "ui.handoff", "ui.steps"] as const;
export type AssistUiTool = (typeof ASSIST_UI_TOOLS)[number];
/** The run's frozen allowlist: exactly 16, the tool cap. */
export const ASSIST_TOOLS = [...ASSIST_READS, ...ASSIST_UI_TOOLS] as const;
/** At most 4 model steps (the usual run cap still applies); a presentation-only step ends the run. */
export const ASSIST_BUDGET = { steps: 4, usd: 0.1, minutes: 5, toolCallsPerStep: 4 } as const;

// ---- the screen map ------------------------------------------------------------------------------------------

export const SCREEN_ITEM_KINDS = [
  "button", "link", "tab", "row", "card", "section", "heading", "landmark", "nav", "field", "menuitem", "dialog", "chip", "item", "disclosure",
] as const;
export type ScreenItemKind = (typeof SCREEN_ITEM_KINDS)[number];

export const SCREEN_LIMITS = {
  /** Items in one map. */
  items: 80,
  /** Characters of one label. */
  label: 60,
  /** The rendered table: about 1,500 tokens at 4 characters a token. */
  tableChars: 6_000,
  route: 200,
  title: 120,
  intents: 24,
  /** The whole request body (screen map, cursor context, records and trail). */
  bodyBytes: 32_000,
  /** Characters of selected text (untrusted; it taints the run). */
  selection: 280,
  records: { sources: 6, rows: 10, fields: 6, value: 60 },
  trail: 10,
  hoverTrail: 5,
} as const;

/** A row id, a composite paycheck id ("pay_2026_10_30:wrk_0026") or a slug such as rt_pre_payroll. */
export const ENTITY_RE = /^[a-z]{2,5}_[A-Za-z0-9_]{1,40}(?::[a-z]{2,5}_[A-Za-z0-9_]{1,40})?$/;
/** An anchor token: data-tour style, lower case with dashes. */
export const ANCHOR_RE = /^[a-z][a-z0-9-]{1,47}$/;

const entity = z.string().regex(ENTITY_RE).max(84);
const shortText = (n: number) => z.string().max(n);

export const ScreenItem = z.object({
  n: z.number().int().min(1).max(999),
  kind: z.enum(SCREEN_ITEM_KINDS),
  label: shortText(SCREEN_LIMITS.label * 2),
  entity: entity.nullable().optional(),
  entityKind: shortText(24).nullable().optional(),
  /** The element's data-tour token or a manifest anchor, when it has one. */
  anchor: z.string().regex(ANCHOR_RE).nullable().optional(),
  testid: shortText(64).nullable().optional(),
  /** [x, y, width, height] in CSS pixels, rounded. */
  box: z.tuple([z.number().int(), z.number().int(), z.number().int().min(0), z.number().int().min(0)]),
  /** selected, expanded, collapsed, current, disabled. */
  state: shortText(24).nullable().optional(),
  /** The label came from text people typed: it reaches the model wrapped as untrusted and the run is tainted. */
  untrusted: z.boolean().optional(),
  /**
   * The href of the link the element is or sits in (path and query when it stays in the app, else the URL as written).
   * Opening such an element is a navigation, so show allows it only to a route checkRoute accepts.
   */
  href: shortText(SCREEN_LIMITS.route).nullable().optional(),
  /** The element is or sits in [data-assist-mutating]: the page marks it as a control that changes data (itemMutating). */
  mutating: z.boolean().optional(),
});
export type ScreenItem = z.infer<typeof ScreenItem>;

export const ScreenMap = z.object({
  route: shortText(SCREEN_LIMITS.route),
  title: shortText(SCREEN_LIMITS.title),
  tab: shortText(40).nullable(),
  items: z.array(ScreenItem).max(SCREEN_LIMITS.items),
  /** The intents this page registered (ids from ASSIST_INTENTS); unknown ids are dropped. */
  intents: z.array(shortText(48)).max(SCREEN_LIMITS.intents),
  truncated: z.boolean(),
  viewport: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
});
export type ScreenMap = z.infer<typeof ScreenMap>;

/**
 * `untrusted` on a label or a value (here and on records, the trail, focus and the open layer): the text came from
 * what people typed (a merchant, a note, a message). It reaches the model only inside the pack's untrusted block,
 * and apps/api taints the run (assistUntrustedSource in packages/agent). The client sets it; it may also leave such
 * text out.
 */
const untrustedFlag = z.boolean().optional();
export const EntityRef = z.object({ entity, kind: shortText(24), label: shortText(SCREEN_LIMITS.label * 2), n: z.number().int().min(1).max(999).nullable().optional(), untrusted: untrustedFlag });
export type EntityRef = z.infer<typeof EntityRef>;
const NameValue = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/), value: shortText(SCREEN_LIMITS.records.value) });
const RecordField = NameValue.extend({ untrusted: untrustedFlag });

/** What the pointer and the page say about the question: where the person is looking and what is open. */
export const AssistCursor = z.object({
  /** The nearest tagged entity under the pointer when the question started (or where "Ask about this" was clicked). */
  under: EntityRef.nullable(),
  /** The last entities the pointer rested on for at least 300 ms, newest first. */
  trail: z.array(EntityRef).max(SCREEN_LIMITS.hoverTrail),
  /** Selected text: untrusted (it may be text someone else typed), so it taints the run. */
  selection: z.object({ text: shortText(SCREEN_LIMITS.selection), entity: entity.nullable().optional() }).nullable(),
  focused: z.object({ kind: shortText(24), label: shortText(SCREEN_LIMITS.label * 2), n: z.number().int().min(1).max(999).nullable().optional(), untrusted: untrustedFlag }).nullable(),
  layer: z.object({ kind: z.enum(["dialog", "popover", "menu", "drawer"]), label: shortText(SCREEN_LIMITS.label * 2), untrusted: untrustedFlag }).nullable(),
  view: z.object({ tab: shortText(40).nullable(), filters: z.array(NameValue).max(6), selected: entity.nullable() }),
});
export type AssistCursor = z.infer<typeof AssistCursor>;

/** One query the page already holds, summarized: ids and the key fields shown, never free text people typed. */
export const RecordSummary = z.object({
  source: shortText(80),
  count: z.number().int().min(0),
  rows: z.array(z.object({ id: entity, fields: z.array(RecordField).max(SCREEN_LIMITS.records.fields) })).max(SCREEN_LIMITS.records.rows),
});
export type RecordSummary = z.infer<typeof RecordSummary>;

export const TRAIL_KINDS = ["navigate", "open", "close", "toast", "error", "ask", "effect"] as const;
export const TrailEvent = z.object({ kind: z.enum(TRAIL_KINDS), label: shortText(120), route: shortText(SCREEN_LIMITS.route).nullable().optional(), agoS: z.number().int().min(0).max(86_400), untrusted: untrustedFlag });
export type TrailEvent = z.infer<typeof TrailEvent>;

export const AssistInput = z.object({
  screen: ScreenMap,
  cursor: AssistCursor,
  records: z.array(RecordSummary).max(SCREEN_LIMITS.records.sources),
  trail: z.array(TrailEvent).max(SCREEN_LIMITS.trail),
});
export type AssistInput = z.infer<typeof AssistInput>;

/** The empty cursor context, for a question with nothing under the pointer. */
export const EMPTY_CURSOR: AssistCursor = { under: null, trail: [], selection: null, focused: null, layer: null, view: { tab: null, filters: [], selected: null } };

// ---- the nav registry ---------------------------------------------------------------------------------------

/**
 * `hosted`: only on the hosted build. `domain`: the grant the sidebar needs to show the item (nav.ts NavItem.domain); a
 * person whose grants close it does not have it in their sidebar.
 */
export interface AssistNavItem { slug: string; label: string; href: string; words: string[]; hosted?: boolean; domain?: "payroll" | "benefits" | "it" }

/**
 * A lookup table indexed with strings from a request (an anchor token, a route pattern, a query key): no prototype, so
 * "constructor" or "__proto__" finds nothing instead of Object's own members.
 */
function table<T>(o: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, o));
}
/** The places the assistant may open: the sidebar (apps/web nav.ts; apps/web/test/assist-nav.test.ts keeps the two equal) plus Settings. */
export const ASSIST_NAV: readonly AssistNavItem[] = [
  { slug: "home", label: "Home", href: "/app", words: ["home", "dashboard", "start"] },
  { slug: "inbox", label: "Inbox", href: "/app/inbox", words: ["inbox", "approvals", "approve", "pending", "proposals", "decide", "decisions"] },
  { slug: "agent", label: "Agent", href: "/app/agent", words: ["agent", "conversations", "chats", "threads", "background work"] },
  { slug: "payroll", label: "Payroll", href: "/app/payroll", words: ["payroll", "pay runs", "paychecks", "pay run", "payday"], domain: "payroll" },
  { slug: "people", label: "People", href: "/app/people", words: ["people", "employees", "staff", "directory", "workers", "offers"] },
  { slug: "hiring", label: "Hiring", href: "/app/hiring", words: ["hiring", "offer", "candidates", "onboarding", "new hire"] },
  { slug: "offboarding", label: "Offboarding", href: "/app/offboarding", words: ["offboarding", "termination", "terminate", "leaving", "exit"] },
  { slug: "benefits", label: "Benefits", href: "/app/benefits", words: ["benefits", "carrier", "enrollment", "reconciliation", "health plan"], domain: "benefits" },
  { slug: "it", label: "IT", href: "/app/it", words: ["it", "laptops", "devices", "accounts", "provisioning"], domain: "it" },
  { slug: "contractors", label: "Contractors", href: "/app/contractors", words: ["contractors", "contractor", "payouts"], domain: "payroll" },
  { slug: "expenses", label: "Expenses", href: "/app/expenses", words: ["expenses", "expense", "receipts", "reimbursements", "expense claims"] },
  { slug: "time-off", label: "Time Off", href: "/app/time-off", words: ["time off", "vacation", "pto", "leave", "holidays", "balances"] },
  { slug: "compliance", label: "Taxes & Compliance", href: "/app/compliance", words: ["taxes", "tax", "compliance", "rates", "registrations", "filings", "notices", "calendar"] },
  { slug: "reports", label: "Reports", href: "/app/reports", words: ["reports", "report", "metrics", "charts", "headcount"] },
  { slug: "routines", label: "Routines", href: "/app/routines", words: ["routines", "routine", "schedules", "automations"] },
  { slug: "audit", label: "Audit log", href: "/app/audit", words: ["audit", "audit log", "history", "undo", "action log"] },
  { slug: "memory", label: "Memory", href: "/app/memory", words: ["memory", "notes", "procedures", "policies", "wiki"] },
  { slug: "integrations", label: "Integrations", href: "/app/integrations", words: ["integrations", "greenhouse", "workday", "checkr", "docusign"] },
  { slug: "simulators", label: "Simulators", href: "/app/simulators", words: ["simulators", "simulator", "clock", "deliver notice"] },
  { slug: "platform", label: "Platform", href: "/app/platform", words: ["platform", "budget", "neurons"], hosted: true },
  { slug: "models", label: "Model comparison", href: "/app/models", words: ["model comparison", "models"], hosted: true },
  { slug: "settings", label: "Settings", href: "/app/settings", words: ["settings", "preferences", "agent settings"] },
  { slug: "permissions", label: "Permissions", href: "/app/settings/permissions", words: ["permissions", "access", "roles", "who can"] },
];

/** Record pages the assistant may open, by the id they take. */
export const ASSIST_RECORD_ROUTES = [
  { pattern: "/app/people/:id", prefix: "wrk_", label: "Person" },
  { pattern: "/app/payroll/:id", prefix: "pay_", label: "Pay run" },
  { pattern: "/app/runs/:id", prefix: "run_", label: "Agent run" },
  { pattern: "/app/routines/:id", prefix: "rt_", label: "Routine" },
  { pattern: "/app/offboarding/:id", prefix: "ofb_", label: "Offboarding case" },
] as const;

/** A query value's shape: an id of one kind, one of a page's own options, or a calendar month (2026-11). */
export type QueryShape = { kind: "id"; prefix: string; re: RegExp } | { kind: "enum"; values: readonly string[] } | { kind: "month" };
const idShape = (prefix: string, re: RegExp): QueryShape => ({ kind: "id", prefix, re });
const oneOf = (...values: string[]): QueryShape => ({ kind: "enum", values });
/** A month as the Time Off calendar names it (YYYY-MM): Prev and Next step through any month, so it is a shape, not a list. */
export const MONTH_RE = /^20[0-9]{2}-(?:0[1-9]|1[0-2])$/;
const month: QueryShape = { kind: "month" };

/** The tab slugs each page already uses (its Tabs values). */
export const PAGE_TABS = {
  person: ["profile", "pay", "benefits", "it", "onboarding", "documents", "time-off"],
  compliance: ["registrations", "rates", "notices", "calendar", "filings", "handoffs", "training"],
  inbox: ["pending", "suggestions", "decided", "handoffs"],
  timeOff: ["requests", "calendar", "balances", "policies", "holidays"],
  people: ["people", "offers"],
  benefits: ["plans", "reconciliation", "enrollment"],
  agent: ["threads", "background"],
} as const;
/** A person's document library (their Documents tab) lists one status at a time: its own tabs, kept as a filter. */
export const DOCUMENT_TABS = ["signed", "sent", "pending"] as const;
/**
 * The departments the Time Off calendar can show (packages/seed company.ts DEPARTMENTS; apps/api/test/assist.test.ts
 * keeps the two equal). Departments are fixed in Weft's world, so the calendar's filter takes one of these.
 */
export const DEPARTMENT_IDS = ["dpt_engineering", "dpt_hardware", "dpt_operations", "dpt_people", "dpt_finance", "dpt_gtm"] as const;
/** Expense filters: the bands and categories the page offers (wave3.ts ExpenseBand, ExpenseCategory). */
export const EXPENSE_BANDS = ["needs_review", "approved", "paid_out", "declined"] as const;
export const EXPENSE_CATEGORIES = ["travel", "lodging", "meals", "mileage", "equipment", "software", "office", "supplies"] as const;
/** The compliance calendar's kind filter and the training list's filter (w4-calendar.tsx, w4-upload-training.tsx). */
export const CALENDAR_KINDS = ["filing", "deposit", "notice_response", "registration", "training_due", "contractor_form_expiry", "benefits_window_close"] as const;
export const TRAINING_FILTERS = ["open", "overdue", "completed", "all"] as const;

/**
 * The view state each page keeps in its URL (it reads and writes these with replace, so Back still works): which
 * paycheck's drawer is open, which tab, which list filter, which section is expanded. A navigation may carry exactly
 * these keys for its route pattern, each value of its shape; anything else is refused by checkRoute.
 */
export const ASSIST_QUERY_KEYS: Readonly<Record<string, Readonly<Record<string, QueryShape>>>> = table({
  "/app/inbox": table({ proposal: idShape("prp_", /^prp_[0-9]{4,6}$/), tab: oneOf(...PAGE_TABS.inbox) }),
  "/app/agent": table({ thread: idShape("thr_", THREAD_ID_RE), run: idShape("run_", /^run_[0-9]{1,8}$/), tab: oneOf(...PAGE_TABS.agent) }),
  "/app/payroll/:id": table({ paycheck: idShape("wrk_", /^wrk_[0-9]{4}$/), section: oneOf("needs-review", "ready") }),
  "/app/people/:id": table({ tab: oneOf(...PAGE_TABS.person), "filter.documents": oneOf(...DOCUMENT_TABS) }),
  "/app/people": table({ tab: oneOf(...PAGE_TABS.people) }),
  // The calendar's "all" is its first button: the page reads it as no kind filter.
  "/app/compliance": table({ tab: oneOf(...PAGE_TABS.compliance), notice: idShape("ntc_", /^ntc_[0-9]{4}$/), "filter.kind": oneOf(...CALENDAR_KINDS, "all"), "filter.training": oneOf(...TRAINING_FILTERS) }),
  "/app/time-off": table({ tab: oneOf(...PAGE_TABS.timeOff), "filter.dept": oneOf(...DEPARTMENT_IDS), "filter.month": month }),
  "/app/benefits": table({ tab: oneOf(...PAGE_TABS.benefits) }),
  "/app/expenses": table({ expense: idShape("exp_", /^exp_[0-9]{4}$/), "filter.band": oneOf(...EXPENSE_BANDS), "filter.category": oneOf(...EXPENSE_CATEGORIES) }),
});

/**
 * A query key the page reads only beside another key's value: the compliance calendar's kind filter lives on its
 * Calendar tab and the training filter on its Training tab (the other tabs' panels are not mounted), so a link with
 * the filter and not its tab would open Registrations with no filter in sight. So do the Time Off calendar's
 * department and month and a person's document list.
 */
export const ASSIST_QUERY_NEEDS: Readonly<Record<string, Readonly<Record<string, { key: string; value: string }>>>> = table({
  "/app/compliance": table({ "filter.kind": { key: "tab", value: "calendar" }, "filter.training": { key: "tab", value: "training" } }),
  "/app/time-off": table({ "filter.dept": { key: "tab", value: "calendar" }, "filter.month": { key: "tab", value: "calendar" } }),
  "/app/people/:id": table({ "filter.documents": { key: "tab", value: "documents" } }),
});

/** What a query key needs beside it on a page (ASSIST_QUERY_NEEDS), when `has` does not give it; else null. */
export function queryNeedProblem(pattern: string, key: string, has: (k: string) => string | null): string | null {
  const page = Object.hasOwn(ASSIST_QUERY_NEEDS, pattern) ? ASSIST_QUERY_NEEDS[pattern]! : null;
  const need = page && Object.hasOwn(page, key) ? page[key]! : null;
  return need && has(need.key) !== need.value ? `${key} on ${pattern} needs ${need.key}=${need.value}` : null;
}

/** Why a query value does not fit its shape, or null. */
export function queryProblem(shape: QueryShape, v: string): string | null {
  if (shape.kind === "id") return shape.re.test(v) ? null : `an id that starts with ${shape.prefix}`;
  if (shape.kind === "month") return MONTH_RE.test(v) ? null : "a month as YYYY-MM";
  return shape.values.includes(v) ? null : `one of ${shape.values.join(", ")}`;
}

/** A route split at its first "?" (a second "?" stays in the query, where the shape checks refuse it). */
export function splitRoute(route: string): { path: string; query: string | undefined } {
  const i = route.indexOf("?");
  return i < 0 ? { path: route, query: undefined } : { path: route.slice(0, i), query: route.slice(i + 1) };
}

/** "/app/payroll/pay_2026_10_30/" reads "/app/payroll/pay_2026_10_30"; the query is kept. */
export function normalizeRoute(route: string): string {
  const { path, query } = splitRoute(route);
  const p = path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
  return query !== undefined ? `${p}?${query}` : p;
}

/** The record page a path opens and its id ("/app/people/wrk_0016": Person wrk_0016), or null. */
function recordOf(path: string): { pattern: string; id: string } | null {
  for (const r of ASSIST_RECORD_ROUTES) {
    const base = r.pattern.slice(0, -"/:id".length);
    const m = new RegExp(`^${base.replace(/[/]/g, "\\/")}\\/([A-Za-z0-9_]{3,48})$`).exec(path);
    // The id is a whole id of the page's kind: a bare prefix ("wrk_") is not one.
    if (m && m[1]!.startsWith(r.prefix) && m[1]!.length > r.prefix.length && ENTITY_RE.test(m[1]!)) return { pattern: r.pattern, id: m[1]! };
  }
  return null;
}

/** The manifest pattern a path belongs to ("/app/payroll/:id"), or the nav href itself, or null. */
export function routePattern(path: string, opts: { hosted?: boolean } = {}): string | null {
  const p = splitRoute(normalizeRoute(path)).path;
  if (ASSIST_NAV.some((n) => n.href === p && (!n.hosted || opts.hosted))) return p;
  return recordOf(p)?.pattern ?? null;
}

/**
 * Whether a navigation target is a place in the nav registry: a sidebar page, Settings, or a record page with an id of
 * its kind, with only the query keys ASSIST_QUERY_KEYS lists for that page, each value of its shape. Returns the
 * normalized route and the record ids it names (the page's own id and any id-valued query key), which the executor
 * looks up like any other id argument, or a reason.
 */
export function checkRoute(route: string, opts: { hosted?: boolean } = {}): { ok: true; route: string; pattern: string; ids: string[] } | { ok: false; reason: string } {
  if (typeof route !== "string" || route.length > SCREEN_LIMITS.route) return { ok: false, reason: "route is a path of at most 200 characters" };
  const r = normalizeRoute(route.trim());
  if (!r.startsWith("/app")) return { ok: false, reason: `${r} is not a page of the app; routes start with /app` };
  if (r.includes("#")) return { ok: false, reason: `${r} carries a fragment; a route is a path and its query only` };
  const { path, query } = splitRoute(r);
  const pattern = routePattern(path, opts);
  if (!pattern) return { ok: false, reason: `${path} is not in the nav registry` };
  const ids: string[] = [];
  const rec = recordOf(path);
  if (rec) ids.push(rec.id);
  if (query !== undefined) {
    if (query.includes("?")) return { ok: false, reason: `${r} has more than one query` };
    const allowed = ASSIST_QUERY_KEYS[pattern] ?? table({});
    const seen = new Set<string>();
    for (const [k, v] of new URLSearchParams(query)) {
      const shape = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
      if (!shape) return { ok: false, reason: `${pattern} keeps no ${k} in its link` };
      if (seen.has(k)) return { ok: false, reason: `${k} is given twice` };
      seen.add(k);
      const bad = queryProblem(shape, v);
      if (bad) return { ok: false, reason: `${k} on ${pattern} is ${bad}` };
      if (shape.kind === "id") ids.push(v);
    }
    const params = new URLSearchParams(query);
    for (const k of seen) {
      const need = queryNeedProblem(pattern, k, (x) => params.get(x));
      if (need) return { ok: false, reason: need };
    }
  }
  return { ok: true, route: r, pattern, ids };
}

/** A person's record tabs that only some grants open (people-view.tsx renders Benefits and IT only with view on them). */
export const PERSON_TAB_DOMAIN: Readonly<Record<string, NonNullable<AssistNavItem["domain"]>>> = table({ benefits: "benefits", it: "it" });

/**
 * The grants a route needs before it can be opened (beyond its record ids, which the executor looks up in their own
 * domains): its sidebar section's (ASSIST_NAV domain; a record page belongs to the section its path sits under,
 * /app/payroll/:id to Payroll) and, for a person's record, the domain of the tab its link selects. A person whose
 * grants close one does not have that page in their sidebar.
 */
export function routeDomains(route: string, opts: { hosted?: boolean } = {}): NonNullable<AssistNavItem["domain"]>[] {
  const { path, query } = splitRoute(normalizeRoute(route));
  const pattern = routePattern(path, opts);
  if (!pattern) return [];
  const out = new Set<NonNullable<AssistNavItem["domain"]>>();
  const section = patternDomain(pattern);
  if (section) out.add(section);
  if (pattern === "/app/people/:id") {
    const tab = new URLSearchParams(query ?? "").get("tab");
    if (tab && Object.hasOwn(PERSON_TAB_DOMAIN, tab)) out.add(PERSON_TAB_DOMAIN[tab]!);
  }
  return [...out];
}

/** The grant a manifest pattern's sidebar section needs ("/app/payroll/:id" sits under Payroll: payroll), or null. */
export function patternDomain(pattern: string): NonNullable<AssistNavItem["domain"]> | null {
  const base = pattern.endsWith("/:id") ? pattern.slice(0, -"/:id".length) : pattern;
  const nav = ASSIST_NAV.filter((n) => n.href !== "/app" && (base === n.href || base.startsWith(`${n.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
  return nav?.domain ?? null;
}

/** The sidebar page a path sits under ("/app/people/wrk_x" reads "/app/people"), or "/app". */
function nearPage(path: string, opts: { hosted?: boolean }): string {
  const near = ASSIST_NAV.filter((n) => n.href !== "/app" && path.startsWith(`${n.href}/`) && (!n.hosted || opts.hosted)).sort((a, b) => b.href.length - a.href.length)[0];
  return near?.href ?? "/app";
}

/**
 * What the trail calls a page: its sidebar label, a record page by its kind and id ("Pay run pay_2026_10_30"), or else
 * the sidebar page the path sits under. Nothing of a path outside those shapes (a sender's words) is in the name. The
 * client names its navigations with it (trail-core.ts) and the server names them again from the cleaned route.
 */
export function assistPageName(route: string, opts: { hosted?: boolean } = {}): string {
  const path = splitRoute(normalizeRoute(String(route ?? "").trim())).path;
  const nav = ASSIST_NAV.find((n) => n.href === path && (!n.hosted || opts.hosted));
  if (nav) return nav.label;
  const rec = recordOf(path);
  if (rec) return `${ASSIST_RECORD_ROUTES.find((r) => r.pattern === rec.pattern)!.label} ${rec.id}`;
  const near = nearPage(path, opts);
  return ASSIST_NAV.find((n) => n.href === near)?.label ?? "Home";
}

/**
 * A page location from the browser as the assistant may pass it on (the screen map's route, a trail event's route):
 * the path when it is a registry page and only the query keys that page keeps with values of their shape. Anything
 * else (an unknown key, a value of no shape, a path outside the registry) is dropped, so text in a link someone sent
 * never reaches the model as the page's own words. A path outside the registry reads as the nearest sidebar page.
 */
export function cleanRoute(route: string, opts: { hosted?: boolean } = {}): string {
  const { path: raw, query } = splitRoute(normalizeRoute(String(route ?? "").trim()));
  const pattern = routePattern(raw, opts);
  if (!pattern) return nearPage(raw, opts);
  const allowed = ASSIST_QUERY_KEYS[pattern] ?? table({});
  const kept = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(query ?? "")) {
    const shape = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
    if (shape && !kept.has(k) && !queryProblem(shape, v)) kept.set(k, v);
  }
  for (const k of [...kept.keys()]) if (queryNeedProblem(pattern, k, (x) => kept.get(x))) kept.delete(k);
  const q = kept.toString();
  return q ? `${raw}?${q}` : raw;
}

/**
 * The view state of a request (the cursor's tab, filters and selected record) as the page keeps it in its URL: a tab,
 * filter or record id that is not one of the route's own shapes is dropped (ASSIST_QUERY_KEYS), like cleanRoute.
 */
export function cleanView(view: AssistCursor["view"], route: string, opts: { hosted?: boolean } = {}): AssistCursor["view"] {
  const pattern = routePattern(splitRoute(route).path, opts);
  const allowed = (pattern && ASSIST_QUERY_KEYS[pattern]) || table({});
  const fits = (key: string, v: string | null | undefined) => !!v && Object.hasOwn(allowed, key) && !queryProblem(allowed[key]!, v);
  const tab = fits("tab", view.tab) ? view.tab : null;
  const filters = view.filters.filter((f) => fits(`filter.${f.name}`, f.value) && !(pattern && queryNeedProblem(pattern, `filter.${f.name}`, (k) => (k === "tab" ? tab : null))));
  // The selected record: a run's paycheck ("pay_...:wrk_...") or an id one of the page's id keys holds.
  const ids = Object.values(allowed).filter((s): s is Extract<QueryShape, { kind: "id" }> => s.kind === "id");
  const sel = view.selected;
  const one = sel?.includes(":") ? sel.split(":").pop()! : sel;
  const selected = sel && one && ids.some((s) => s.re.test(one)) ? sel : null;
  return { tab, filters, selected };
}

/** Alerts and status lines the page shows: a page that could not load what its link names may repeat the link's text. */
const echoesLink = (t: TrailEvent) => t.kind === "error" || t.kind === "toast";
/** Marks the trail's alerts and status lines untrusted (they taint the run and reach the model only wrapped). */
const alertsUntrusted = (trail: TrailEvent[]): TrailEvent[] => trail.map((t) => (echoesLink(t) && !t.untrusted ? { ...t, untrusted: true } : t));

/**
 * The request as the server keeps it: routes and view state cleaned (cleanRoute, cleanView), and a navigation in the
 * trail named again from its cleaned route (assistPageName), so its label never holds more than the route keeps; the
 * rest unchanged. When cleaning took text out of a path (the screen's or a trail event's: one outside the registry), the
 * page's alerts and status lines are marked untrusted, since a "No worker ..." alert repeats that text.
 */
export function cleanAssistInput(a: AssistInput, opts: { hosted?: boolean } = {}): AssistInput {
  const route = cleanRoute(a.screen.route, opts);
  const pathOf = (r: string) => splitRoute(normalizeRoute(String(r ?? "").trim())).path;
  const lost = (raw: string, clean: string) => splitRoute(clean).path !== pathOf(raw);
  let dropped = lost(a.screen.route, route);
  const trail = a.trail.map((t) => {
    if (!t.route) return t;
    const r = cleanRoute(t.route, opts);
    if (lost(t.route, r)) dropped = true;
    return t.kind === "navigate" ? { ...t, route: r, label: `Opened ${assistPageName(r, opts)}` } : { ...t, route: r };
  });
  return {
    ...a,
    screen: { ...a.screen, route },
    cursor: { ...a.cursor, view: cleanView(a.cursor.view, route, opts) },
    trail: dropped ? alertsUntrusted(trail) : trail,
  };
}

/**
 * Ids whose shape alone lets text through (a record page's path id, up to 40 letters, digits and _ after its prefix,
 * and a conversation thread, which takes - too): a link someone sent may spell words with them. Every other id a
 * route keeps is digits only (ASSIST_QUERY_KEYS), so it carries no words.
 */
export const ASSIST_LOOKED_UP = ["wrk_", "pay_", "run_", "rt_", "ofb_", "thr_"] as const;
const lookedUp = (v: string) => ASSIST_LOOKED_UP.some((p) => v.startsWith(p));
/** The looked-up ids a trail label spells ("Opened conversation thr_...", an alert's "No worker wrk_..."). */
const LABEL_ID_RE = new RegExp(`\\b(?:${ASSIST_LOOKED_UP.join("|")})[A-Za-z0-9_-]*`, "g");
const labelIds = (label: string): string[] => label.match(LABEL_ID_RE) ?? [];

/** The ids of a cleaned request that apps/api looks up before the pack is built (assistKnownRecords). */
export function assistRecordIds(a: AssistInput, opts: { hosted?: boolean } = {}): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => { if (v && lookedUp(v)) out.add(v); };
  for (const r of [a.screen.route, ...a.trail.map((t) => t.route)]) {
    if (!r) continue;
    const c = checkRoute(r, opts);
    if (c.ok) c.ids.forEach(add);
  }
  for (const part of a.cursor.view.selected?.split(":") ?? []) add(part);
  for (const t of a.trail) labelIds(t.label).forEach(add);
  return [...out];
}

/**
 * The request with every looked-up id (ASSIST_LOOKED_UP) that does not exist for this company taken out: a record page
 * reads as its sidebar page, a thread key is dropped, and so is a selected record that names one, so a sender's words
 * spelled as an id never reach the model, the handoff or the executor's checks as the page's own. A trail label that
 * spells one goes too: a record opened or closed through the link is left out of the trail, and any other event (an
 * alert that repeats the id) is marked untrusted; a navigation is named again from its route (cleanAssistInput). A
 * record page that reads as its sidebar page marks every alert and status line untrusted, as cleanAssistInput does.
 * `known` answers for the ids assistRecordIds listed; the request is cleaned again after (cleanAssistInput).
 */
export function assistKnownRecords(a: AssistInput, known: (id: string) => boolean, opts: { hosted?: boolean } = {}): AssistInput {
  const ok = (v: string) => !lookedUp(v) || known(v);
  let dropped = false;
  const reduce = (route: string): string => {
    const { path, query } = splitRoute(route);
    const rec = recordOf(path);
    if (rec && !ok(rec.id)) dropped = true;
    const p = rec && !ok(rec.id) ? nearPage(path, opts) : path;
    const params = new URLSearchParams(query ?? "");
    for (const [k, v] of [...params]) if (!ok(v)) params.delete(k);
    const q = params.toString();
    return q ? `${p}?${q}` : p;
  };
  const selected = a.cursor.view.selected;
  const screenRoute = reduce(a.screen.route);
  const trail = a.trail.flatMap((t) => {
    const e = t.route ? { ...t, route: reduce(t.route) } : t;
    // A question the person asked earlier is their own words, whatever ids it spells.
    if ((e.kind === "navigate" && e.route) || e.kind === "ask") return [e];
    if (labelIds(e.label).every(ok)) return [e];
    return e.kind === "open" || e.kind === "close" ? [] : [{ ...e, untrusted: true }];
  });
  const next: AssistInput = {
    ...a,
    screen: { ...a.screen, route: screenRoute },
    cursor: { ...a.cursor, view: { ...a.cursor.view, selected: selected && selected.split(":").every(ok) ? selected : null } },
    trail: dropped ? alertsUntrusted(trail) : trail,
  };
  return cleanAssistInput(next, opts);
}

// ---- anchors ------------------------------------------------------------------------------------------------

export interface AssistAnchor {
  label: string;
  /** Route patterns (routePattern) where it lives; "*" for the app shell. */
  routes: string[];
  /** Tried in order on the client (the tour's selectors where it has them). */
  selectors: string[];
  /** A control that changes data: it may be pointed at, never activated (ui.show refuses it). */
  mutating?: boolean;
  /**
   * Intent params its selectors name as {param} (the tour's templating): such an anchor is reached only through an
   * intent that carries them (inbox.open, approval.card), never named on its own as #token.
   */
  params?: readonly string[];
  /** A sidebar item shown only on the hosted build (ASSIST_NAV hosted): unknown on the Node app. */
  hosted?: boolean;
  /** A sidebar item a person sees only with view on this domain (ASSIST_NAV domain); the executor checks the grant. */
  domain?: AssistNavItem["domain"];
}

/** Known anchors by token: what ui.point and ui.navigate may name on a page the screen map does not show yet. */
export const ASSIST_ANCHORS: Readonly<Record<string, AssistAnchor>> = table({
  "env-pill": { label: "Clock and Viewing as", routes: ["*"], selectors: ['[data-tour~="env-pill"]'] },
  "agent-composer": { label: "Ask the agent", routes: ["*"], selectors: ['[data-tour~="agent-composer"]'] },
  "inbox-approvals": { label: "Approvals", routes: ["/app/inbox"], selectors: ['[data-tour~="inbox-card"][data-status="pending"]'] },
  "inbox-time-off": { label: "Time-off request", routes: ["/app/inbox"], selectors: ['[data-tour~="inbox-card"][data-command="time_off.decide"][data-status="pending"]'] },
  "inbox-time-off-approve": {
    label: "Approve", routes: ["/app/inbox"], mutating: true,
    selectors: ['[data-tour~="inbox-card"][data-command="time_off.decide"][data-status="pending"] [data-tour~="proposal-approve"]'],
  },
  "inbox-proposal": { label: "The proposal", routes: ["/app/inbox"], params: ["proposalId"], selectors: ['[data-tour~="inbox-card"][data-proposal-id="{proposalId}"]'] },
  "inbox-rate-change": { label: "Rate change", routes: ["/app/inbox"], selectors: ['[data-tour~="inbox-card"][data-command="tax.update_rate"][data-status="pending"]'] },
  "payroll-needs-review": { label: "Needs review", routes: ["/app/payroll/:id"], selectors: ['[data-tour~="payroll-needs-review"]'] },
  "payroll-flag": { label: "Flag", routes: ["/app/payroll/:id"], selectors: ['[data-tour~="payroll-flag"][data-severity="block"]', '[data-tour~="payroll-flag"]'] },
  "payroll-submit": { label: "Submit", routes: ["/app/payroll/:id"], selectors: ['[data-testid="payroll-submit"]'], mutating: true },
  "paycheck-drawer": { label: "Paycheck", routes: ["/app/payroll/:id"], selectors: ['[data-testid="paycheck-drawer"]'] },
  "expense-drawer": { label: "Expense", routes: ["/app/expenses"], selectors: ['[data-testid="expense-drawer"]'] },
  "payroll-runs": { label: "Pay runs", routes: ["/app/payroll"], selectors: ['[data-entity-kind="pay_run"]', "main table"] },
  "person-tabs": { label: "Record tabs", routes: ["/app/people/:id"], selectors: ['[data-tour~="person-tabs"]'] },
  "people-list": { label: "People", routes: ["/app/people"], selectors: ['[data-entity-kind="worker"]', "main table"] },
  "time-off-requests": { label: "Time-off requests", routes: ["/app/time-off"], selectors: ['[data-tour~="time-off-request"][data-status="pending"]', '[data-tour~="time-off-request"]'] },
  "expense-checks": { label: "Policy checks", routes: ["/app/expenses"], selectors: ['[data-tour~="expense-checks"]', '[data-tour~="expense-row"]'] },
  "compliance-rates": { label: "Rates", routes: ["/app/compliance"], selectors: ['[data-tour~="compliance-tab"][data-tab="rates"]'] },
  "compliance-calendar": { label: "Calendar", routes: ["/app/compliance"], selectors: ['[data-tour~="compliance-tab"][data-tab="calendar"]'] },
  "audit-chain": { label: "Audit chain", routes: ["/app/audit"], selectors: ['[data-tour~="audit-chain"]'] },
  "routine-gallery": { label: "Routines", routes: ["/app/routines"], selectors: ['[data-tour~="routine-gallery"]'] },
  "memory-file": { label: "Memory file", routes: ["/app/memory"], selectors: ['[data-tour~="memory-file"]'] },
  "hiring-offers": { label: "Offers", routes: ["/app/hiring"], selectors: ['[data-tour~="hiring-offers"]'] },
  "permissions-matrix": { label: "Permissions", routes: ["/app/settings/permissions"], selectors: ['[data-tour~="permissions-matrix"]'] },
  "sim-deliver": { label: "Deliver notice", routes: ["/app/simulators"], selectors: ['[data-tour~="sim-deliver"]'], mutating: true },
  "agent-conversations": { label: "Conversations", routes: ["/app/agent"], selectors: ['[data-testid="agent-page-list"]'] },
  "agent-background": { label: "Background work", routes: ["/app/agent"], selectors: ['[data-testid="agent-page-tab-background"]'] },
  "benefits-tabs": { label: "Benefits tabs", routes: ["/app/benefits"], selectors: ['main [role="tablist"]'] },
  "benefits-reconciliation": { label: "Reconciliation", routes: ["/app/benefits"], selectors: ['[data-testid="benefits-tab-reconciliation"]'] },
  "time-off-calendar": { label: "Team calendar", routes: ["/app/time-off"], selectors: ['[data-testid="time-off-calendar"]'] },
  ...Object.fromEntries(ASSIST_NAV.filter((n) => n.slug !== "permissions").map((n): [string, AssistAnchor] => [`nav-${n.slug}`, {
    label: n.label, routes: ["*"], selectors: [`[data-testid="nav-${n.slug}"]`], ...(n.hosted ? { hosted: true } : {}), ...(n.domain ? { domain: n.domain } : {}),
  }])),
});

/**
 * Whether `anchor` is known on the page `route` (a path or a pattern). An anchor that needs intent params is left out
 * unless `withParams` (the intent that fills them asks), and a hosted-only sidebar item unless `hosted`.
 */
export function anchorOn(anchor: string, route: string, opts: { hosted?: boolean; withParams?: boolean } = {}): AssistAnchor | null {
  const a = ASSIST_ANCHORS[anchor];
  if (!a || (a.params?.length && !opts.withParams) || (a.hosted && !opts.hosted)) return null;
  if (a.routes.includes("*")) return a;
  const pattern = route.includes(":") ? route : routePattern(route, opts);
  return pattern && a.routes.includes(pattern) ? a : null;
}

/** An anchor's selectors with its {param} slots filled from an intent's params; a selector with a slot left empty is dropped. */
export function fillSelectors(selectors: readonly string[], params: Readonly<Record<string, string>>): string[] {
  return selectors.flatMap((sel) => {
    let missing = false;
    const out = sel.replace(/\{(\w+)\}/g, (_m, k: string) => {
      const v = params[k];
      if (!v || !ENTITY_RE.test(v)) { missing = true; return ""; }
      return v;
    });
    return missing ? [] : [out];
  });
}

// ---- intents ------------------------------------------------------------------------------------------------

/** An id param takes a whole id of its prefix (ENTITY_RE), or of its own shape when it has one (a thread id may hold "-"). */
export type IntentParam = { kind: "id"; prefix: string; re?: RegExp } | { kind: "enum"; values: readonly string[] } | { kind: "slug" } | { kind: "anchor" } | { kind: "text"; max: number };
export interface AssistIntentDef {
  id: string;
  title: string;
  /** What the model reads in the screen map's intents line. */
  hint: string;
  params: Readonly<Record<string, IntentParam>>;
  /** Optional params (the rest are required). */
  optional?: readonly string[];
  /** global: callable from any page (it opens its page first); page: only when the page offers it in its screen map. */
  scope: "global" | "page";
  /** For a global intent, the route it opens (params filled in). */
  route?: string;
  /** The anchor the client rings once the intent ran. */
  anchor?: string;
}

/**
 * Every intent there is. Each one moves the view (a route with query params, or page state such as a tab or a
 * drawer) and none writes data: there is no approve, submit, save, delete, send or run intent to call, so a request
 * for one is refused by the executor as an unknown intent.
 */
export const ASSIST_INTENTS: readonly AssistIntentDef[] = [
  { id: "people.open", title: "Open a person's record", hint: "people.open(workerId)", params: { workerId: { kind: "id", prefix: "wrk_" } }, scope: "global", route: "/app/people/{workerId}" },
  { id: "people.openTab", title: "Open a tab of a person's record", hint: `people.openTab(workerId, tab: ${PAGE_TABS.person.join("|")})`, params: { workerId: { kind: "id", prefix: "wrk_" }, tab: { kind: "enum", values: PAGE_TABS.person } }, scope: "global", route: "/app/people/{workerId}?tab={tab}", anchor: "person-tabs" },
  { id: "payroll.open", title: "Open a payroll", hint: "payroll.open(payrollId)", params: { payrollId: { kind: "id", prefix: "pay_" } }, scope: "global", route: "/app/payroll/{payrollId}" },
  { id: "payroll.showNeedsReview", title: "Show the paychecks that need review", hint: "payroll.showNeedsReview(payrollId)", params: { payrollId: { kind: "id", prefix: "pay_" } }, scope: "global", route: "/app/payroll/{payrollId}?section=needs-review", anchor: "payroll-needs-review" },
  { id: "payroll.openPaycheck", title: "Open a paycheck", hint: "payroll.openPaycheck(payrollId, workerId)", params: { payrollId: { kind: "id", prefix: "pay_" }, workerId: { kind: "id", prefix: "wrk_" } }, scope: "global", route: "/app/payroll/{payrollId}?paycheck={workerId}", anchor: "paycheck-drawer" },
  { id: "expenses.open", title: "Open an expense claim", hint: "expenses.open(expenseId)", params: { expenseId: { kind: "id", prefix: "exp_" } }, scope: "global", route: "/app/expenses?expense={expenseId}", anchor: "expense-drawer" },
  { id: "compliance.openTab", title: "Open a tab of Taxes and Compliance", hint: `compliance.openTab(tab: ${PAGE_TABS.compliance.join("|")})`, params: { tab: { kind: "enum", values: PAGE_TABS.compliance } }, scope: "global", route: "/app/compliance?tab={tab}" },
  { id: "inbox.open", title: "Open a proposal in the Inbox", hint: "inbox.open(proposalId)", params: { proposalId: { kind: "id", prefix: "prp_" } }, scope: "global", route: "/app/inbox?proposal={proposalId}", anchor: "inbox-proposal" },
  // The popover shows the proposal's approval card (the trace's cards) and the Inbox card is ringed; the person decides.
  { id: "approval.card", title: "Show a proposal's approval card", hint: "approval.card(proposalId)", params: { proposalId: { kind: "id", prefix: "prp_" } }, scope: "global", route: "/app/inbox?proposal={proposalId}", anchor: "inbox-proposal" },
  { id: "agent.open", title: "Open a conversation on the Agent page", hint: "agent.open(threadId)", params: { threadId: { kind: "id", prefix: "thr_", re: THREAD_ID_RE } }, scope: "global", route: "/app/agent?thread={threadId}" },
  { id: "agentPage.tab", title: "Open a list on the Agent page", hint: `agentPage.tab(tab: ${PAGE_TABS.agent.join("|")})`, params: { tab: { kind: "enum", values: PAGE_TABS.agent } }, scope: "global", route: "/app/agent?tab={tab}", anchor: "agent-conversations" },
  { id: "benefits.openTab", title: "Open a tab of Benefits", hint: `benefits.openTab(tab: ${PAGE_TABS.benefits.join("|")})`, params: { tab: { kind: "enum", values: PAGE_TABS.benefits } }, scope: "global", route: "/app/benefits?tab={tab}", anchor: "benefits-tabs" },
  { id: "timeOff.calendar", title: "Open a department's time-off calendar", hint: `timeOff.calendar(dept: ${DEPARTMENT_IDS.join("|")})`, params: { dept: { kind: "enum", values: DEPARTMENT_IDS } }, scope: "global", route: "/app/time-off?tab=calendar&filter.dept={dept}", anchor: "time-off-calendar" },
  { id: "tab.select", title: "Switch to a tab", hint: "tab.select(tab)", params: { tab: { kind: "slug" } }, scope: "page" },
  { id: "section.expand", title: "Expand a section", hint: "section.expand(id)", params: { id: { kind: "slug" } }, scope: "page" },
  { id: "section.collapse", title: "Collapse a section", hint: "section.collapse(id)", params: { id: { kind: "slug" } }, scope: "page" },
  { id: "list.filter", title: "Filter a list", hint: "list.filter(name, value)", params: { name: { kind: "slug" }, value: { kind: "text", max: 40 } }, scope: "page" },
  { id: "scroll.to", title: "Scroll to a part of the page", hint: "scroll.to(anchor)", params: { anchor: { kind: "anchor" } }, scope: "page" },
];
export const ASSIST_INTENT_IDS = new Set(ASSIST_INTENTS.map((i) => i.id));
export const intentDef = (id: string): AssistIntentDef | undefined => ASSIST_INTENTS.find((i) => i.id === id);

/**
 * Verbs of controls that change data. A test pins that no intent id holds one, so the model is never offered such an
 * intent; the show fallback refuses any element whose label, test id or anchor holds one. Imperatives only: a row
 * that reads "Approved" or "Sent" is a status, not a control. "Pay" is left out on purpose: it names the Pay and tax
 * tab, pay runs and paychecks, and the control that pays (Submit, Run payroll, Pay contractors) is a button, which
 * show never presses. So are "review", "file", "record" and "test", which name tabs, sections and records ("Needs
 * review", "Memory file"); the buttons that hold them (Review with agent, Record completion, Test connection) are
 * refused by their kind. This list is the second guard, never the only one.
 */
export const MUTATING_WORDS = [
  "approve", "deny", "reject", "decline", "submit", "save", "delete", "remove", "send", "run", "rerun", "process", "confirm", "accept",
  "sign", "upload", "undo", "revert", "rollback", "dismiss", "cancel", "reset", "terminate", "archive", "enroll", "connect", "disconnect", "sync",
  "advance", "deliver", "propose", "publish", "create", "add", "enable", "disable", "grant", "revoke", "import", "generate", "invite", "resend",
  "retry", "assign", "trigger", "decide", "execute", "release", "transfer", "refund", "reimburse", "void", "apply",
  "complete", "resolve", "start", "prepare", "order", "schedule", "remind", "nudge", "reconcile", "dispute", "skip",
] as const;
const MUTATING_RE = new RegExp(`(?:^|[^a-z])(${MUTATING_WORDS.join("|")})(?![a-z])`, "i");
/** True when a label, test id or token reads as a control that changes data ("Approve", "payroll-submit", "Run review now"). */
export function readsMutating(text: string | null | undefined): boolean {
  if (!text) return false;
  return MUTATING_RE.test(text.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
}
/** Test ids of controls that change data, matched as substrings of data-testid (the denylist behind readsMutating). */
export const MUTATING_TESTIDS = [
  "approve", "deny", "submit", "save", "delete", "send", "run-now", "run-review", "decide", "confirm", "reset", "deliver", "advance", "accept",
  "sign", "upload", "undo", "fault", "enable", "disable", "terminate", "connect", "sync", "routine-try", "dismiss", "new-draft", "preview",
  "autonomy", "setting-", "trigger", "propose", "draft-input", "composer", "dictate",
  "filing-file", "filing-prepare", "screening-step", "payouts-schedule", "enrollment-nudge", "recon-run", "recon-dispute", "off-cycle", "step-skip",
  "test-connection", "review-with",
] as const;
export function testidMutating(testid: string | null | undefined): boolean {
  if (!testid) return false;
  const t = testid.toLowerCase();
  return MUTATING_TESTIDS.some((m) => t.includes(m));
}

/** Validates an intent call: known id, offered on this page when it is page-scoped, and every param of its kind. */
export function checkIntent(id: string, params: readonly { name: string; value: string }[] | undefined, offered: readonly string[]):
  { ok: true; def: AssistIntentDef; params: Record<string, string>; route: string | null } | { ok: false; code: "UNKNOWN_INTENT" | "NOT_OFFERED" | "INVALID_PARAMS"; reason: string } {
  const def = intentDef(id);
  if (!def) {
    return { ok: false, code: "UNKNOWN_INTENT", reason: readsMutating(id)
      ? `There is no ${id} intent: intents only move the view, and changes are approved by a person in the Inbox`
      : `There is no ${id} intent; use one the screen map lists` };
  }
  if (def.scope === "page" && !offered.includes(def.id)) return { ok: false, code: "NOT_OFFERED", reason: `${id} is not offered on this page; the screen map lists the page's intents` };
  const got: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const p of params ?? []) {
    if (!Object.hasOwn(def.params, p.name)) return { ok: false, code: "INVALID_PARAMS", reason: `${id} takes ${Object.keys(def.params).join(", ")}, not ${p.name}` };
    if (Object.hasOwn(got, p.name)) return { ok: false, code: "INVALID_PARAMS", reason: `${id} got ${p.name} twice` };
    const raw = String(p.value ?? "");
    const k = def.params[p.name]!.kind;
    // An id, an option or a token is taken exactly as given: a padded " wrk_9999" is not one, so the value the
    // pipeline's reference check scanned is the value that reaches the route.
    if (k !== "text" && raw !== raw.trim()) return { ok: false, code: "INVALID_PARAMS", reason: `${id} ${p.name}: ${JSON.stringify(raw.slice(0, 40))} has spaces around it` };
    got[p.name] = raw.trim();
    // A free param (a slug or text) never carries a verb that changes data ("approve", "submit").
    if ((k === "slug" || k === "text") && readsMutating(got[p.name])) return { ok: false, code: "INVALID_PARAMS", reason: `${id} ${p.name}: ${got[p.name]} reads as a change; intents only move the view` };
  }
  for (const [name, kind] of Object.entries(def.params)) {
    const v = got[name];
    if (v === undefined || v === "") {
      if (def.optional?.includes(name)) continue;
      return { ok: false, code: "INVALID_PARAMS", reason: `${id} needs ${name}` };
    }
    const bad = paramProblem(kind, v);
    if (bad) return { ok: false, code: "INVALID_PARAMS", reason: `${id} ${name}: ${bad}` };
  }
  const route = def.route ? def.route.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(got[k] ?? "")) : null;
  return { ok: true, def, params: { ...got }, route };
}

/**
 * A page intent's params against the page it runs on: tab.select's tab and section.expand's id must be one of the
 * route's own enums when it keeps one in its link (ASSIST_QUERY_KEYS), and list.filter's name must be a filter the
 * page keeps (filter.<name>) with a value of its options. Null when they fit; other intents always fit.
 */
export function viewParamProblem(intent: string, params: Readonly<Record<string, string>>, route: string, opts: { hosted?: boolean } = {}): string | null {
  const pattern = routePattern(route, opts);
  const keys = (pattern && ASSIST_QUERY_KEYS[pattern]) || table({});
  const fit = (key: string, v: string | undefined, required: boolean): string | null => {
    const shape = Object.hasOwn(keys, key) ? keys[key] : undefined;
    if (!shape) return required ? `${pattern ?? route} keeps no ${key}` : null;
    const bad = queryProblem(shape, v ?? "");
    return bad ? `${key} on ${pattern} is ${bad}` : null;
  };
  switch (intent) {
    case "tab.select": return fit("tab", params.tab, false);
    case "section.expand":
    case "section.collapse": return fit("section", params.id, false);
    case "list.filter": return fit(`filter.${params.name ?? ""}`, params.value, true);
    default: return null;
  }
}

function paramProblem(kind: IntentParam, v: string): string | null {
  switch (kind.kind) {
    case "id": return v.startsWith(kind.prefix) && (kind.re ?? ENTITY_RE).test(v) ? null : `an id that starts with ${kind.prefix}`;
    case "enum": return kind.values.includes(v) ? null : `one of ${kind.values.join(", ")}`;
    case "slug": return /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(v) ? null : "a short slug (letters, digits, - or _)";
    case "anchor": return ANCHOR_RE.test(v) ? null : "an anchor token";
    case "text": return v.length <= kind.max && !/[<>]/.test(v) ? null : `at most ${kind.max} characters`;
  }
}

// ---- show through the element table (the fallback) ----------------------------------------------------------

export const ASSIST_SHOW_ACTIONS = ["open", "tab", "scroll", "expand", "collapse"] as const;
export type AssistShowAction = (typeof ASSIST_SHOW_ACTIONS)[number];
/** The control kinds each show action may activate. Buttons, menu items and fields are never activated. */
export const SHOWABLE_KINDS: Readonly<Record<AssistShowAction, readonly ScreenItemKind[]>> = {
  open: ["row", "card", "link", "item", "chip"],
  tab: ["tab"],
  scroll: [...SCREEN_ITEM_KINDS],
  expand: ["disclosure", "section"],
  collapse: ["disclosure", "section"],
};
/** Kinds a person presses or types into: a walkthrough step never points at one (a tab and a disclosure only change the view). */
export const PRESSED_KINDS: readonly ScreenItemKind[] = ["button", "menuitem", "field"];

type ItemFacts = Pick<ScreenItem, "kind" | "label" | "testid" | "anchor"> & Partial<Pick<ScreenItem, "entity" | "href" | "mutating">>;

/**
 * Whether an element reads as a control that changes data: its test id or anchor, and its label unless it is a tab,
 * a disclosure, a record's own row or card (a person named Grant, an off-cycle run), or a link into the app (opening
 * it is a navigation checkRoute validates). An anchor counts by its manifest flag or its token, and an element the page
 * itself marks (data-assist-mutating, such as a link that signs in as someone) always counts.
 */
export function itemMutating(item: ItemFacts, opts: { hosted?: boolean } = {}): boolean {
  const record = (item.kind === "row" || item.kind === "card" || item.kind === "item") && !!item.entity;
  const appLink = item.kind === "link" && !!item.href && checkRoute(item.href, opts).ok;
  const words = item.kind === "tab" || item.kind === "disclosure" || record || appLink ? false : readsMutating(item.label);
  const anchor = item.anchor ? (Object.hasOwn(ASSIST_ANCHORS, item.anchor) && ASSIST_ANCHORS[item.anchor]!.mutating) || readsMutating(item.anchor) : false;
  return words || testidMutating(item.testid) || !!anchor || !!item.mutating;
}

/**
 * Why a show action on an element is refused, or null when it may run: the action is one of ASSIST_SHOW_ACTIONS, the
 * element's kind is one that action may activate, opening a link (or anything inside one) goes to a route checkRoute
 * accepts, and nothing about it (label, test id, anchor) reads as a control that changes data. The executor runs this
 * on the server; the client runs it again on the live element, with the href it reads there.
 */
export function showRefusal(item: ItemFacts, action: string, opts: { hosted?: boolean } = {}): string | null {
  if (!(ASSIST_SHOW_ACTIONS as readonly string[]).includes(action)) return `${action} is not a show action; show only opens, switches tabs, scrolls, expands or collapses`;
  const a = action as AssistShowAction;
  if (a !== "scroll" && !SHOWABLE_KINDS[a].includes(item.kind)) return `a ${item.kind} cannot be used to ${a}; show never presses buttons, menu items or fields`;
  if (a === "scroll") return null;
  // Opening a link is a navigation: only to a page of the nav registry (never the portal, another site or mail).
  if (a === "open" && (item.kind === "link" || item.href)) {
    const r = item.href ? checkRoute(item.href, opts) : null;
    if (!r?.ok) return `"${item.label}" goes to ${item.href ? JSON.stringify(item.href.slice(0, 60)) : "a place it does not name"}, which is not a page the assistant may open`;
  }
  if (itemMutating(item, opts)) return `"${item.label}" changes data; only a person can use it, so show will not`;
  return null;
}

/** Why a walkthrough step may not point at an element, or null: never a control a person presses, nor one that changes data. */
export function stepRefusal(item: ItemFacts, opts: { hosted?: boolean } = {}): string | null {
  if (PRESSED_KINDS.includes(item.kind)) return `"${item.label}" is a ${item.kind} a person presses`;
  if (itemMutating(item, opts)) return `"${item.label}" changes data`;
  return null;
}

// ---- presentation tool arguments -----------------------------------------------------------------------------

/** "@12" names screen map item 12; "#payroll-needs-review" names a known anchor. */
export const TARGET_RE = /^(?:@[1-9][0-9]{0,2}|#[a-z][a-z0-9-]{1,47})$/;
export type AssistTarget = { kind: "item"; n: number } | { kind: "anchor"; anchor: string };
export function parseTarget(t: string | null | undefined): AssistTarget | null {
  if (!t || !TARGET_RE.test(t)) return null;
  return t.startsWith("@") ? { kind: "item", n: Number(t.slice(1)) } : { kind: "anchor", anchor: t.slice(1) };
}

/** `hint` (optional): words that pick the right element when an anchor matches several, such as a person's name. */
export const PointArgs = z.object({ target: z.string().max(49), label: z.string().min(1).max(40), hint: z.string().max(40).optional() });
export const NavigateArgs = z.object({ route: z.string().max(SCREEN_LIMITS.route), target: z.string().max(49).optional(), label: z.string().max(40).optional(), hint: z.string().max(40).optional() });
export const ShowArgs = z.object({
  intent: z.string().max(48).optional(),
  params: z.array(z.object({ name: z.string().max(32), value: z.string().max(80) })).max(4).optional(),
  target: z.string().max(49).optional(),
  action: z.string().max(16).optional(),
  label: z.string().max(40).optional(),
});
export const SayArgs = z.object({ text: z.string().min(1).max(600) });
/** Why a request goes to the full agent: it asks for a change, an analysis, or several things at once. */
export const HANDOFF_REASONS = ["change", "analysis", "multi_part"] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];
export const HandoffArgs = z.object({ reason: z.enum(HANDOFF_REASONS), task: z.string().min(1).max(600) });
/**
 * A walkthrough: at most WALKTHROUGH_MAX steps, each a point after opening its route (a nav registry route), or with no
 * route on the page the person is on by then (the step waits for its anchor). Every target is validated like a point
 * and may not be a control that changes data.
 */
export const WALKTHROUGH_MAX = 6;
export const WalkStep = z.object({ route: z.string().max(SCREEN_LIMITS.route).optional(), target: z.string().max(49), label: z.string().min(1).max(40), text: z.string().min(1).max(240) });
export const StepsArgs = z.object({ steps: z.array(WalkStep).min(1).max(WALKTHROUGH_MAX) });
export type WalkStepEffect = { route: string | null; target: AssistTarget; label: string; text: string; selectors: string[] };

/** What a validated presentation call returns (its outcome data); the client applies it from the run's steps. */
export type AssistEffect =
  | { effect: "point"; target: AssistTarget; label: string; selectors: string[]; hint: string | null }
  | { effect: "navigate"; route: string; target: AssistTarget | null; label: string | null; selectors: string[]; hint: string | null }
  | { effect: "show"; via: "intent"; intent: string; params: Record<string, string>; route: string | null; anchor: string | null; selectors: string[]; label: string | null }
  | { effect: "show"; via: "element"; target: AssistTarget; action: AssistShowAction; label: string | null; selectors: string[] }
  | { effect: "say" }
  | { effect: "handoff"; reason: HandoffReason }
  | { effect: "steps"; steps: WalkStepEffect[] };

/** Labels are two to four words; a longer one is cut to four (the bubble stays small). */
export function shortLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ").slice(0, 40);
}

/**
 * A pointer's hint as the client may show it ("Nothing on this page names Ruth"): a name, letters with spaces, dots,
 * apostrophes and hyphens only, so no figure or sentence rides on it; anything else is dropped (null).
 */
export function hintName(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return /^\p{L}[\p{L} .'\u2019-]*$/u.test(t) ? t : null;
}

// ---- rendering for the context pack -------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => `"${s.replace(/["\n\r]/g, " ").trim()}"`;

/**
 * One line of the element table: `[12] button "Approve" prp_0014 840,312 96x32 selected`. With the page's route, an
 * anchor shows as `#token` only when the manifest knows it there (a target ui.point accepts); a page's other data-tour
 * tokens stay out of the line, so the model never copies one the executor would refuse.
 */
export function screenLine(i: ScreenItem, route?: string): string {
  const parts = [`[${i.n}]`, i.kind, q(clip(i.label, SCREEN_LIMITS.label))];
  if (i.entity) parts.push(i.entity);
  if (i.anchor && (route === undefined || anchorOn(i.anchor, route, { hosted: true }))) parts.push(`#${i.anchor}`);
  parts.push(`${i.box[0]},${i.box[1]} ${i.box[2]}x${i.box[3]}`);
  if (i.state) parts.push(i.state);
  return parts.join(" ");
}

/**
 * The element table within the budget (SCREEN_LIMITS.tableChars, about 1,500 tokens): items in order until the next
 * line would pass it. Untrusted labels are left to the caller (the pack wraps them); here they show as
 * `[n] kind (untrusted label)`.
 */
export function screenTable(items: readonly ScreenItem[], budget: number = SCREEN_LIMITS.tableChars, route?: string): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const i of items) {
    const line = i.untrusted ? `[${i.n}] ${i.kind} (untrusted label)${i.entity ? ` ${i.entity}` : ""} ${i.box[0]},${i.box[1]} ${i.box[2]}x${i.box[3]}` : screenLine(i, route);
    if (used + line.length + 1 > budget) { dropped++; continue; }
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, dropped };
}

/** Run file key of the request's screen map (executor RunFileStore), written before the run starts. */
export const ASSIST_SCREEN_FILE = "assist/screen.json";

/** Test ids for the assistant's own surfaces. */
export const ASSIST_TID = {
  icon: "assist-icon",
  composer: "assist-composer",
  input: "assist-input",
  send: "assist-send",
  mic: "assist-mic",
  transcript: "assist-transcript",
  popover: "assist-popover",
  answer: "assist-answer",
  status: "assist-status",
  step: "assist-step",
  card: "assist-card",
  continue: "assist-continue",
  voiceOut: "assist-voice-out",
  voiceProgress: "assist-voice-progress",
  close: "assist-close",
  menu: "assist-menu",
  menuCopy: "assist-menu-copy",
  menuAsk: "assist-menu-ask",
  pointer: "assist-pointer",
  bubble: "assist-bubble",
  /** Where the card's live region reads out a pointer's label (the bubble itself is visual only). */
  pointed: "assist-pointed",
  toggle: "assist-toggle",
  /** The handoff's progress card, its Stop and its Open in Agent. */
  progress: "assist-progress",
  stop: "assist-stop",
  stopFailed: "assist-stop-failed",
  openInAgent: "assist-open-in-agent",
  /** A closing "Show me" chip and an ambiguity choice button (data-entity carries the record id). */
  chip: "assist-chip",
  choice: "assist-choice",
  /** The walkthrough card and its controls (Next reads Done on the last step). */
  walk: "assist-walk",
  walkNext: "assist-walk-next",
  walkBack: "assist-walk-back",
} as const;

// ---- the run, as the client starts it and reads it back -----------------------------------------------------

/**
 * POST /v1/agent/runs with recipe "assist". threadId is optional: the API mints one (thr_ and 20 hex characters) when
 * it is absent and returns it, so the exchange is always a conversation that Open in Agent can show and that a
 * handoff continues. The whole body is at most SCREEN_LIMITS.bodyBytes (413 past it).
 */
export interface AssistRunRequest { text: string; pageContext: string | null; threadId?: string | null; recipe: typeof ASSIST_RECIPE; assist: AssistInput }
export interface AssistRunAccepted { runId: string; chatMode: typeof ASSIST_RECIPE; threadId: string }

/** A closing "Show me" chip or an ambiguity option: a validated intent (and its route and ring) for one record. */
export interface ClosingChip {
  id: string;
  label: string;
  intent: string;
  params: { name: string; value: string }[];
  route: string | null;
  /** The anchor to ring once the route is open, and its selectors with the params filled in. */
  anchor: string | null;
  selectors: string[];
}
/**
 * What code (not the model) offers when an assist run or a handoff's chat run ends, from the run's own steps: the
 * proposals it filed (each an approval.card chip, the card itself in the trace's cards), up to CLOSING_CHIPS records
 * the answer cites, or, when the answer is a question over a few candidates, those candidates to choose from.
 */
export interface AssistClosing { chips: ClosingChip[]; choose: { question: string; options: ClosingChip[] } | null; proposals: string[] }
export const CLOSING_CHIPS = 4;
/**
 * The link between an assist run and the chat run it handed to, on both runs' traces: `to` on the assist run, `from`
 * on the chat run. `forced` is true when code decided the handoff (a change request, the step cap, a tool the assist
 * run does not have), false when the model chose ui.handoff.
 */
export interface AssistHandoffLink { to: string | null; from: string | null; reason: HandoffReason | null; forced: boolean | null }
/**
 * What GET /v1/agent/runs/:id/trace adds to RunTrace for the cursor assistant. `cards` (wave 3) holds one approval
 * card per proposal the run filed or showed through approval.card. `closing` is set on a finished assist run (not one
 * that handed off) and on a handoff's chat run; null elsewhere.
 */
export interface AssistTraceExtras { handoff: AssistHandoffLink | null; closing: AssistClosing | null }

/** How a choice continues the thread: the client posts this text (recipe assist, same threadId) for the option picked. */
export const choiceText = (o: Pick<ClosingChip, "label" | "id">): string =>
  `${o.label.replace(/\((?:[a-z]{2,5}_[A-Za-z0-9_:]+)\)/g, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "This one"} (${o.id})`;

// ---- spoken answers (the hosted fallback) -------------------------------------------------------------------

// In a file of their own with no zod, so the extras Worker that speaks them stays small (apps/cf extras boundary).
export * from "./assist-speech";

// ---- the help corpus the instant resolver reads ------------------------------------------------------------

export interface AssistHelpEntry {
  id: string;
  /** A walkthrough instead of one point: played with Next and Back (ui.steps). */
  steps?: readonly { route: string | null; anchor: string; label: string; text: string }[];
  /** Matched against the question in lower case; each is a regular expression source. */
  phrases: readonly string[];
  /** Where the answer lives. */
  route: string;
  /** The anchor to point at there. */
  anchor: string | null;
  /** The pointer's label. */
  label: string;
  /** The popover line: plain words, no figures. */
  answer: string;
}

/**
 * How-to answers from Weft's own docs (README "Things to try", docs/tour.md), for "where is X" and "how do I Y"
 * questions the resolver answers without a model call. Every route is in the nav registry and every anchor is known on
 * its route (a unit test checks both). The answers name no figure, so they need no grounding.
 */
export const ASSIST_HELP: readonly AssistHelpEntry[] = [
  {
    id: "run-payroll", phrases: ["\\b(run|process|do|finish)\\b.*\\bpayroll\\b.*\\b(end to end|start to finish|step by step|from start)", "\\bwalk me through\\b.*\\bpayroll"],
    route: "/app/payroll", anchor: "payroll-runs", label: "Pay runs", answer: "Five steps from the draft to the bank. Use Next and Back; you press every button yourself.",
    steps: [
      { route: "/app/payroll", anchor: "payroll-runs", label: "Open the draft", text: "Each pay period has a draft run. Open the one for this period." },
      { route: null, anchor: "payroll-needs-review", label: "Needs review", text: "Fixed rules flag anything unusual before the run is paid. Open each flag to read why it fired." },
      { route: null, anchor: "payroll-flag", label: "A flag", text: "A flag's popover has the evidence and the agent's explanation. Fix the record or accept the reason." },
      { route: "/app/inbox", anchor: "inbox-approvals", label: "Approvals", text: "The pre-payroll review files its submit proposal here; approving re-runs every check first." },
      { route: "/app/audit", anchor: "audit-chain", label: "On the record", text: "Once the run is submitted, the audit log records it in its hash chain." },
    ],
  },
  { id: "approve-time-off", phrases: ["(approve|decide|review|sign off)\\b.*\\b(time off|vacation|pto|leave)", "(time off|vacation|pto|leave)\\b.*\\b(approv|decid)"], route: "/app/inbox", anchor: "inbox-time-off-approve", label: "Approve it here", answer: "Time-off decisions wait in the Inbox. Approve or deny the request on its card; nothing changes until you do." },
  { id: "request-time-off", phrases: ["(request|book|ask for|take)\\b.*\\b(time off|vacation|pto|leave)"], route: "/app/time-off", anchor: "time-off-requests", label: "Time-off requests", answer: "Requests are on the Time Off page. A new hire asks from the portal; each request runs its checks before it reaches the manager." },
  { id: "approvals", phrases: ["\\b(approvals?|pending approvals?|things to approve|waiting for (me|approval))\\b"], route: "/app/inbox", anchor: "inbox-approvals", label: "Waiting for you", answer: "Everything waiting for a decision is in the Inbox. Approving re-runs every check on the stored arguments." },
  { id: "rate-change", phrases: ["\\b(sui|tax rates?|rate change|unemployment rate)\\b"], route: "/app/compliance", anchor: "compliance-rates", label: "Tax rates", answer: "Employer tax rates are on the Rates tab of Taxes and Compliance, each with its source." },
  { id: "filing-calendar", phrases: ["\\b(deadlines?|due dates?|filing calendar|deposits? due|compliance calendar)\\b"], route: "/app/compliance", anchor: "compliance-calendar", label: "Compliance calendar", answer: "The Calendar tab of Taxes and Compliance tracks every deposit and filing due." },
  { id: "undo", phrases: ["\\b(undo|roll ?back|revert|audit log|who changed|change history)\\b"], route: "/app/audit", anchor: "audit-chain", label: "Audit log", answer: "Every change is a row in the audit log; a reversible one has Undo, which appends a reversing row." },
  { id: "routines", phrases: ["\\b(routines?|automations?|digest|schedul\\w* (a |the )?(routine|digest))\\b"], route: "/app/routines", anchor: "routine-gallery", label: "Routines", answer: "Routines run on a schedule or an event; the gallery shows each with its last and next run." },
  { id: "memory", phrases: ["\\b(memory|procedures?|policy notes?|wiki)\\b"], route: "/app/memory", anchor: "memory-file", label: "Memory", answer: "The agent's memory is Markdown in a git repository; every edit is a commit." },
  { id: "permissions", phrases: ["\\b(permissions?|who can|access rights?|roles?)\\b"], route: "/app/settings/permissions", anchor: "permissions-matrix", label: "Permissions", answer: "View, Edit and Approve per person are in Settings, Permissions. The agent never exceeds the person it acts for." },
  { id: "offers", phrases: ["\\b(send an offer|make an offer|offers?|hire someone)\\b"], route: "/app/hiring", anchor: "hiring-offers", label: "Offers", answer: "Offers are on the Hiring page. Once one is signed, onboarding becomes the new hire's checklist." },
  { id: "expenses", phrases: ["\\b(expenses?|receipts?|reimburse\\w*|(expense|reimbursement) claims?)\\b"], route: "/app/expenses", anchor: "expense-checks", label: "Policy checks", answer: "Claims are on the Expenses page, checked against policy as they arrive. Decisions are per claim, never in bulk." },
  { id: "notices", phrases: ["\\b(deliver (a |the )?notice|agency notice|simulators?)\\b"], route: "/app/simulators", anchor: "sim-deliver", label: "Deliver a notice", answer: "The Simulators page delivers agency notices and moves the clock. Delivering one starts the agent's notice routine." },
  { id: "clock", phrases: ["\\b(clock|viewing as|switch (person|persona|user)|reset (the )?workspace|take the tour)\\b"], route: "/app", anchor: "env-pill", label: "Clock and persona", answer: "The pill in the top bar holds the simulated clock and Viewing as, with Take the tour and Reset workspace data in its menu." },
  { id: "benefits-reconciliation", phrases: ["\\b(benefits? )?reconciliation\\b", "\\bcarrier (invoices?|bills?)\\b"], route: "/app/benefits?tab=reconciliation", anchor: "benefits-reconciliation", label: "Reconciliation", answer: "The Reconciliation tab of Benefits checks each month's carrier records against Weft's enrollments and lists what does not match." },
  { id: "background-work", phrases: ["\\bbackground (work|runs?)\\b"], route: "/app/agent?tab=background", anchor: "agent-background", label: "Background work", answer: "Routine runs and agency notice runs are under Background work on the Agent page, each with its summary." },
  { id: "ask-agent", phrases: ["\\b(ask the agent|chat with|agent panel|conversations?)\\b"], route: "/app/agent", anchor: "agent-conversations", label: "Conversations", answer: "The Agent page keeps every conversation; a follow-up stays in its thread." },
];
