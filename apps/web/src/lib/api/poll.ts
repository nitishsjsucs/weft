// Polling discipline for the hosted build (docs/cloudflare/design.md 4.5 and 6.5). Framework-free, so the unit tests
// drive it with a fake clock. On Node nothing here runs: hooks.ts keeps its plain setInterval there.
//
// Every polled query (and the few hand-written poll loops) registers as a participant. The scheduler then:
// - stops polling while the tab is hidden, and fires what went stale (or saw a commit) once it is visible again;
// - doubles every interval on the hosted build, triples it again at degradation level 1 and above, and after
//   2 minutes without input multiplies it by 4 (capped at 60 s, never shorter than it already was);
// - while the WebSocket feed is connected (or the world is the immutable showcase), stops interval polling: commit
//   frames refetch only the participants whose recorded `x-weft-tables` intersect the tables a commit wrote, and a
//   single safety-net timer refreshes the least recently fetched participant once per 60 s, so an idle open tab makes
//   at most one request a minute (none at level 1 and above with the feed connected: refresh comes from the feed only).
import { LIVE_POLL_FALLBACK_MS, type DegradationLevel } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { DEGRADED_POLL_MULTIPLIER, HOSTED_POLL_MULTIPLIER, IDLE_AFTER_MS, IDLE_CAP_MS, IDLE_MULTIPLIER } from "../hosted/flags";

/** off: no feed (polling at the hosted intervals); connecting: the socket is being opened or retried (still polling);
 * connected: commit frames drive refreshes; showcase: the shared read-only world, which cannot change. */
export type FeedState = "off" | "connecting" | "connected" | "showcase";
export interface PollEnv { hosted: boolean; hidden: boolean; idle: boolean; level: DegradationLevel; feed: FeedState }

export const NODE_ENV_DEFAULT: PollEnv = { hosted: false, hidden: false, idle: false, level: 0, feed: "off" };

const fedByFeed = (env: PollEnv) => env.feed === "connected" || env.feed === "showcase";

/** A participant's interval under `env`; null means it does not poll on a timer. `multiply: false` skips the hosted
 * multipliers (a caller that already chose its hosted interval, such as the run trace fallback). */
export function pollInterval(baseMs: number, env: PollEnv, multiply = true): number | null {
  if (!env.hosted) return baseMs;
  if (env.hidden || fedByFeed(env)) return null;
  let ms = baseMs;
  if (multiply) {
    ms *= HOSTED_POLL_MULTIPLIER;
    if (env.level >= 1) ms *= DEGRADED_POLL_MULTIPLIER;
  }
  if (env.idle) ms = Math.max(ms, Math.min(ms * IDLE_MULTIPLIER, IDLE_CAP_MS));
  return ms;
}

/** The safety-net period: one participant per period while the feed carries refreshes; null when it does not run. */
export function safetyNetMs(env: PollEnv): number | null {
  if (!env.hosted || env.hidden) return null;
  if (env.feed === "connected") return env.level >= 1 ? null : LIVE_POLL_FALLBACK_MS;
  if (env.feed === "showcase") return env.level >= 1 ? LIVE_POLL_FALLBACK_MS * DEGRADED_POLL_MULTIPLIER : LIVE_POLL_FALLBACK_MS;
  return null;
}

// ---- tables per URL (x-weft-tables) --------------------------------------------------------------------------

/** `x-weft-tables` from the last GET of each URL: a sorted set, or null when the response did not list them. Only the
 * hosted fetch records them, so on Node the map stays empty. */
const tablesByUrl = new Map<string, Set<string> | null>();
/** The URLs kept, most recently fetched last: a long session reads many distinct URLs (a query string per filter or
 * page). A URL dropped here reads as unknown, which every commit matches, so it costs at most one extra refetch. */
export const TABLES_MAX_URLS = 256;

/** The cache key for a request URL: path and query, without the origin. */
export function urlKey(url: string): string {
  if (url.startsWith("/")) return url;
  try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return url; }
}

export function recordTables(url: string, header: string | null): void {
  const set = header === null ? null : new Set(header.split(",").map((t) => t.trim()).filter(Boolean));
  const key = urlKey(url);
  tablesByUrl.delete(key);
  tablesByUrl.set(key, set);
  while (tablesByUrl.size > TABLES_MAX_URLS) tablesByUrl.delete(tablesByUrl.keys().next().value!);
}
/** The tables a URL read last time; undefined when it was never fetched, null when the response did not say. */
export function tablesFor(url: string): Set<string> | null | undefined {
  return tablesByUrl.get(urlKey(url));
}
export function clearTables(): void { tablesByUrl.clear(); }

