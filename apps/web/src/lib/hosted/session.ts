// The hosted visitor session (docs/cloudflare/design.md 6.2): which world this tab reads (the shared showcase or the
// visitor's own leased slot), the lease and its countdown, the human grant mutations need, and the screens that follow
// a lease ending, a full pool or a spent day budget. The cookies are HttpOnly and set by the front Worker; this module
// only reads GET /api/_session and posts Turnstile tokens. Nothing here runs on Node.
import {
  HOSTED_PATHS, HOSTED_SETTINGS, type HostedErrorBody, type LeaseInfo, type LeaseResult, type LiveMessage, type SessionStatus, type VerifyResult,
} from "../../../../../packages/contracts/src/ext/cf-hosted";
import { invalidate, onInvalidate } from "../api/invalidate";
import { scheduler } from "../api/poll";
import { LiveFeed, liveUrl } from "./feed";
import { HUMAN_CHECK_WAIT_MS } from "./flags";
import { writeLeaseHint } from "./hint";
import { createStore } from "./store";

export type BlockedResult = Exclude<LeaseResult, { status: "leased" }>;
export type EndedReason = "expired" | "server" | "reset_elsewhere";

export interface HostedState {
  status: SessionStatus | null;
  loaded: boolean;
  error: string | null;
  /** The last session read failed with this HTTP status and hosted code (a 429 without RATE_LIMITED comes from the
   * platform: the account's Workers request cap). */
  errorStatus: number | null;
  errorCode: string | null;
  /** The lease this tab held ended; the visitor has not yet chosen what next. */
  ended: EndedReason | null;
  /** The last lease attempt that did not lease (waitlist, budget, IP limit, closed). */
  blocked: BlockedResult | null;
  /** Bumped when something asks for the Start dialog (a showcase mutation answered LEASE_REQUIRED, a button). */
  startAsk: number;
  /** Why the Start dialog was asked for. */
  startReason: "button" | "mutation" | null;
  /** A pending human-grant request (a mutation answered 428); the Turnstile host renders the widget for it. */
  grantAsk: number | null;
}

const INITIAL: HostedState = { status: null, loaded: false, error: null, errorStatus: null, errorCode: null, ended: null, blocked: null, startAsk: 0, startReason: null, grantAsk: null };
export const hostedStore = createStore<HostedState>(INITIAL);

// ---- requests ------------------------------------------------------------------------------------------------

async function readJson<T>(res: Response): Promise<T | null> {
  try { const t = await res.text(); return t ? (JSON.parse(t) as T) : null; } catch { return null; }
}

export class HostedRequestError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message); this.name = "HostedRequestError"; }
}

async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await readJson<T & Partial<HostedErrorBody>>(res);
  if (!res.ok) throw new HostedRequestError(res.status, (json as Partial<HostedErrorBody> | null)?.code ?? null, (json as Partial<HostedErrorBody> | null)?.message ?? res.statusText);
  return json as T;
}

// ---- the live feed -------------------------------------------------------------------------------------------

let feed: LiveFeed | null = null;
function liveFeed(): LiveFeed {
  feed ??= new LiveFeed({ scheduler: scheduler(), url: () => liveUrl(HOSTED_PATHS.live), onLease });
  return feed;
}
function onLease(m: Extract<LiveMessage, { type: "lease" }>): void {
  if (m.state === "ended") { markEnded("server"); return; }
  // Reset (from this visitor's other tab, or the Lobby): the cookie already carries the new generation.
  void refreshSession().then(() => { invalidate(); liveFeed().restart(); });
}

/** Points the scheduler and the feed at the world the status names. */
function applyStatus(s: SessionStatus): void {
  const sch = scheduler();
  sch.setEnv({ level: s.level });
  if (s.world === "slot" && s.lease) {
    liveFeed().start();
    writeLeaseHint({ slot: s.lease.slot, gen: s.lease.gen, expiresAt: s.lease.expiresAt });
  } else {
    feed?.stop();
    sch.setEnv({ feed: "showcase" });
    writeLeaseHint(null);
  }
}

// ---- session -------------------------------------------------------------------------------------------------

let inflight: Promise<SessionStatus | null> | null = null;
let sessionPoll: { unregister(): void; ran(): void } | null = null;

/** GET /api/_session (coalesced). A tab that held a lease and now reads the showcase shows the lease-ended screen. */
export function refreshSession(): Promise<SessionStatus | null> {
  inflight ??= (async () => {
    sessionPoll?.ran();
    try {
      const prev = hostedStore.get().status;
      const s = await call<SessionStatus>("GET", HOSTED_PATHS.session);
      const lost = !!prev?.lease && !s.lease;
      hostedStore.set({ status: s, loaded: true, error: null, errorStatus: null, errorCode: null, ...(lost ? { ended: hostedStore.get().ended ?? "expired" } : {}) });
      applyStatus(s);
      return s;
    } catch (e) {
      hostedStore.set({ loaded: true, error: e instanceof Error ? e.message : String(e), errorStatus: e instanceof HostedRequestError ? e.status : null, errorCode: e instanceof HostedRequestError ? e.code : null });
      return null;
    } finally { inflight = null; }
  })();
  return inflight;
}

let booted = false;
/**
 * First read of the session, from the app shell and the portal (never the landing, whose unleased visit makes no
 * request). Also refreshes after every burst of mutations (they extend the idle lease) and joins the poll scheduler
 * as one more participant, so the feed's safety net refreshes it now and then.
 */
