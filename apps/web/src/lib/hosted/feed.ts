// The WebSocket change feed on /api/_live (docs/cloudflare/design.md 3.4 and 4.5). The front Worker forwards the
// upgrade to the visitor's own slot, which accepts it hibernatably and sends one frame after every commit:
// `{ type: "commit", seq, tables }`, plus `{ type: "lease", state, gen }` when the lease ends or the world is reset.
// The tab sends nothing but a keepalive the slot answers with its hibernation auto-response, so an idle open tab costs
// nothing. While connected, the poll scheduler stops interval polling and refetches only what a commit touched.
import type { LiveMessage } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { realTimers, type PollScheduler, type Timers } from "../api/poll";
import { LIVE_PING, LIVE_PING_EVERY_MS, LIVE_PONG, LIVE_PONG_TIMEOUT_MS } from "./flags";

/** Parses one frame; anything that is not a LiveMessage is null. */
export function parseLiveMessage(data: unknown): LiveMessage | null {
  if (typeof data !== "string") return null;
  let v: unknown;
  try { v = JSON.parse(data); } catch { return null; }
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (m.type === "commit" && typeof m.seq === "number" && Array.isArray(m.tables) && m.tables.every((t) => typeof t === "string")) {
    return { type: "commit", seq: m.seq, tables: m.tables as string[] };
  }
  if (m.type === "lease" && (m.state === "ended" || m.state === "reset") && typeof m.gen === "number") {
    return { type: "lease", state: m.state, gen: m.gen };
  }
  return null;
}

/** Reconnect delays: 1 s doubling to 30 s; a connection that stayed up 30 s resets the ladder. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
const STABLE_MS = 30_000;

/** The browser WebSocket surface the feed uses (a fake in tests). */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface FeedOptions {
  scheduler: PollScheduler;
  url: () => string;
  socket?: SocketFactory;
  timers?: Timers;
  onLease?: (m: Extract<LiveMessage, { type: "lease" }>) => void;
}

const OPEN = 1;

export class LiveFeed {
  private ws: SocketLike | null = null;
  private running = false;
  private attempt = 0;
  private everOpened = false;
  private lastSeq: number | null = null;
  private openedAt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private readonly t: Timers;
  private readonly make: SocketFactory;

  constructor(private readonly o: FeedOptions) {
    this.t = o.timers ?? realTimers;
    this.make = o.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get connected(): boolean { return !!this.ws && this.ws.readyState === OPEN; }
  get active(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  /** Stops for good (lease ended, showcase): the scheduler goes back to polling unless the caller sets another state. */
  stop(): void {
    this.running = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.onopen = null; try { ws.close(1000, "done"); } catch { /* closed */ } }
    this.everOpened = false;
    this.lastSeq = null;
    if (this.o.scheduler.env.feed === "connected" || this.o.scheduler.env.feed === "connecting") this.o.scheduler.setEnv({ feed: "off" });
  }

  /** A new world generation (a reset): drop the socket and open a fresh one with the reissued cookie. */
  restart(): void { this.stop(); this.start(); }

  private connect(): void {
    if (!this.running) return;
    this.o.scheduler.setEnv({ feed: "connecting" });
    let ws: SocketLike;
    try { ws = this.make(this.o.url()); } catch { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = this.t.now();
      this.o.scheduler.setEnv({ feed: "connected" });
      // Frames sent while the socket was down are gone: refetch everything once on a reconnect.
      if (this.everOpened) this.o.scheduler.refreshAll();
      this.everOpened = true;
      this.armPing();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      if (!this.running) return;
      if (this.openedAt && this.t.now() - this.openedAt >= STABLE_MS) this.attempt = 0;
      this.openedAt = 0;
      this.retry();
    };
  }

  private onMessage(data: unknown): void {
    if (data === LIVE_PONG) { this.clearPong(); return; }
    const m = parseLiveMessage(data);
    if (!m) return;
    if (m.type === "lease") { this.o.onLease?.(m); return; }
    const gap = this.lastSeq !== null && m.seq !== this.lastSeq + 1;
    this.lastSeq = m.seq;
    if (gap) this.o.scheduler.refreshAll();
    else this.o.scheduler.commit(m.tables);
  }

  /** Retries with backoff; a hidden tab waits until it is visible again (an upgrade is a Worker request too). */
  private retry(): void {
    if (!this.running) return;
    this.o.scheduler.setEnv({ feed: "connecting" });
    const ms = backoffMs(this.attempt++);
    this.retryTimer = this.t.set(() => {
      this.retryTimer = null;
      void this.o.scheduler.whenVisible().then(() => { if (this.running && !this.ws && this.retryTimer === null) this.connect(); });
    }, ms);
  }

  private armPing(): void {
    if (this.pingTimer !== null) { this.t.clear(this.pingTimer); this.pingTimer = null; }
    this.pingTimer = this.t.set(() => {
      this.pingTimer = null;
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) return;
      try { ws.send(LIVE_PING); } catch { /* closing */ }
      if (this.pongTimer === null) {
        this.pongTimer = this.t.set(() => { this.pongTimer = null; try { ws.close(4000, "no pong"); } catch { /* closed */ } }, LIVE_PONG_TIMEOUT_MS);
      }
      this.armPing();
    }, LIVE_PING_EVERY_MS);
  }

  private clearPong(): void { if (this.pongTimer !== null) { this.t.clear(this.pongTimer); this.pongTimer = null; } }
  private clearPing(): void {
    if (this.pingTimer !== null) { this.t.clear(this.pingTimer); this.pingTimer = null; }
    this.clearPong();
  }
  private clearTimers(): void {
    this.clearPing();
    if (this.retryTimer !== null) { this.t.clear(this.retryTimer); this.retryTimer = null; }
  }
}

/** ws(s)://<this origin>/api/_live */
export function liveUrl(path: string, loc: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`;
}
