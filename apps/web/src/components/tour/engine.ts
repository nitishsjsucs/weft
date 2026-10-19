// The tour's state machine, persistence and preflight (owner: tour). Pure: no React, no DOM beyond a Storage-like
// object, so vitest drives it with fakes. tour-provider.tsx wires it to the router, the API and the shell bridge.
//
// idle > preflight > (reset dialog) > running{step, phase} > done. A reload mid-tour comes back as "resume".
import { TOUR_STEPS, TOUR_STATE_KEY, TOUR_SEEN_KEY, stepIndex, type TourMemo } from "./steps";

export type TourPhase = "navigating" | "locating" | "ready" | "acting" | "waiting";
export type TourStatus = "idle" | "preflight" | "reset" | "resume" | "running" | "done";

/** What survives a reload (sessionStorage weft.tour.v1). */
export interface TourPersisted {
  stepId: string;
  startedAt: number;
  memo: TourMemo;
  autoplay: boolean;
  prevPrincipal: string | null;
  prevAgentOpen: boolean | null;
}

export interface TourState extends TourPersisted {
  status: TourStatus;
  phase: TourPhase;
  /** Why preflight offered the reset dialog (for the dialog and tests). */
  resetReasons: string[];
  /** Where the reset dialog was opened from: the start of a tour, or the menu / close step. */
  resetFrom: "start" | "menu" | null;
  /** The status a Cancel returns to. */
  resetReturn: TourStatus;
}

export type TourEvent =
  | { type: "start"; at: number; prevPrincipal: string | null; prevAgentOpen: boolean | null; autoplay?: boolean; stepId?: string }
  | { type: "preflight-done"; reasons: string[] }
  | { type: "open-reset"; from: "start" | "menu" }
  | { type: "reset-done"; at: number }
  | { type: "reset-skip"; at: number }
  | { type: "reset-cancel" }
  | { type: "resume"; persisted: TourPersisted; auto?: boolean }
  | { type: "resume-accept" }
  | { type: "phase"; phase: TourPhase }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; stepId: string }
  | { type: "memo"; patch: Partial<TourMemo> }
  | { type: "autoplay"; on: boolean }
  | { type: "replay"; at: number }
  | { type: "exit" };

export const IDLE: TourState = {
  status: "idle", phase: "navigating", stepId: TOUR_STEPS[0]!.id, startedAt: 0, memo: {}, autoplay: false,
  prevPrincipal: null, prevAgentOpen: null, resetReasons: [], resetFrom: null, resetReturn: "idle",
};

const firstId = TOUR_STEPS[0]!.id;
const validId = (id: string | undefined) => (id && stepIndex(id) >= 0 ? id : firstId);

export function reduce(s: TourState, e: TourEvent): TourState {
  switch (e.type) {
    case "start":
      return { ...IDLE, status: "preflight", stepId: validId(e.stepId), startedAt: e.at, autoplay: !!e.autoplay, prevPrincipal: e.prevPrincipal, prevAgentOpen: e.prevAgentOpen };
    case "preflight-done":
      if (s.status !== "preflight") return s;
      return e.reasons.length ? { ...s, status: "reset", resetReasons: e.reasons, resetFrom: "start" } : { ...s, status: "running", phase: "navigating" };
    case "open-reset":
      return { ...s, status: "reset", resetFrom: e.from, resetReasons: [], resetReturn: s.status === "running" ? "running" : "idle" };
    case "reset-done":
      // A reset always starts the tour from step 1 on the fresh world, with a fresh memo and clock.
      return { ...s, status: "running", phase: "navigating", stepId: firstId, memo: {}, startedAt: e.at, resetReasons: [], resetFrom: null };
    case "reset-skip":
      return { ...s, status: "running", phase: "navigating", startedAt: s.resetFrom === "start" ? e.at : s.startedAt, resetReasons: [], resetFrom: null };
    case "reset-cancel":
      // Cancel from the menu or the close step: back to wherever we were (a running tour keeps going, else idle).
      return { ...s, status: s.resetReturn, resetFrom: null, resetReasons: [] };
    case "resume":
      // auto: the reload was the tour's own navigation (Next fell back to a full page load), so it carries on.
      return { ...IDLE, ...e.persisted, stepId: validId(e.persisted.stepId), status: e.auto ? "running" : "resume", phase: "navigating" };
    case "resume-accept":
      return s.status === "resume" ? { ...s, status: "running", phase: "navigating" } : s;
    case "phase":
      return s.status === "running" ? { ...s, phase: e.phase } : s;
    case "next": {
      if (s.status !== "running") return s;
      const i = stepIndex(s.stepId);
      if (i >= TOUR_STEPS.length - 1) return { ...s, status: "done" };
      return { ...s, stepId: TOUR_STEPS[i + 1]!.id, phase: "navigating" };
    }
    case "back": {
      if (s.status !== "running") return s;
      const i = stepIndex(s.stepId);
      return i <= 0 ? s : { ...s, stepId: TOUR_STEPS[i - 1]!.id, phase: "navigating" };
    }
    case "goto":
      return s.status === "running" ? { ...s, stepId: validId(e.stepId), phase: "navigating" } : s;
    case "memo":
      return { ...s, memo: { ...s.memo, ...e.patch } };
    case "autoplay":
      return { ...s, autoplay: e.on };
    case "replay":
      return { ...s, status: "preflight", stepId: firstId, memo: {}, startedAt: e.at, phase: "navigating" };
    case "exit":
      return { ...IDLE, prevPrincipal: s.prevPrincipal, prevAgentOpen: s.prevAgentOpen };
  }
}