export function bootSession(): void {
  if (booted || typeof window === "undefined") return;
  booted = true;
  void refreshSession();
  let t: ReturnType<typeof setTimeout> | null = null;
  onInvalidate(() => {
    if (t || !hostedStore.get().status?.lease) return;
    t = setTimeout(() => { t = null; void refreshSession(); }, 1_000);
  });
  sessionPoll = scheduler().register({ url: HOSTED_PATHS.session, baseMs: 60_000, commits: false, fire: () => void refreshSession() });
}

/** Test hook: forget the boot, the feed and the state. */
export function resetHostedSession(): void {
  booted = false;
  inflight = null;
  sessionPoll?.unregister();
  sessionPoll = null;
  feed?.stop();
  feed = null;
  hostedStore.set(INITIAL);
  grantWaiters = [];
  clearGrantTimer();
  leasing = false;
}

/** The lease ends at the earlier of its total and idle deadlines. */
export function leaseDeadline(lease: Pick<LeaseInfo, "expiresAt" | "idleExpiresAt">): number {
  return Math.min(Date.parse(lease.expiresAt), Date.parse(lease.idleExpiresAt));
}

/** "42 min left", "1 h 5 min left", "under a minute left". */
export function fmtLeft(ms: number): string {
  if (ms < 60_000) return "under a minute left";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min left`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min left` : `${h} h left`;
}

export function markEnded(reason: EndedReason): void {
  feed?.stop();
  writeLeaseHint(null);
  hostedStore.set({ ended: reason });
  scheduler().setEnv({ feed: "showcase" });
}

/** The visitor chose to keep browsing the shared demo after a lease ended or a lease was refused. */
export function dismissEnded(): void {
  hostedStore.set({ ended: null, blocked: null });
  void refreshSession().then(() => invalidate());
}

/** A lease request is out: its answer decides what the Start dialog shows next. */
let leasing = false;

/** Opens the Start dialog. Ignored while a lease request is out, so the dialog never starts a second check (and a
 * second lease request) over the first. */
export function requestStart(reason: "button" | "mutation" = "button"): void {
  if (leasing) return;
  hostedStore.set((s) => ({ startAsk: s.startAsk + 1, startReason: reason, blocked: null }));
}
export function closeStart(): void { hostedStore.set({ startReason: null }); }

/** POST /api/_session/lease with a Turnstile token. "leased" switches the tab to the visitor's own world. */
export async function startLease(token: string): Promise<LeaseResult> {
  leasing = true;
  let r: LeaseResult;
  try { r = await call<LeaseResult>("POST", HOSTED_PATHS.lease, { token }); }
  finally { leasing = false; }
  if (r.status === "leased") {
    hostedStore.set({ ended: null, blocked: null, startReason: null });
    const s = await refreshSession();
    if (!s?.lease) {
      // The front set the cookies; the session read raced it. Apply what the lease answer says.
      writeLeaseHint({ slot: r.slot, gen: r.gen, expiresAt: r.expiresAt });
    }
    invalidate();
    scheduler().refreshAll();
  } else {
    hostedStore.set({ blocked: r });
  }
  return r;
}

// ---- the human grant -----------------------------------------------------------------------------------------

let grantWaiters: { ok: () => void; fail: (e: Error) => void }[] = [];
let grantTimer: ReturnType<typeof setTimeout> | null = null;
function clearGrantTimer(): void {
  if (grantTimer !== null) { clearTimeout(grantTimer); grantTimer = null; }
}

/**
 * Resolves once a fresh human grant is in place: the Turnstile host runs the widget (usually without interaction),
 * posts its token to /api/_session/verify and calls grantDone. Concurrent 428s share one check. A check still open
 * after HUMAN_CHECK_WAIT_MS fails, so a waiting mutation gets its 428 instead of hanging (a verify call that keeps
 * failing, a visitor who walked away).
 */
export function ensureHumanGrant(): Promise<void> {
  return new Promise((ok, fail) => {
    grantWaiters.push({ ok, fail });
    if (hostedStore.get().grantAsk === null) {
      hostedStore.set({ grantAsk: Date.now() });
      clearGrantTimer();
      grantTimer = setTimeout(() => { grantTimer = null; grantFailed("The human check took too long. Try again."); }, HUMAN_CHECK_WAIT_MS);
    }
  });
}

export async function verifyGrant(token: string): Promise<VerifyResult> {
  const r = await call<VerifyResult>("POST", HOSTED_PATHS.verify, { token });
  clearGrantTimer();
  hostedStore.set((s) => ({ grantAsk: null, status: s.status ? { ...s.status, grantExpiresAt: r.grantExpiresAt } : s.status }));
  const w = grantWaiters; grantWaiters = [];
  w.forEach((x) => x.ok());
  return r;
}

/** The check was cancelled, failed or timed out: every waiting mutation gets its original 428. */
export function grantFailed(message: string): void {
  clearGrantTimer();
  hostedStore.set({ grantAsk: null });
  const w = grantWaiters; grantWaiters = [];
  w.forEach((x) => x.fail(new Error(message)));
}

/** Restarts the feed after this tab reset its world (the front reissued the cookie with the new generation). */
export async function afterHostedReset(): Promise<void> {
  await refreshSession();
  liveFeed().restart();
  scheduler().refreshAll();
}

export const HOSTED_LIMITS = HOSTED_SETTINGS;
