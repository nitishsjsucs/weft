// The cursor assistant's presentation tools (ui.point, ui.navigate, ui.show, ui.say, ui.handoff, ui.steps; packages/
// contracts/src/ext/assist.ts). They are R0 reads that write nothing: each validates its call against the static manifest (the nav
// registry, the known anchors, the intents, the show allowlist and denylist) and against this request's screen map,
// which apps/api writes into the run workspace before the run starts. A valid call returns the normalized effect as
// its data; the client applies it from the run's steps. An invalid one is refused like any other tool call, so the
// refusal is in the run's steps too. None of them is on any allowlist but the assist recipe's, and none is on MCP.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ID_SHAPE, idPrefixOf, Refused } from "@weft/contracts";
import { proposalVisible, readScopeOf, viewerIdOf, type WeftCommand } from "@weft/core";
import { principals, proposals, type DbTx } from "@weft/db";
import {
  anchorOn, ASSIST_ANCHORS, ASSIST_NAV, ASSIST_RECORD_ROUTES, ASSIST_SCREEN_FILE, ASSIST_SHOW_ACTIONS, checkIntent, checkRoute, fillSelectors, HandoffArgs, NavigateArgs, parseTarget, PointArgs, readsMutating,
  hintName, routeDomains, SayArgs, ScreenMap, shortLabel, ShowArgs, showRefusal, splitRoute, stepRefusal, StepsArgs, viewParamProblem, type AssistAnchor, type AssistEffect, type AssistShowAction, type AssistTarget, type ScreenItem, type WalkStepEffect,
} from "../../contracts/src/ext/assist";
import { NODE_HOSTED, type Engine } from "./engine";
import { runRel } from "./hosted/run-files";
import { findUnknownReference, REF_TABLES } from "./references";
import { GRANT_RANK, type Grants } from "./store";

const base = {
  compactDescription: "", amountCents: null, ceilingKey: null, reversible: false as const, lease: null, sandbox: "hidden" as const, access: "all" as const,
  untrustedFields: [] as string[], afterPending: "run" as const, preview: null, namespace: "ui" as const, domain: "company" as const, needs: "view" as const,
  effect: "read" as const, risk: () => "R0" as const, approval: "never" as const, autoAllow: "never" as const, tiers: { main: "executable" as const, task: "unavailable" as const },
  mcp: "hidden" as const,
};

/** The run file that holds this request's screen map. */
export function assistScreenKey(companyId: string, runId: string): string {
  return `${runRel(companyId, runId)}/${ASSIST_SCREEN_FILE}`;
}

type Ctx = Parameters<WeftCommand["run"]>[1];

async function screenOf(e: Engine, ctx: Ctx): Promise<ScreenMap> {
  if (!ctx.run) throw new Refused("UNAVAILABLE", "Presentation tools work only inside an assist run");
  const body = await e.runFiles.read(assistScreenKey(ctx.companyId, ctx.run.id));
  const parsed = body ? ScreenMap.safeParse(JSON.parse(body)) : null;
  if (!parsed?.success) throw new Refused("UNAVAILABLE", "Presentation tools work only in an assist run, which carries a screen map");
  return parsed.data;
}

const hostedOf = (e: Engine) => e.hosted !== NODE_HOSTED;

function itemOf(screen: ScreenMap, n: number): ScreenItem {
  const i = screen.items.find((x) => x.n === n);
  if (!i) throw new Refused("UNKNOWN_REFERENCE", `@${n} is not in this request's screen map`, { hint: "Name an element by its number in the screen map, or a known anchor (#token) of the page.", example: { target: "@1", label: "Here" } });
  return i;
}

/** The grants of the person the call acts for (the sidebar shows them only the items those grants open). */
async function grantsOf(tx: DbTx, ctx: Ctx): Promise<Partial<Grants>> {
  const id = viewerIdOf(ctx);
  if (!id) return {};
  const [p] = await tx.select({ grantsJson: principals.grantsJson }).from(principals).where(and(eq(principals.id, id), eq(principals.companyId, ctx.companyId))).limit(1);
  try { return (JSON.parse(p?.grantsJson ?? "{}") as Partial<Grants>) ?? {}; } catch { return {}; }
}

