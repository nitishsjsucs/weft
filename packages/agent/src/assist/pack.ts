// The assist recipe's context pack (research/cursor-assistant.md 4.2 and 4.3; packages/contracts/src/ext/assist.ts).
// Rendered once per run like the chat pack: the run clock and the person, the screen map as a numbered element table
// (about 1,500 tokens at most), the intents the page offers, what the pointer is on, the records the page already
// holds, the last few things that happened, the thread's earlier turns, and the request. Labels, values and selected
// text that came from what people typed (screen items, the cursor's refs, record fields and trail events flagged
// untrusted, and the selection) reach the model only inside an untrusted element with the run nonce (the run is
// tainted by apps/api before it starts). The <derived> block repeats the code-read facts as JSON, as routine packs
// do, for the scripted stand-in.
import {
  ASSIST_INTENTS, intentDef, screenTable, SCREEN_LIMITS, type AssistInput, type RecordSummary, type TrailEvent,
} from "../../../contracts/src/ext/assist";
import { canonicalJson, escapeTagText } from "../canonical";
import { approxTokens } from "../context";

/** Untrusted text cannot close or forge a harness tag from inside (harness 6.3): every angle bracket is escaped. */
function untrusted(text: string, nonce: string, source: string): string {
  return `<untrusted n="${nonce}" source="${source}">${escapeTagText(text)}</untrusted>`;
}

/** JSON inside a tag: angle brackets as JSON escapes, so the block parses to the same value and closes nothing. */
const jsonInTag = (v: unknown) => canonicalJson(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

export interface AssistPackInput {
  nonce: string; now: string; actingFor: string; grants: Record<string, string>; request: string; assist: AssistInput;
  /** The thread's earlier turns (threads.ts earlierConversationBlock), when the exchange continues a conversation. */
  earlier?: string;
}

const typedRefs = (c: AssistInput["cursor"]) => [c.under, ...c.trail, c.focused, c.layer].filter((r) => r?.untrusted && r.label.trim());

/**
 * Whether the request carries text people typed, and where from: the selection, an untrusted screen label, a cursor
 * ref (under, rested on, focused, the open layer), a record field or a trail event. apps/api taints the run when it does.
 */
export function assistUntrustedSource(a: AssistInput): string | null {
  if (a.cursor.selection?.text.trim()) return "screen:selection";
  if (a.screen.items.some((i) => i.untrusted && i.label.trim())) return "screen:labels";
  if (typedRefs(a.cursor).length) return "screen:cursor";
  if (a.records.some((r) => r.rows.some((row) => row.fields.some((f) => f.untrusted && f.value.trim())))) return "screen:records";
  if (a.trail.some((t) => t.untrusted && t.label.trim())) return "screen:trail";
  return null;
}

const ago = (s: number) => (s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);

const UNTRUSTED_VALUE = "(untrusted, below)";

function recordsBlock(records: readonly RecordSummary[], budget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const r of records) {
    const head = `${escapeTagText(r.source)} (${r.count}):`;
    const rows = r.rows.map((row) => `  ${row.id} ${row.fields.map((f) => `${f.name}=${f.untrusted ? UNTRUSTED_VALUE : escapeTagText(f.value).replace(/\s+/g, " ")}`).join(" ")}`);
    for (const l of [head, ...rows]) {
      if (used + l.length + 1 > budget) return [...lines, "  (more not shown)"].join("\n");
      lines.push(l);
      used += l.length + 1;
    }
  }
  return lines.join("\n");
}

function trailBlock(trail: readonly TrailEvent[]): string {
  return trail.map((t) => `- ${ago(t.agoS)} ${t.kind}: ${t.untrusted ? UNTRUSTED_VALUE : escapeTagText(t.label)}${t.route ? ` (${escapeTagText(t.route)})` : ""}`).join("\n");
}

/** The intents line: the page's own intents first, then the global ones (they open their page first). */
export function intentsLine(offered: readonly string[]): string {
  const page = offered.map((id) => intentDef(id)).filter((d): d is NonNullable<typeof d> => !!d && d.scope === "page");
  const global = ASSIST_INTENTS.filter((d) => d.scope === "global");
  return [`page: ${page.map((d) => d.hint).join(", ") || "none"}`, `any page: ${global.map((d) => d.hint).join(", ")}`].join("\n");
}

export const ASSIST_BUDGET_TOKENS = 3_500;

