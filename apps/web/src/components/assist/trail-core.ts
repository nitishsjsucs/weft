// The interaction trail (the last few things that happened in the app: navigations, opened items, errors and notes
// shown, the assistant's own questions and effects), so "what did I just do" or "why did that fail" can be answered.
// Pure: a ring buffer with times, and how a page change or a change of the URL's view state reads in it; trail.ts
// feeds it from the page.
import { ASSIST_QUERY_KEYS, assistPageName, queryProblem, routePattern, SCREEN_LIMITS, type TrailEvent } from "../../../../../packages/contracts/src/ext/assist";

export interface TrailItem { kind: TrailEvent["kind"]; label: string; route: string | null; at: number }

export function createTrail(max: number = SCREEN_LIMITS.trail) {
  let items: TrailItem[] = [];
  return {
    push(e: Omit<TrailItem, "at">, at: number): void {
      const label = e.label.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!label) return;
      const top = items[0];
      // The same event again (a poll re-rendering an alert) stays one entry, with its first time.
      if (top && top.kind === e.kind && top.label === label && top.route === e.route) return;
      items = [{ ...e, label, at }, ...items].slice(0, max);
    },
    list(now: number): TrailEvent[] {
      return items.map((i) => ({ kind: i.kind, label: i.label, route: i.route, agoS: Math.max(0, Math.min(86_400, Math.round((now - i.at) / 1000))) }));
    },
    clear(): void { items = []; },
  };
}
export type Trail = ReturnType<typeof createTrail>;

/** "Payroll", "Pay run pay_2026_10_30", or the sidebar page a path of no record's shape sits under ("People"). */
export function pageName(path: string): string {
  return assistPageName(path, { hosted: true });
}

/** The query keys that name an open record, and what the trail calls each. */
const OPENED: Readonly<Record<string, string>> = { paycheck: "paycheck", expense: "expense claim", proposal: "proposal", notice: "notice", thread: "conversation", run: "run" };

/**
 * Compares two queries of the same page (`path`) and records what changed (a drawer, a tab, a filter). Only keys the
 * page keeps with values of their shape are read (ASSIST_QUERY_KEYS): text a link carried is never written into the
 * trail as something the person did.
 */
export function viewChanges(before: URLSearchParams, after: URLSearchParams, path = ""): { kind: TrailEvent["kind"]; label: string }[] {
  const pattern = routePattern(path, { hosted: true });
  const allowed = (pattern && ASSIST_QUERY_KEYS[pattern]) || {};
  const val = (q: URLSearchParams, k: string): string | null => { const v = q.get(k); return v && Object.hasOwn(allowed, k) && !queryProblem(allowed[k]!, v) ? v : null; };
  const out: { kind: TrailEvent["kind"]; label: string }[] = [];
  for (const [k, word] of Object.entries(OPENED)) {
    const a = val(before, k), b = val(after, k);
    if (a === b) continue;
    if (b) out.push({ kind: "open", label: `Opened ${word} ${b}` });
    else if (a) out.push({ kind: "close", label: `Closed ${word} ${a}` });
  }
  const ta = val(before, "tab"), tb = val(after, "tab");
  if (ta !== tb) out.push({ kind: "open", label: tb ? `Switched to the ${tb} tab` : "Switched to the first tab" });
  const sb = val(after, "section");
  if (val(before, "section") !== sb && sb) out.push({ kind: "open", label: `Showed the ${sb} section` });
  const keys = new Set([...before.keys(), ...after.keys()].filter((k) => k.startsWith("filter.")));
  for (const k of keys) {
    const a = val(before, k), b = val(after, k);
    if (a === b) continue;
    out.push({ kind: "open", label: b ? `Filtered by ${k.slice("filter.".length)}: ${b}` : `Cleared the ${k.slice("filter.".length)} filter` });
  }
  return out;
}