const canView = (grants: Partial<Grants>, domain: keyof Grants): boolean => (GRANT_RANK[grants[domain] ?? "none"] ?? 0) >= GRANT_RANK.view;

/** A sidebar item the person's grants close is not in their sidebar, so it cannot be pointed at (nav.ts NavItem.domain). */
async function hiddenFor(tx: DbTx, ctx: Ctx, a: AssistAnchor): Promise<boolean> {
  if (!a.domain) return false;
  return !canView(await grantsOf(tx, ctx), a.domain);
}

/**
 * A page the person's grants close is not in their sidebar (routeDomains: its section, a person's Benefits or IT tab),
 * so it is not opened for them, whatever its link: refused with the words a closed sidebar item gets.
 */
async function routeClosed(tx: DbTx, ctx: Ctx, route: string, hosted: boolean, what: string): Promise<void> {
  const need = routeDomains(route, { hosted });
  if (!need.length) return;
  const grants = await grantsOf(tx, ctx);
  const closed = need.find((d) => !canView(grants, d));
  if (closed) throw new Refused("UNKNOWN_REFERENCE", `${what} is not in this person's sidebar: their access does not open ${closed === "it" ? "IT" : closed}`, { hint: "Say plainly that this person cannot open it.", example: { route: "/app" } });
}

/**
 * The ids a route may carry whose records REF_TABLES (the pipeline's reference check) does not list: an offboarding
 * case and an expense claim by company, in the domain their own reads need, and a conversation thread only when it is
 * this person's (a thread whose runs acted for someone else does not exist for them, as POST /v1/agent/runs answers).
 */
const ROUTE_REFS: Readonly<Record<string, { domain: keyof Grants; exists: (tx: DbTx, companyId: string, id: string, viewer: string | null) => Promise<boolean> }>> = {
  ofb_: { domain: "people", exists: async (tx, c, id) => (await tx.all<{ id: string }>(sql`SELECT id FROM offboarding_cases WHERE id = ${id} AND company_id = ${c} LIMIT 1`)).length > 0 },
  exp_: { domain: "payroll", exists: async (tx, c, id) => (await tx.all<{ id: string }>(sql`SELECT id FROM expenses WHERE id = ${id} AND company_id = ${c} LIMIT 1`)).length > 0 },
  thr_: {
    domain: "company",
    exists: async (tx, c, id, viewer) => {
      const runs = await tx.all<{ who: string | null }>(sql`SELECT COALESCE(e.on_behalf_of, a.on_behalf_of) AS who FROM agent_runs a LEFT JOIN exec_runs e ON e.id = a.id WHERE a.thread_id = ${id} AND a.company_id = ${c} LIMIT 200`);
      return runs.length > 0 && (!viewer || runs.every((r) => r.who === viewer));
    },
  },
};

/**
 * The record ids a route names (checkRoute ids: its page's own id, a paycheck, a proposal, a case, a claim, a thread)
 * must exist in this company in a domain the person can view, like every id argument (harness 4.6); an invented one
 * is refused, and so is an id of a kind nothing here can look up.
 */
async function idsExist(tx: DbTx, ctx: Ctx, ids: readonly string[], what: string): Promise<void> {
  if (!ids.length) return;
  const grants = await grantsOf(tx, ctx);
  const refused = (id: string, closest: string[] = []) => new Refused("UNKNOWN_REFERENCE", `${what}: ${id} does not exist in this company`, { hint: closest.length ? `Closest ids: ${closest.join(", ")}` : "Use an id from a tool result or the screen map.", example: { route: "/app/payroll" } });
  const known: string[] = [];
  for (const id of ids) {
    const prefix = idPrefixOf(id);
    const ref = prefix && Object.hasOwn(ROUTE_REFS, prefix) ? ROUTE_REFS[prefix]! : null;
    if (ref) {
      if (!canView(grants, ref.domain) || !(await ref.exists(tx, ctx.companyId, id, viewerIdOf(ctx)))) throw refused(id);
      continue;
    }
    // Only an id the reference check really looks up (a listed prefix, its shape); any other is skipped there, so here
    // it is refused rather than let through unchecked.
    if (!prefix || !REF_TABLES[prefix] || !ID_SHAPE.test(id)) throw refused(id);
    known.push(id);
  }
  const unknown = known.length ? await findUnknownReference(tx, ctx.companyId, known, grants as Grants) : null;
  if (unknown) throw refused(unknown.id, unknown.closest);
}