// ---- persistence (every access in try/catch) -----------------------------------------------------------------

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function persisted(s: TourState): TourPersisted {
  return { stepId: s.stepId, startedAt: s.startedAt, memo: s.memo, autoplay: s.autoplay, prevPrincipal: s.prevPrincipal, prevAgentOpen: s.prevAgentOpen };
}

export function saveTour(store: StorageLike | null, s: TourState): void {
  try {
    if (!store) return;
    if (s.status === "running" || s.status === "resume") store.setItem(TOUR_STATE_KEY, JSON.stringify(persisted(s)));
    else if (s.status === "idle" || s.status === "done") store.removeItem(TOUR_STATE_KEY);
  } catch { /* storage blocked */ }
}

export function loadTour(store: StorageLike | null): TourPersisted | null {
  try {
    const raw = store?.getItem(TOUR_STATE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<TourPersisted>;
    if (typeof v.stepId !== "string" || stepIndex(v.stepId) < 0) return null;
    return {
      stepId: v.stepId, startedAt: Number(v.startedAt) || 0, memo: v.memo && typeof v.memo === "object" ? v.memo : {},
      autoplay: !!v.autoplay, prevPrincipal: typeof v.prevPrincipal === "string" ? v.prevPrincipal : null,
      prevAgentOpen: typeof v.prevAgentOpen === "boolean" ? v.prevAgentOpen : null,
    };
  } catch { return null; }
}

// ---- the tour's own navigations ------------------------------------------------------------------------------

/** sessionStorage key for the route change the tour just asked for, so a full page load it caused is not a "resume". */
export const TOUR_NAV_KEY = "weft.tour.nav";
/** How long after a tour navigation a page load still counts as that navigation. */
export const OWN_NAV_MS = 30_000;

export function markNavigation(store: StorageLike | null, path: string, at: number): void {
  try { store?.setItem(TOUR_NAV_KEY, JSON.stringify({ path, at })); } catch { /* blocked */ }
}

/** Reads and clears the navigation mark: true when this page load is the tour's own hop to `pathname`. */
export function takeOwnNavigation(store: StorageLike | null, pathname: string, now: number): boolean {
  try {
    const raw = store?.getItem(TOUR_NAV_KEY);
    store?.removeItem(TOUR_NAV_KEY);
    if (!raw) return false;
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown };
    return v.path === pathname && typeof v.at === "number" && now - v.at >= 0 && now - v.at <= OWN_NAV_MS;
  } catch { return false; }
}

export function clearNavigation(store: StorageLike | null): void { try { store?.removeItem(TOUR_NAV_KEY); } catch { /* blocked */ } }

export function clearTour(store: StorageLike | null): void { try { store?.removeItem(TOUR_STATE_KEY); store?.removeItem(TOUR_NAV_KEY); } catch { /* blocked */ } }
export function markSeen(store: StorageLike | null): void { try { store?.setItem(TOUR_SEEN_KEY, "1"); } catch { /* blocked */ } }
export function hasSeen(store: StorageLike | null): boolean { try { return store?.getItem(TOUR_SEEN_KEY) === "1"; } catch { return true; } }

// ---- preflight ------------------------------------------------------------------------------------------------

export const SEED_NOW = "2026-10-26T15:30:00.000Z";

export interface PreflightFacts {
  seedProfile: string | null | undefined;
  clockNow: string | null | undefined;
  noticeForms: string[];
  pendingCommands: (string | null)[];
}

/** Reasons the world does not suit the tour; empty means start straight away. */
export function preflightReasons(f: PreflightFacts): string[] {
  const out: string[] = [];
  if (f.seedProfile !== "rich") out.push("The demo data is the base world, not the rich tour world.");
  if (f.noticeForms.some((x) => /DE ?2088/i.test(x))) out.push("The DE 2088 notice was already delivered.");
  if (f.clockNow && Date.parse(f.clockNow) !== Date.parse(SEED_NOW)) out.push("The simulated clock has moved since the seed.");
  if (f.pendingCommands.includes("tax.update_rate")) out.push("A rate change is already waiting in the Inbox.");
  return out;
}

/** Reads the preflight facts through a fetcher that returns parsed JSON or throws. */
export async function readPreflight(get: (path: string) => Promise<unknown>): Promise<PreflightFacts> {
  const safe = async <T>(p: string, fb: T): Promise<T> => { try { return ((await get(p)) as T) ?? fb; } catch { return fb; } };
  const [health, clock, notices, props] = await Promise.all([
    safe<{ seedProfile?: string | null }>("/v1/health", {}),
    safe<{ now?: string }>("/v1/sim/clock", {}),
    safe<{ data?: { formCode?: string }[] }>("/v1/notices?limit=100", {}),
    safe<{ data?: { command?: string | null }[] }>("/v1/proposals?status=pending&limit=100", {}),
  ]);
  return {
    seedProfile: health.seedProfile ?? null,
    clockNow: clock.now ?? null,
    noticeForms: (notices.data ?? []).map((n) => n.formCode ?? ""),
    pendingCommands: (props.data ?? []).map((p) => p.command ?? null),
  };
}

// ---- exit and reset helpers (pure, so the unit tests cover them) --------------------------------------------

/** What exit or finish puts back: the principal and agent panel the person had before the tour (null: leave it). */
export function restorePlan(s: Pick<TourState, "prevPrincipal" | "prevAgentOpen">, currentPrincipal: string): { principal: string | null; agentOpen: boolean | null } {
  return { principal: s.prevPrincipal && s.prevPrincipal !== currentPrincipal ? s.prevPrincipal : null, agentOpen: s.prevAgentOpen };
}

/** The reset dialog's error line for a failed POST /v1/sim/reset. */
export function resetErrorText(status: number | null, tag: string | null, message: string, disabledCopy: string): string {
  if (status === 501) return disabledCopy;
  return tag ? `${tag}: ${message}` : message;
}
