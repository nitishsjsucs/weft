// The client's own check before a show action touches a live element (ext/assist.ts showRefusal runs on the server
// too): the same allowlist of control kinds and denylist of words and test ids, plus what only the live element says:
// a submit button, a control inside a form, anything marked data-assist-mutating, and where a link it is or sits in
// really goes. A refusal here stops the effect even when the server allowed it (the page may have changed since the
// screen map was built).
import { checkRoute, showRefusal, type ScreenItemKind } from "../../../../../packages/contracts/src/ext/assist";

export interface LiveControl {
  tag: string;
  kind: ScreenItemKind;
  label: string;
  testid: string | null;
  anchor: string | null;
  /** The type attribute of a button or input. */
  type: string | null;
  inForm: boolean;
  marked: boolean;
  /** The record the element shows (data-entity), when it shows one. */
  entity?: string | null;
  /** Where the link the element is or sits in goes (hrefOf: path and query in the app, else the URL as written). */
  href?: string | null;
}

export function liveShowRefusal(c: LiveControl, action: string, opts: { hosted?: boolean } = {}): string | null {
  const base = showRefusal({ kind: c.kind, label: c.label, testid: c.testid, anchor: c.anchor, entity: c.entity ?? null, href: c.href ?? null }, action, opts);
  if (base) return base;
  if (action === "scroll") return null;
  if (c.marked) return `"${c.label}" is marked as a control that changes data`;
  if ((c.tag === "BUTTON" || c.tag === "INPUT") && (c.type === "submit" || c.inForm) && c.kind !== "tab") return `"${c.label}" submits a form`;
  if (c.tag === "INPUT" || c.tag === "TEXTAREA" || c.tag === "SELECT") return "show never types into or changes a field";
  return null;
}

/**
 * The route a show "open" on this element goes to instead of a click, or null when it is not a link: the link's own
 * route, validated by checkRoute. A link that leaves the registry is refused by liveShowRefusal before this is read.
 */
export function linkRoute(c: Pick<LiveControl, "href">, opts: { hosted?: boolean } = {}): string | null {
  if (!c.href) return null;
  const r = checkRoute(c.href, opts);
  return r.ok ? r.route : null;
}