/**
 * A route's records exist (idsExist) and belong together: a pay run's paycheck link names a worker who has a paycheck
 * in that run (a contractor, or someone hired after it, has none), so a show never claims a drawer that cannot open.
 */
async function routeRecordsExist(tx: DbTx, ctx: Ctx, r: { route: string; pattern: string; ids: readonly string[] }, what: string): Promise<void> {
  await idsExist(tx, ctx, r.ids, what);
  if (r.pattern !== "/app/payroll/:id") return;
  const { path, query } = splitRoute(r.route);
  const workerId = new URLSearchParams(query ?? "").get("paycheck");
  const runId = path.split("/").pop()!;
  if (!workerId) return;
  const rows = await tx.all<{ id: string }>(sql`SELECT x.id AS id FROM paychecks x JOIN payroll_runs p ON p.id = x.payroll_run_id WHERE x.payroll_run_id = ${runId} AND x.worker_id = ${workerId} AND p.company_id = ${ctx.companyId} LIMIT 1`);
  if (!rows.length) throw new Refused("UNKNOWN_REFERENCE", `${what}: ${workerId} has no paycheck in ${runId}`, { hint: "Open the pay run, or name a worker its paychecks list.", example: { route: `/app/payroll/${runId}` } });
}

/** A target on the current page: an item of the screen map, or an anchor the manifest knows on this route. */
async function onPage(e: Engine, tx: DbTx, ctx: Ctx, screen: ScreenMap, raw: string): Promise<{ target: AssistTarget; item: ScreenItem | null; selectors: string[] }> {
  const t = parseTarget(raw);
  if (!t) throw new Refused("INVALID_INPUT", `target ${JSON.stringify(raw).slice(0, 60)} is not @<number> or #<anchor>`, { hint: "Use @12 for screen map item 12, or #payroll-needs-review for a known anchor.", example: { target: "@1", label: "Here" } });
  if (t.kind === "item") return { target: t, item: itemOf(screen, t.n), selectors: [] };
  const a = anchorOn(t.anchor, screen.route, { hosted: hostedOf(e) });
  if (!a) throw new Refused("UNKNOWN_REFERENCE", `#${t.anchor} is not a known anchor of ${screen.route.split("?")[0]}`, { hint: "Point at an element from the screen map instead.", example: { target: "@1", label: "Here" } });
  if (await hiddenFor(tx, ctx, a)) throw new Refused("UNKNOWN_REFERENCE", `#${t.anchor} is not in this person's sidebar: their access does not open ${a.label}`, { hint: "Say plainly that this person cannot open it.", example: { target: "@1", label: "Here" } });
  return { target: t, item: null, selectors: a.selectors };
}

const navLabel = (route: string): string => {
  const path = route.split("?")[0]!;
  const nav = ASSIST_NAV.find((n) => n.href === path);
  if (nav) return nav.label;
  const rec = ASSIST_RECORD_ROUTES.find((r) => path.startsWith(r.pattern.slice(0, -"/:id".length) + "/"));
  return rec ? `${rec.label} ${path.split("/").pop()}` : path;
};

const showVerb: Record<AssistShowAction, string> = { open: "Opened", tab: "Switched to", scroll: "Scrolled to", expand: "Expanded", collapse: "Collapsed" };

const NOT_A_CHANGE = "Presentation tools only move the view. They never approve, submit, save, delete, send or run anything: a change is a proposal a person approves in the Inbox.";

/** An anchor known on any one of its own routes (a step whose page is not known yet), or null. */
function anyRouteAnchor(token: string, hosted: boolean): AssistAnchor | null {
  const a = Object.hasOwn(ASSIST_ANCHORS, token) ? ASSIST_ANCHORS[token]! : null;
  return a && a.routes.some((r) => anchorOn(token, r, { hosted })) ? a : null;
}