/** Whether a commit that wrote `written` can change what `url` read. Unknown reads always match. */
export function touches(url: string | null, written: readonly string[]): boolean {
  if (url === null) return true;
  const read = tablesFor(url);
  if (!read) return true;
  return written.some((t) => read.has(t));
}

// ---- the scheduler -------------------------------------------------------------------------------------------

export interface Timers { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Participant {
  /** The URL it reads (for x-weft-tables matching); null for a loop that reads several (matches every commit). */
  url: string | null;
  baseMs: number;
  /** Apply the hosted multipliers (default true). */
  multiply?: boolean;
  /** Refetch on commit frames that touch what it read (default true). The session read opts out: no table holds it. */
  commits?: boolean;
  /** Start a refresh. The participant calls `ran()` when it actually fetches. */
  fire: () => void;
}
export interface Registration { ran(): void; update(p: Partial<Pick<Participant, "url" | "baseMs">>): void; unregister(): void }

interface Entry { id: number; p: Participant; lastRun: number; timer: unknown; commitTimer: unknown; dirty: boolean; commitAt: number }

/** Commit frames within this window collapse into one refetch per participant. */
export const COMMIT_DEBOUNCE_MS = 150;

export class PollScheduler {
  private entries = new Map<number, Entry>();
  private nextId = 1;
  private netTimer: unknown = null;
  private visibleWaiters: (() => void)[] = [];
  env: PollEnv;

  constructor(env: Partial<PollEnv> = {}, private readonly t: Timers = realTimers) {
    this.env = { ...NODE_ENV_DEFAULT, hosted: true, ...env };
  }

  get size(): number { return this.entries.size; }

  setEnv(patch: Partial<PollEnv>): void {
    const prev = this.env;
    const next = { ...prev, ...patch };
    if (next.hosted === prev.hosted && next.hidden === prev.hidden && next.idle === prev.idle && next.level === prev.level && next.feed === prev.feed) return;
    this.env = next;
    const nowVisible = prev.hidden && !next.hidden;
    for (const e of this.entries.values()) {
      if (nowVisible && e.dirty) { e.dirty = false; this.fire(e); continue; }
      this.schedule(e, true);
    }
    if (nowVisible) { const w = this.visibleWaiters; this.visibleWaiters = []; w.forEach((f) => f()); }
    this.armSafetyNet();
  }

  register(p: Participant): Registration {
    const e: Entry = { id: this.nextId++, p, lastRun: this.t.now(), timer: null, commitTimer: null, dirty: false, commitAt: 0 };
    this.entries.set(e.id, e);
    this.schedule(e, false);
    if (this.entries.size === 1) this.armSafetyNet();
    return {
      ran: () => { if (!this.entries.has(e.id)) return; e.lastRun = this.t.now(); e.dirty = false; this.schedule(e, false); },
      update: (patch) => { if (!this.entries.has(e.id)) return; e.p = { ...e.p, ...patch }; this.schedule(e, false); },
      unregister: () => {
        this.clearEntry(e);
        this.entries.delete(e.id);
        if (this.entries.size === 0) this.disarmSafetyNet();
      },
    };
  }

  /** A commit frame: refetch the participants whose reads it can change (hidden tabs mark them for later). */
  commit(tables: readonly string[]): void {
    const at = this.t.now();
    for (const e of this.entries.values()) if ((e.p.commits ?? true) && touches(e.p.url, tables)) this.queueRefresh(e, at);
  }

  /** After a reconnect (frames may have been missed): every participant refetches once. */
  refreshAll(): void {
    const at = this.t.now();
    for (const e of this.entries.values()) if (e.p.commits ?? true) this.queueRefresh(e, at);
  }

  private queueRefresh(e: Entry, at: number): void {
    if (this.env.hidden) { e.dirty = true; return; }
    e.commitAt = Math.max(e.commitAt, at);
    if (e.commitTimer !== null) return;
    e.commitTimer = this.t.set(() => {
      e.commitTimer = null;
      if (!this.entries.has(e.id)) return;
      // A fetch that started after the frame arrived (a mutation's own refetch) already has the commit.
      if (e.lastRun > e.commitAt) return;
      this.fire(e);
    }, COMMIT_DEBOUNCE_MS);
  }