export function assistPack(p: AssistPackInput): string {
  const a = p.assist;
  const grants = Object.keys(p.grants).sort().map((k) => `${k}=${p.grants[k]}`).join(", ") || "none";
  const s = a.screen;
  const table = screenTable(s.items, SCREEN_LIMITS.tableChars, s.route);
  const labels = s.items.filter((i) => i.untrusted && i.label.trim()).map((i) => `[${i.n}] ${i.label}`);
  const c = a.cursor;
  const label = (r: { label: string; untrusted?: boolean | undefined }) => (r.untrusted ? UNTRUSTED_VALUE : JSON.stringify(r.label.slice(0, SCREEN_LIMITS.label)));
  const ref = (r: { entity: string; kind: string; label: string; n?: number | null; untrusted?: boolean | undefined }) => `${r.n ? `[${r.n}] ` : ""}${r.kind} ${label(r)} ${r.entity}`;
  const cursor = [
    `under: ${c.under ? ref(c.under) : "nothing tagged"}`,
    c.trail.length ? `rested on: ${c.trail.map(ref).join("; ")}` : null,
    c.focused ? `focused: ${c.focused.n ? `[${c.focused.n}] ` : ""}${c.focused.kind} ${label(c.focused)}` : null,
    c.layer ? `open ${c.layer.kind}: ${label(c.layer)}` : null,
    `view: tab ${c.view.tab ?? "none"}${c.view.selected ? `, selected ${c.view.selected}` : ""}${c.view.filters.length ? `, filters ${c.view.filters.map((f) => `${f.name}=${f.value}`).join(" ")}` : ""}`,
    c.selection?.text.trim() ? "selection: the person selected text on the page (below, untrusted)" : null,
  ].filter(Boolean).map((l) => escapeTagText(l!)).join("\n");
  const derived = {
    route: s.route, tab: s.tab, under: c.under ? { entity: c.under.entity, kind: c.under.kind, n: c.under.n ?? null } : null,
    selected: c.view.selected, intents: s.intents.filter((id) => !!intentDef(id)),
  };
  const head = [
    `now: ${p.now}`,
    `acting_for: ${p.actingFor}`,
    `grants: ${grants}`,
    `page: ${escapeTagText(s.route)} | ${escapeTagText(s.title)}${s.tab ? ` | tab ${escapeTagText(s.tab)}` : ""} | window ${s.viewport[0]}x${s.viewport[1]}`,
  ].join("\n");
  // Every line is escaped like the other blocks: a label, a state or an anchor the client sent can never close
  // <screen> or forge a <request> (harness 6.3). The derived JSON keeps its brackets
  // as JSON escapes (the route, tab and kind are client strings).
  const screen = `<screen items="${s.items.length}"${table.dropped || s.truncated ? ` truncated="true"` : ""}>\n${table.lines.map(escapeTagText).join("\n")}\n</screen>`;
  const intents = `<intents>\n${intentsLine(s.intents)}\n</intents>`;
  const request = `<request>${escapeTagText(p.request)}</request>`;
  const fixed = [head, screen, intents, `<cursor>\n${cursor}\n</cursor>`, `<derived>${jsonInTag(derived)}</derived>`].join("\n");
  // Records and the trail fill what is left of the budget; the request and the screen map are never cut here.
  const room = Math.max(400, (ASSIST_BUDGET_TOKENS - approxTokens(fixed) - approxTokens(request)) * 4);
  const records = a.records.length ? `<records>\n${recordsBlock(a.records, Math.floor(room * 0.75))}\n</records>` : "";
  const trail = a.trail.length ? `<trail>\n${trailBlock(a.trail).slice(0, Math.floor(room * 0.25))}\n</trail>` : "";
  // What people typed, each source in its own untrusted element: never in the table, the cursor block, records or the trail.
  const refsTyped = [
    ...(c.under?.untrusted ? [`under ${c.under.entity}: ${c.under.label}`] : []),
    ...c.trail.filter((r) => r.untrusted).map((r) => `rested on ${r.entity}: ${r.label}`),
    ...(c.focused?.untrusted ? [`focused: ${c.focused.label}`] : []),
    ...(c.layer?.untrusted ? [`open ${c.layer.kind}: ${c.layer.label}`] : []),
  ];
  const fieldsTyped = a.records.flatMap((r) => r.rows.flatMap((row) => row.fields.filter((f) => f.untrusted).map((f) => `${row.id} ${f.name}=${f.value}`)));
  const trailTyped = a.trail.filter((t) => t.untrusted).map((t) => `${ago(t.agoS)} ${t.kind}: ${t.label}`);
  const typed = [
    labels.length ? untrusted(labels.join("\n"), p.nonce, "screen:labels") : "",
    refsTyped.length ? untrusted(refsTyped.join("\n"), p.nonce, "screen:cursor") : "",
    fieldsTyped.length ? untrusted(fieldsTyped.join("\n"), p.nonce, "screen:records") : "",
    trailTyped.length ? untrusted(trailTyped.join("\n"), p.nonce, "screen:trail") : "",
    c.selection?.text.trim() ? untrusted(c.selection.text, p.nonce, "screen:selection") : "",
  ].filter(Boolean).join("\n");
  return [`<context n="${p.nonce}">`, fixed, records, trail, typed, p.earlier ?? "", request, `</context>`].filter(Boolean).join("\n");
}