export function assistCommands(e: Engine): WeftCommand[] {
  const point: WeftCommand<z.infer<typeof PointArgs>> = {
    ...base, name: "ui.point", summary: "Point at an element on the person's screen",
    description: "Glide the assistant's pointer to an element and ring it with a two to four word label. target is @<n> from the screen map or #<anchor> of this page. Writes nothing. Example: { \"target\": \"@12\", \"label\": \"Approve here\" }",
    input: PointArgs,
    errorHints: { INVALID_INPUT: { hint: "target is @<n> from the screen map; label is two to four words", example: { target: "@1", label: "Right here" } } },
    async run(i, ctx, deps) {
      const screen = await screenOf(e, ctx);
      const { target, item, selectors } = await onPage(e, deps.tx, ctx, screen, i.target);
      const label = shortLabel(i.label);
      const data: AssistEffect = { effect: "point", target, label, selectors, hint: hintName(i.hint) };
      return { data, summary: `Pointed at ${item ? (item.untrusted ? `item ${item.n}` : item.label || label) : ASSIST_ANCHORS[(target as { anchor: string }).anchor]!.label}` };
    },
  };

  const navigate: WeftCommand<z.infer<typeof NavigateArgs>> = {
    ...base, name: "ui.navigate", summary: "Open another page of the app",
    description: "Open a page from the nav registry (a sidebar page, Settings, or a record page such as /app/payroll/pay_... or /app/people/wrk_...), then optionally point at a known anchor of it. Writes nothing. Example: { \"route\": \"/app/inbox\", \"target\": \"#inbox-time-off\", \"label\": \"Ruth's request\" }",
    input: NavigateArgs,
    errorHints: { INVALID_INPUT: { hint: "route is a path in the nav registry; target is #<anchor> on that page", example: { route: "/app/payroll", target: null, label: null } } },
    async run(i, ctx, deps) {
      await screenOf(e, ctx);
      const r = checkRoute(i.route, { hosted: hostedOf(e) });
      if (!r.ok) throw new Refused("UNKNOWN_REFERENCE", r.reason, { hint: "Use a sidebar page or a record page with an id from a tool result or the screen map.", example: { route: "/app/payroll" } });
      await routeClosed(deps.tx, ctx, r.route, hostedOf(e), navLabel(r.route));
      await routeRecordsExist(deps.tx, ctx, r, r.route);
      let target: AssistTarget | null = null;
      let selectors: string[] = [];
      if (i.target) {
        const t = parseTarget(i.target);
        if (!t || t.kind !== "anchor") throw new Refused("INVALID_INPUT", "After a navigation the target is #<anchor> of the destination page; screen map numbers belong to the current page", { hint: "Leave target null, or name a known anchor of the page you open.", example: { route: r.route, target: null } });
        const a = anchorOn(t.anchor, r.pattern, { hosted: hostedOf(e) });
        if (!a) throw new Refused("UNKNOWN_REFERENCE", `#${t.anchor} is not a known anchor of ${r.pattern}`, { hint: "Leave target null to open the page only.", example: { route: r.route, target: null } });
        if (await hiddenFor(deps.tx, ctx, a)) throw new Refused("UNKNOWN_REFERENCE", `#${t.anchor} is not in this person's sidebar: their access does not open ${a.label}`, { hint: "Leave target null to open the page only.", example: { route: r.route, target: null } });
        target = t;
        selectors = a.selectors;
      }
      const label = i.label ? shortLabel(i.label) : target ? ASSIST_ANCHORS[(target as { anchor: string }).anchor]!.label : null;
      const data: AssistEffect = { effect: "navigate", route: r.route, target, label, selectors, hint: hintName(i.hint) };
      return { data, summary: `Opened ${navLabel(r.route)}${target && label ? ` and pointed at ${label}` : ""}` };
    },
  };

  const show: WeftCommand<z.infer<typeof ShowArgs>> = {
    ...base, name: "ui.show", summary: "Show something through a page intent or a non-mutating control",
    description: "Move the view to show something. Prefer an intent the screen map lists (intent and params as name/value pairs). Otherwise target is @<n> and action is open, tab, scroll, expand or collapse. Refused for any control that changes data. Example: { \"intent\": \"payroll.openPaycheck\", \"params\": [{ \"name\": \"workerId\", \"value\": \"wrk_0026\" }] }",
    input: ShowArgs,
    errorHints: {
      INVALID_INPUT: { hint: "either intent with params, or target with action", example: { intent: "payroll.showNeedsReview", params: [{ name: "payrollId", value: "pay_2026_10_30" }] } },
      NOT_PERMITTED: { hint: "Point at the control and say only a person can use it; changes wait as proposals for a person.", example: { target: "@1", label: "Approve here" } },
    },
    async run(i, ctx, deps) {
      const screen = await screenOf(e, ctx);
      if (i.intent) {
        const c = checkIntent(i.intent, i.params, screen.intents);
        if (!c.ok) {
          // An intent that would change data does not exist; asking for one is refused as not permitted, so the
          // run's steps read as a refusal, not a typo.
          const code = c.code === "INVALID_PARAMS" ? "INVALID_INPUT" : c.code === "UNKNOWN_INTENT" && readsMutating(i.intent) ? "NOT_PERMITTED" : "UNKNOWN_REFERENCE";
          throw new Refused(code, `${c.reason}.${c.code === "UNKNOWN_INTENT" ? ` ${NOT_A_CHANGE}` : ""}`, { hint: "Use an intent from the screen map's intents line.", example: { intent: "scroll.to", params: [{ name: "anchor", value: "payroll-needs-review" }] } });
        }
        if (c.route) {
          const r = checkRoute(c.route, { hosted: hostedOf(e) });
          if (!r.ok) throw new Refused("UNKNOWN_REFERENCE", r.reason);
          // The records the link names exist and are this person's to see, exactly as for ui.navigate and ui.steps.
          await routeClosed(deps.tx, ctx, r.route, hostedOf(e), c.def.title);
          await routeRecordsExist(deps.tx, ctx, r, c.def.id);
        }
        // A page intent's tab, section or filter is one this page keeps (its enums in the manifest), not a free slug.
        const view = c.def.scope === "page" ? viewParamProblem(c.def.id, c.params, screen.route, { hosted: hostedOf(e) }) : null;
        if (view) throw new Refused("INVALID_INPUT", `${c.def.id}: ${view}`, { hint: "Use a value the page offers.", example: { intent: c.def.id, params: Object.entries(c.params).map(([name, value]) => ({ name, value })) } });
        if (c.def.id === "approval.card") {
          // The card the person could read in their own Inbox: a narrowed person (a manager) gets none for a proposal
          // outside their reports and domains, exactly as GET /v1/proposals/:id answers them (proposalVisible).
          const [p] = await deps.tx.select().from(proposals).where(and(eq(proposals.id, c.params.proposalId!), eq(proposals.companyId, ctx.companyId))).limit(1);
          if (!p || !proposalVisible(await readScopeOf(deps.tx, ctx), p)) throw new Refused("UNKNOWN_REFERENCE", `No proposal ${c.params.proposalId}`);
        }
        if (c.def.id === "scroll.to" && !anchorOn(c.params.anchor!, screen.route, { hosted: hostedOf(e) })) {
          throw new Refused("UNKNOWN_REFERENCE", `#${c.params.anchor} is not a known anchor of this page`);
        }
        const anchor = c.def.id === "scroll.to" ? c.params.anchor! : c.def.anchor ?? null;
        const anchorDef = anchor && Object.hasOwn(ASSIST_ANCHORS, anchor) ? ASSIST_ANCHORS[anchor] : undefined;
        if (anchorDef?.mutating && c.def.id === "scroll.to") throw new Refused("NOT_PERMITTED", `#${anchor} changes data; point at it instead. ${NOT_A_CHANGE}`);
        // A sidebar item this person's grants close is not on their screen to scroll to (as ui.point refuses it).
        if (anchorDef && await hiddenFor(deps.tx, ctx, anchorDef)) throw new Refused("UNKNOWN_REFERENCE", `#${anchor} is not in this person's sidebar: their access does not open ${anchorDef.label}`, { hint: "Say plainly that this person cannot open it.", example: { target: "@1", label: "Here" } });
        // An anchor such as the Inbox card of one proposal names the intent's params in its selectors.
        const data: AssistEffect = { effect: "show", via: "intent", intent: c.def.id, params: c.params, route: c.route, anchor, selectors: anchorDef ? fillSelectors(anchorDef.selectors, c.params) : [], label: i.label ? shortLabel(i.label) : anchorDef?.label ?? null };
        return { data, summary: c.def.title };
      }
      if (!i.target || !i.action) throw new Refused("INVALID_INPUT", "ui.show takes an intent with params, or a target with an action", { hint: "Prefer an intent from the screen map.", example: { intent: "tab.select", params: [{ name: "tab", value: "pay" }] } });
      if (!(ASSIST_SHOW_ACTIONS as readonly string[]).includes(i.action)) throw new Refused("NOT_PERMITTED", `${i.action} is not a show action (open, tab, scroll, expand, collapse). ${NOT_A_CHANGE}`);
      const { target, item, selectors } = await onPage(e, deps.tx, ctx, screen, i.target);
      const action = i.action as AssistShowAction;
      if (item) {
        const why = showRefusal(item, action, { hosted: hostedOf(e) });
        if (why) throw new Refused("NOT_PERMITTED", `${why}. ${NOT_A_CHANGE}`, { hint: "Point at it with ui.point and tell the person what it does.", example: { target: `@${item.n}`, label: "Here" } });
      } else {
        const anchor = (target as { anchor: string }).anchor;
        const a = ASSIST_ANCHORS[anchor]!;
        if (a.mutating) throw new Refused("NOT_PERMITTED", `"${a.label}" changes data; only a person can use it. ${NOT_A_CHANGE}`, { hint: "Point at it with ui.point instead.", example: { target: `#${anchor}`, label: a.label } });
        if (action !== "scroll") throw new Refused("NOT_PERMITTED", "An anchor can only be scrolled to; open, tab, expand and collapse take an element from the screen map");
      }
      const label = i.label ? shortLabel(i.label) : item?.label ? shortLabel(item.label) : null;
      const data: AssistEffect = { effect: "show", via: "element", target, action, label, selectors };
      return { data, summary: `${showVerb[action]} ${item ? (item.untrusted ? `item ${item.n}` : item.label) : ASSIST_ANCHORS[(target as { anchor: string }).anchor]!.label}` };
    },
  };

  const say: WeftCommand<z.infer<typeof SayArgs>> = {
    ...base, name: "ui.say", summary: "Answer in the popover next to the pointer",
    description: "The short answer shown in the popover next to the pointer: one to three plain sentences, numbers only from tool results with their [res_...] id. It is checked like any chat answer. The text is not echoed back. Example: { \"text\": \"Four paychecks need review [res_0001].\" }",
    input: SayArgs,
    errorHints: { INVALID_INPUT: { hint: "text is one to three sentences, at most 600 characters", example: { text: "Here it is." } } },
    async run(_i, ctx) {
      await screenOf(e, ctx);
      // Model-authored text: never echoed, so it can never ground itself (grounding MODEL_AUTHORED_TOOLS).
      const data: AssistEffect = { effect: "say" };
      return { data, summary: "Answered in the popover" };
    },
  };

  const handoff: WeftCommand<z.infer<typeof HandoffArgs>> = {
    ...base, name: "ui.handoff", summary: "Hand the request to the full agent",
    description: "Hand the request to the full agent in the same conversation: for a change (it files proposals a person approves), an analysis that needs more reads than you have, or several things at once. task restates what to do in one or two sentences. Writes nothing. Example: { \"reason\": \"change\", \"task\": \"Give Lena Brooks a raise and fix Lena's withholding.\" }",
    input: HandoffArgs,
    errorHints: { INVALID_INPUT: { hint: "reason is change, analysis or multi_part; task restates the request", example: { reason: "analysis", task: "Compare the last three pay runs and name the outliers." } } },
    async run(i, ctx) {
      await screenOf(e, ctx);
      // The task is model text: never echoed, so it can never ground anything. The runtime starts the chat run.
      const data: AssistEffect = { effect: "handoff", reason: i.reason };
      return { data, summary: "Handed to the agent" };
    },
  };

  const steps: WeftCommand<z.infer<typeof StepsArgs>> = {
    ...base, name: "ui.steps", summary: "Walk the person through a task, one point at a time",
    description: "A walkthrough of at most six steps, played with Next and Back. Each step points at a target (#anchor, or @n on this page) after opening its route, or with no route on the page the person reaches by then. A step may never point at a control that changes data. Example: { \"steps\": [{ \"route\": \"/app/inbox\", \"target\": \"#inbox-approvals\", \"label\": \"Approvals\", \"text\": \"Every change waits here.\" }] }",
    input: StepsArgs,
    errorHints: { NOT_PERMITTED: { hint: "Point the step at what the control acts on, and say in its text that the person presses it.", example: { steps: [{ route: "/app/inbox", target: "#inbox-approvals", label: "Approvals", text: "Every change waits here." }] } } },
    async run(i, ctx, deps) {
      const screen = await screenOf(e, ctx);
      const hosted = hostedOf(e);
      const out: WalkStepEffect[] = [];
      let moved = false;
      for (const [k, st] of i.steps.entries()) {
        const n = k + 1;
        const t = parseTarget(st.target);
        if (!t) throw new Refused("INVALID_INPUT", `Step ${n}: target is @<n> or #<anchor>`);
        let route: string | null = null;
        let pattern: string | null = moved ? null : screen.route;
        if (st.route) {
          const r = checkRoute(st.route, { hosted });
          if (!r.ok) throw new Refused("UNKNOWN_REFERENCE", `Step ${n}: ${r.reason}`);
          await routeClosed(deps.tx, ctx, r.route, hosted, `Step ${n}: ${navLabel(r.route)}`);
          await routeRecordsExist(deps.tx, ctx, r, `Step ${n}`);
          route = r.route;
          pattern = r.pattern;
          moved = true;
        }
        let selectors: string[] = [];
        if (t.kind === "item") {
          if (route || moved) throw new Refused("INVALID_INPUT", `Step ${n}: screen map numbers belong to the current page; after a move use #<anchor>`);
          const item = itemOf(screen, t.n);
          // A control a person presses (any button, menu item or field) or one that reads as a change: the step points
          // at what it acts on instead. The kind rule holds even where the word and test id lists miss a control.
          const why = stepRefusal(item, { hosted });
          if (why) throw new Refused("NOT_PERMITTED", `Step ${n} points at ${why}; a walkthrough points at what it acts on and leaves the press to the person`);
        } else {
          // A step with no route of its own, after a move, is on a page code cannot name yet: any anchor known on some
          // page (never a templated one, never a hosted-only one on the Node app).
          const a = pattern ? anchorOn(t.anchor, pattern, { hosted }) : anchorOn(t.anchor, "*", { hosted }) ?? anyRouteAnchor(t.anchor, hosted);
          if (!a) throw new Refused("UNKNOWN_REFERENCE", `Step ${n}: #${t.anchor} is not a known anchor${pattern ? ` of ${pattern}` : ""}`);
          if (a.mutating) throw new Refused("NOT_PERMITTED", `Step ${n} points at "${a.label}", which changes data; a walkthrough points at what it acts on and leaves the press to the person`);
          if (await hiddenFor(deps.tx, ctx, a)) throw new Refused("UNKNOWN_REFERENCE", `Step ${n}: #${t.anchor} is not in this person's sidebar`);
          selectors = a.selectors;
        }
        out.push({ route, target: t, label: shortLabel(st.label), text: st.text.trim().slice(0, 240), selectors });
      }
      const data: AssistEffect = { effect: "steps", steps: out };
      return { data, summary: `Walkthrough of ${out.length} step${out.length === 1 ? "" : "s"}` };
    },
  };

  return [point, navigate, show, say, handoff, steps] as WeftCommand[];
}