  /** Resolves at once while visible, or when the tab is next visible. */
  whenVisible(): Promise<void> {
    if (!this.env.hidden) return Promise.resolve();
    return new Promise((ok) => this.visibleWaiters.push(ok));
  }

  /** Test helper: every registration's last fetch time, oldest first. */
  lastRuns(): number[] { return [...this.entries.values()].map((e) => e.lastRun).sort((a, b) => a - b); }

  dispose(): void {
    for (const e of this.entries.values()) this.clearEntry(e);
    this.entries.clear();
    this.disarmSafetyNet();
  }

  private fire(e: Entry): void {
    try { e.p.fire(); } catch { /* a participant's own error never stops the others */ }
  }

  private clearEntry(e: Entry): void {
    if (e.timer !== null) { this.t.clear(e.timer); e.timer = null; }
    if (e.commitTimer !== null) { this.t.clear(e.commitTimer); e.commitTimer = null; }
  }

  /** (Re)arms an entry's interval timer from its last fetch. `fireOverdue`: an env change may leave it already due. */
  private schedule(e: Entry, fireOverdue: boolean): void {
    if (e.timer !== null) { this.t.clear(e.timer); e.timer = null; }
    const ms = pollInterval(e.p.baseMs, this.env, e.p.multiply ?? true);
    if (ms === null) return;
    const wait = e.lastRun + ms - this.t.now();
    if (wait <= 0 && fireOverdue) { this.fire(e); return; }
    e.timer = this.t.set(() => {
      e.timer = null;
      if (!this.entries.has(e.id)) return;
      this.fire(e);
      // A participant that skips its fetch (an effect still running) is re-armed from now, never left without a timer.
      if (e.timer === null) { e.lastRun = this.t.now(); this.schedule(e, false); }
    }, Math.max(0, wait));
  }

  private armSafetyNet(): void {
    this.disarmSafetyNet();
    const ms = safetyNetMs(this.env);
    if (ms === null || this.entries.size === 0) return;
    this.netTimer = this.t.set(() => {
      this.netTimer = null;
      const oldest = [...this.entries.values()].sort((a, b) => a.lastRun - b.lastRun)[0];
      if (oldest) {
        this.fire(oldest);
        // Count the safety-net refresh as this participant's run even if its fetch is skipped, so the next period
        // picks the next oldest and the net never fires the same one twice in a row.
        oldest.lastRun = Math.max(oldest.lastRun, this.t.now());
      }
      this.armSafetyNet();
    }, ms);
  }

  private disarmSafetyNet(): void {
    if (this.netTimer !== null) { this.t.clear(this.netTimer); this.netTimer = null; }
  }
}

// ---- the browser singleton -----------------------------------------------------------------------------------

let shared: PollScheduler | null = null;

/** The hosted scheduler for this tab, with the visibility and idle trackers installed on first use. */
export function scheduler(): PollScheduler {
  if (shared) return shared;
  const hidden = typeof document !== "undefined" ? document.hidden : false;
  shared = new PollScheduler({ hidden });
  if (typeof window !== "undefined") installTrackers(shared);
  return shared;
}

/** Replaces the singleton (tests). */
export function setScheduler(s: PollScheduler | null): void { shared = s; }

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

/** Visibility and idle tracking for a scheduler. Returns the uninstall. */
export function installTrackers(s: PollScheduler, win: Window = window, doc: Document = document, t: Timers = realTimers): () => void {
  const onVisibility = () => s.setEnv({ hidden: doc.hidden });
  doc.addEventListener("visibilitychange", onVisibility);
  let lastInput = t.now();
  let idleTimer: unknown = null;
  const armIdle = () => {
    if (idleTimer !== null) t.clear(idleTimer);
    idleTimer = t.set(() => {
      idleTimer = null;
      const quiet = t.now() - lastInput;
      if (quiet >= IDLE_AFTER_MS) s.setEnv({ idle: true });
      else armIdle();
    }, Math.max(1_000, lastInput + IDLE_AFTER_MS - t.now()));
  };
  const onInput = () => {
    lastInput = t.now();
    if (s.env.idle) { s.setEnv({ idle: false }); armIdle(); }
    else if (idleTimer === null) armIdle();
  };
  for (const ev of INPUT_EVENTS) win.addEventListener(ev, onInput, { passive: true, capture: true });
  armIdle();
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    for (const ev of INPUT_EVENTS) win.removeEventListener(ev, onInput, { capture: true });
    if (idleTimer !== null) t.clear(idleTimer);
  };
}
