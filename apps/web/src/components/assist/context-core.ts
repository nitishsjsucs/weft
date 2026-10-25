// What the pointer and the page say about a question (the cursor assistant's cursor context, ext/assist.ts
// AssistCursor), as pure functions over attributes and times: the entity an element shows (its data-entity, or the
// ids the app already puts in its attributes and test ids), the hover trail (the last entities the pointer rested
// on for at least 300 ms) and the view state the URL holds (tab, filters, the selected record). context.ts reads the
// DOM and calls these.
import { ASSIST_QUERY_KEYS, ENTITY_RE, queryNeedProblem, queryProblem, routePattern, SCREEN_LIMITS, type AssistCursor, type EntityRef } from "../../../../../packages/contracts/src/ext/assist";

/** What each id prefix names, for an element that carries an id but no data-entity-kind. */
export const PREFIX_KIND: Readonly<Record<string, string>> = {
  wrk_: "worker", prp_: "proposal", pay_: "pay_run", pyc_: "paycheck", exp_: "expense", tor_: "time_off_request", ntc_: "notice", run_: "run",
  rt_: "routine", rtr_: "routine_run", offr_: "offer", thr_: "thread", ofb_: "offboarding_case", act_: "action", doc_: "document", txa_: "tax_account",
};
const kindOf = (id: string): string => {
  const p = Object.keys(PREFIX_KIND).filter((k) => id.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return p ? PREFIX_KIND[p]! : "record";
};

export interface EntityAttrs { entity?: string | null; entityKind?: string | null; proposalId?: string | null; runId?: string | null; testid?: string | null }

/**
 * The record an element shows, or null: data-entity first (with data-entity-kind), then data-proposal-id and
 * data-run-id, then a test id that ends in an id (payroll-row-wrk_0026 on a pay run page is that run's paycheck).
 */
export function entityFromAttrs(a: EntityAttrs, route = ""): { entity: string; kind: string } | null {
  const ok = (v: string | null | undefined): v is string => !!v && ENTITY_RE.test(v);
  // A run's paycheck is named by the run and the person ("pay_2026_10_30:wrk_0026").
  if (ok(a.entity)) return { entity: a.entity, kind: a.entityKind?.slice(0, 24) || (/^pay_[^:]+:wrk_/.test(a.entity) ? "paycheck" : kindOf(a.entity.split(":").pop()!)) };
  if (ok(a.proposalId)) return { entity: a.proposalId, kind: "proposal" };
  if (ok(a.runId)) return { entity: a.runId, kind: "run" };
  const m = a.testid ? /(?:^|-)([a-z]{2,5}_[A-Za-z0-9_]+)$/.exec(a.testid) : null;
  if (!m || !ok(m[1])) return null;
  const id = m[1];
  const run = /^\/app\/payroll\/(pay_[A-Za-z0-9_]+)/.exec(route)?.[1];
  if (run && a.testid!.startsWith("payroll-row-") && id.startsWith("wrk_")) return { entity: `${run}:${id}`, kind: "paycheck" };
  return { entity: id, kind: kindOf(id) };
}

/** The last entities the pointer rested on for at least `restMs`, newest first, each once. */
export function createHoverTrail(restMs = 300, max: number = SCREEN_LIMITS.hoverTrail) {
  let current: { ref: EntityRef; since: number; recorded: boolean } | null = null;
  let list: EntityRef[] = [];
  const record = () => {
    if (!current || current.recorded) return;
    current.recorded = true;
    list = [current.ref, ...list.filter((r) => r.entity !== current!.ref.entity)].slice(0, max);
  };
  return {
    /** The entity under the pointer now (null: nothing tagged), at time `t`. */
    update(ref: EntityRef | null, t: number): void {
      if (current && t - current.since >= restMs) record();
      if (!ref) { current = null; return; }
      if (current?.ref.entity === ref.entity) return;
      current = { ref, since: t, recorded: false };
    },
    list(t: number): EntityRef[] {
      if (current && t - current.since >= restMs) record();
      return list;
    },
    clear(): void { current = null; list = []; },
  };
}

/** The view state a page keeps in its URL: the tab, its filters and the record it has open (ext/assist.ts ASSIST_QUERY_KEYS). */
export function viewFromLocation(pathname: string, search: string): AssistCursor["view"] {
  const pattern = routePattern(pathname, { hosted: true });
  const allowed = pattern ? ASSIST_QUERY_KEYS[pattern] ?? {} : {};
  const q = new URLSearchParams(search);
  // Only a value of the key's own shape: text in a link someone sent is not the page's view state (the server drops
  // it again, cleanView).
  const fits = (k: string, v: string | null): v is string => !!v && Object.hasOwn(allowed, k) && !queryProblem(allowed[k]!, v);
  const tab = fits("tab", q.get("tab")) ? q.get("tab")! : null;
  // A filter the page reads only on another tab (the compliance calendar's) is not in view.
  const filters = [...q.entries()].filter(([k, v]) => k.startsWith("filter.") && fits(k, v) && !(pattern && queryNeedProblem(pattern, k, (x) => q.get(x)))).map(([k, v]) => ({ name: k.slice("filter.".length).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32) || "filter", value: v.slice(0, 60) })).slice(0, 6);
  const run = /^\/app\/payroll\/(pay_[A-Za-z0-9_]+)/.exec(pathname)?.[1];
  let selected: string | null = null;
  for (const key of ["paycheck", "proposal", "expense", "notice", "thread", "run"]) {
    const v = q.get(key);
    if (!fits(key, v)) continue;
    const id = key === "paycheck" && run ? `${run}:${v}` : v;
    if (ENTITY_RE.test(id)) { selected = id; break; }
  }
  return { tab, filters, selected };
}

/**
 * Where a composer opened from the keyboard (Ctrl or Cmd J) takes its place and its record from: the focused control
 * when keyboard navigation moved focus after the pointer last moved (or the pointer never did), else the pointer, else
 * neither. Times are performance.now() values, null when that never happened.
 */
export function keyboardOrigin(s: { pointerAt: number | null; focusAt: number | null; focused: boolean }): "focus" | "pointer" | "none" {
  if (s.focused && (s.pointerAt === null || (s.focusAt !== null && s.focusAt > s.pointerAt))) return "focus";
  return s.pointerAt !== null ? "pointer" : "none";
}
