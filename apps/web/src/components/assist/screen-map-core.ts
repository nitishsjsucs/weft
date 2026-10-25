// The screen map, pure (research/cursor-assistant.md 4.2; ext/assist.ts ScreenMap): candidates the DOM walker found
// become a numbered table of the visible meaningful elements, at most SCREEN_LIMITS.items and within the table
// budget (about 1,500 tokens). Elements with Weft's own anchors, records and roles rank first when the page has more
// than fits; the kept ones are numbered in reading order. A label that came from text people typed is kept only as
// untrusted (the pack wraps it and the run is tainted). Each item keeps the candidate's key, so the client's registry
// maps [n] back to the live element.
import { screenTable, SCREEN_LIMITS, type ScreenItem, type ScreenItemKind, type ScreenMap } from "../../../../../packages/contracts/src/ext/assist";

export interface Candidate {
  /** The walker's index of the live element. */
  key: number;
  kind: ScreenItemKind;
  label: string;
  entity?: string | null;
  entityKind?: string | null;
  anchor?: string | null;
  testid?: string | null;
  box: [number, number, number, number];
  state?: string | null;
  untrusted?: boolean;
  /** Where the link the element is or sits in goes (dom.ts hrefOf). */
  href?: string | null;
  /** The element is or sits in [data-assist-mutating]. */
  mutating?: boolean;
}

/** How much a candidate says about the page: Weft's anchors and records first, then controls, then structure. */
export function priorityOf(c: Candidate): number {
  let p = 0;
  if (c.anchor) p += 6;
  if (c.entity) p += 5;
  if (c.kind === "tab" || c.kind === "dialog") p += 4;
  if (c.kind === "row" || c.kind === "card" || c.kind === "section") p += 3;
  if (c.kind === "button" || c.kind === "link" || c.kind === "disclosure" || c.kind === "chip" || c.kind === "menuitem") p += 2;
  if (c.kind === "heading") p += 2;
  if (c.testid) p += 1;
  if (c.kind === "landmark" || c.kind === "nav") p += 1;
  return p;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const area = (b: Candidate["box"]) => Math.max(0, b[2]) * Math.max(0, b[3]);
function overlap(a: Candidate["box"], b: Candidate["box"]): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const i = x * y;
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

export interface BuiltMap { screen: ScreenMap; keys: Map<number, number> }

export function buildScreenMap(cands: readonly Candidate[], page: { route: string; title: string; tab: string | null; viewport: [number, number]; intents: string[] }, limits = SCREEN_LIMITS): BuiltMap {
  // 1. Clean labels; drop what says nothing (no label, no record, no anchor) and boxes with no area.
  const pool = cands.map((c) => ({ ...c, label: clean(c.label).slice(0, limits.label) })).filter((c) => area(c.box) > 0 && (c.label || c.entity || c.anchor));
  // 2. The same control twice (a wrapper and its child with the same label and nearly the same box): keep the better one.
  const kept: typeof pool = [];
  for (const c of [...pool].sort((a, b) => priorityOf(b) - priorityOf(a))) {
    if (kept.some((k) => k.label === c.label && k.kind === c.kind && overlap(k.box, c.box) > 0.8)) continue;
    kept.push(c);
  }
  // 3. The best ones that fit, numbered in reading order (top to bottom, then left to right).
  let chosen = kept.slice(0, limits.items);
  const number = (xs: typeof chosen): ScreenItem[] => [...xs]
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
    .map((c, i) => ({
      n: i + 1, kind: c.kind, label: c.label, box: c.box.map((v) => Math.round(v)) as ScreenItem["box"],
      ...(c.entity ? { entity: c.entity } : {}), ...(c.entityKind ? { entityKind: c.entityKind.slice(0, 24) } : {}), ...(c.anchor ? { anchor: c.anchor } : {}),
      ...(c.testid ? { testid: c.testid.slice(0, 64) } : {}), ...(c.state ? { state: c.state.slice(0, 24) } : {}), ...(c.untrusted ? { untrusted: true } : {}),
      ...(c.href ? { href: c.href.slice(0, limits.route) } : {}), ...(c.mutating ? { mutating: true } : {}),
    }));
  let items = number(chosen);
  let truncated = kept.length > chosen.length;
  // 4. Within the table budget: drop the lowest ranked until every line fits (numbers stay dense and in order).
  while (items.length && screenTable(items, limits.tableChars).dropped > 0) {
    chosen = chosen.slice(0, -1);
    items = number(chosen);
    truncated = true;
  }
  const byPos = [...chosen].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  const keys = new Map<number, number>(byPos.map((c, i) => [i + 1, c.key]));
  return {
    screen: { route: page.route.slice(0, limits.route), title: clean(page.title).slice(0, limits.title), tab: page.tab ? page.tab.slice(0, 40) : null, items, intents: page.intents.slice(0, limits.intents), truncated, viewport: page.viewport },
    keys,
  };
}
