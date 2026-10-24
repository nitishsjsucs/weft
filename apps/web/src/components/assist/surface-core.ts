// Where the cursor assistant's surfaces may sit, the pure parts (effects.ts, walk.tsx and assistant.tsx read the page and
// call these): the view state a validated link to the page the person is on writes, the room the phone's bottom sheet
// is given above a target, when the floating icon stays out of the way, and which key presses are the assistant's.
import { ASSIST_QUERY_KEYS, routePattern, splitRoute } from "../../../../../packages/contracts/src/ext/assist";

/**
 * The query patch that makes the page the person is on show exactly what a validated link to it says: every view key
 * that page keeps (ASSIST_QUERY_KEYS: a drawer, a tab, a filter, a section) takes the link's value, or is cleared when
 * the link does not give it. A paycheck drawer left open does not stay over the Needs review band a link asks for, and
 * the view matches the same link pasted into the address bar. Keys outside the manifest (the tour's own) are left alone.
 */
export function viewPatch(route: string): Record<string, string | null> {
  const { path, query } = splitRoute(route);
  const pattern = routePattern(path, { hosted: true });
  const kept = (pattern && ASSIST_QUERY_KEYS[pattern]) || {};
  const q = new URLSearchParams(query ?? "");
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(kept)) out[k] = q.get(k);
  return out;
}

/** The bottom sheet's largest height as visuals.tsx FloatingCard draws it on a phone (max-h 60vh, 16 px from the bottom). */
export const SHEET_MAX_VH = 0.6;
const SHEET_INSET = 16;
const SHEET_GAP = 12;

/**
 * The room a phone's bottom sheet takes, at its largest: a target is brought into view above that, so an answer that
 * arrives after the ring (the card grows from Working to the answer, its approval card and chips) never covers it.
 */
export function sheetReserve(viewportHeight: number): number {
  return Math.round(viewportHeight * SHEET_MAX_VH) + SHEET_INSET + SHEET_GAP;
}

export interface IconState {
  /** The person has the icon on (persona menu, settings). */
  on: boolean;
  tour: boolean;
  /** Anything of the assistant's own is open: the composer, a card, a walkthrough, its menu. */
  busy: boolean;
  /** A phone: the icon is docked in the corner and takes taps there. */
  docked: boolean;
  /** On the Agent page, or with the agent panel open (its composer's Send button sits in that corner). */
  agentComposer: boolean;
  /** A modal layer is open (a drawer or dialog, whose footer holds its primary button in that corner). */
  layer: boolean;
}

/**
 * Whether the icon hides. Docked in the corner of a phone it would sit over the right-hand button of whatever fills
 * the screen there (the agent's Send, a drawer's Submit, Propose or Terminate), so it steps aside whenever one is open.
 */
export function iconHidden(s: IconState): boolean {
  return !s.on || s.tour || s.busy || (s.docked && (s.agentComposer || s.layer));
}

export interface IdleState {
  /** The route (path and query) the question was asked from, and the route now. */
  askedFrom: string;
  here: string;
  /** Focus is in a field on the page (not the assistant's own): the person is typing. */
  typing: boolean;
  /** A dialog, drawer, menu or popover is open now, and whether one was open when the question was asked. */
  layerNow: boolean;
  layerThen: boolean;
}

/**
 * Whether a run's closing show (a proposal's approval card ringed in the Inbox) may move the page on its own when the
 * run ends: only while the person is where they asked, typing in nothing, with no layer of their own opened since.
 * A handoff can take many seconds; anyone who moved on keeps their page, and the card offers "Show me" instead.
 */
export function mayShowNow(s: IdleState): boolean {
  return s.here === s.askedFrom && !s.typing && (!s.layerNow || s.layerThen);
}

/** The parts of a keydown the assistant reads. */
export interface KeyPress { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number }

/**
 * A key press still in an input method's composition (Japanese, Chinese, Korean): its Escape cancels the candidate and
 * its keys build the word, so none is the assistant's (Safari reports keyCode 229 instead of isComposing).
 */
export const composing = (e: KeyPress): boolean => !!e.isComposing || e.keyCode === 229;

/**
 * Ctrl or Cmd J. The physical J key (e.code) counts only when the layout puts no Latin letter there (a Russian, Greek or
 * Hebrew layout): on Dvorak or Colemak that key types H or N, and Ctrl H or Ctrl N stays the browser's.
 */
export function isAssistHotkey(e: KeyPress): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || composing(e)) return false;
  return e.key.toLowerCase() === "j" || (e.code === "KeyJ" && !/^[a-z]$/i.test(e.key));
}
