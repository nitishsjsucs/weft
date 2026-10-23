// The WebSocket change feed (track cf5-web; docs/cloudflare/design.md 3.4 and 4.5): frame parsing, the reconnect
// ladder, commit frames into the scheduler, seq gaps and reconnects as full refreshes, lease frames, and the
// keepalive that closes a silent socket. A fake socket and a fake clock.
import { describe, expect, it } from "vitest";
import { backoffMs, LiveFeed, liveUrl, parseLiveMessage, type SocketLike } from "../src/lib/hosted/feed";
import { LIVE_PING, LIVE_PING_EVERY_MS, LIVE_PONG, LIVE_PONG_TIMEOUT_MS } from "../src/lib/hosted/flags";
import { PollScheduler, type Timers } from "../src/lib/api/poll";

class FakeTimers implements Timers {
  t = 0;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now() { return this.t; }
  set(fn: () => void, ms: number) { const id = ++this.id; this.q.push({ at: this.t + ms, fn, id }); return id; }
  clear(h: unknown) { this.q = this.q.filter((x) => x.id !== h); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const n = this.q[0];
      if (!n || n.at > end) break;
      this.q.shift(); this.t = n.at; n.fn();
    }
    this.t = end;
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: string[] = [];
  closed: number | null = null;
  constructor(readonly url: string) {}
  send(d: string) { this.sent.push(d); }
  close(code = 1000) { if (this.closed !== null) return; this.closed = code; this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  frame(data: unknown) { this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}

function setup() {
  const t = new FakeTimers();
  const s = new PollScheduler({}, t);
  const sockets: FakeSocket[] = [];
  const calls = { commit: [] as string[][], refreshAll: 0 };
  const commit = s.commit.bind(s);
  s.commit = (tables) => { calls.commit.push([...tables]); commit(tables); };
  const refreshAll = s.refreshAll.bind(s);
  s.refreshAll = () => { calls.refreshAll++; refreshAll(); };
  const leases: unknown[] = [];
  const feed = new LiveFeed({ scheduler: s, url: () => "ws://127.0.0.1:5790/api/_live", timers: t, socket: (u) => { const k = new FakeSocket(u); sockets.push(k); return k; }, onLease: (m) => leases.push(m) });
  return { t, s, feed, sockets, calls, leases };
}

describe("parseLiveMessage", () => {
  it("accepts commit and lease frames and nothing else", () => {
    expect(parseLiveMessage(JSON.stringify({ type: "commit", seq: 3, tables: ["proposals"] }))).toEqual({ type: "commit", seq: 3, tables: ["proposals"] });
    expect(parseLiveMessage(JSON.stringify({ type: "lease", state: "ended", gen: 4 }))).toEqual({ type: "lease", state: "ended", gen: 4 });
    expect(parseLiveMessage(JSON.stringify({ type: "lease", state: "paused", gen: 4 }))).toBeNull();
    expect(parseLiveMessage(JSON.stringify({ type: "commit", seq: "3", tables: [] }))).toBeNull();
    expect(parseLiveMessage(JSON.stringify({ type: "commit", seq: 3, tables: [1] }))).toBeNull();
    expect(parseLiveMessage("pong")).toBeNull();
    expect(parseLiveMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe("backoffMs and liveUrl", () => {
  it("doubles from 1 s to a 30 s ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
  it("uses wss on https and ws on http, on this origin", () => {
    expect(liveUrl("/api/_live", { protocol: "https:", host: "weft.nitish-ratakonda.workers.dev" })).toBe("wss://weft.nitish-ratakonda.workers.dev/api/_live");
    expect(liveUrl("/api/_live", { protocol: "http:", host: "127.0.0.1:5790" })).toBe("ws://127.0.0.1:5790/api/_live");
  });
});

describe("LiveFeed", () => {
  it("drives the scheduler: connecting, connected, commits by table", () => {
    const { s, feed, sockets, calls } = setup();
    feed.start();
    expect(s.env.feed).toBe("connecting");
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(s.env.feed).toBe("connected");
    expect(calls.refreshAll).toBe(0);   // the first connect follows the page's own first fetches
    sockets[0]!.frame({ type: "commit", seq: 1, tables: ["proposals"] });
    sockets[0]!.frame({ type: "commit", seq: 2, tables: ["workers", "actions"] });
    expect(calls.commit).toEqual([["proposals"], ["workers", "actions"]]);
    expect(sockets[0]!.sent).toEqual([]);   // the tab sends nothing but keepalives
  });

  it("treats a seq gap (a missed frame, or a restarted object) as a full refresh", () => {
    const { feed, sockets, calls } = setup();
    feed.start(); sockets[0]!.open();
    sockets[0]!.frame({ type: "commit", seq: 5, tables: ["a"] });
    sockets[0]!.frame({ type: "commit", seq: 7, tables: ["b"] });
    sockets[0]!.frame({ type: "commit", seq: 1, tables: ["c"] });
    expect(calls.commit).toEqual([["a"]]);
    expect(calls.refreshAll).toBe(2);
  });

  it("reconnects with backoff, falls back to polling meanwhile, and refreshes everything once back", async () => {
    const { t, s, feed, sockets, calls } = setup();
    const tick = async (ms: number) => { t.advance(ms); await Promise.resolve(); await Promise.resolve(); };
    feed.start(); sockets[0]!.open();
    sockets[0]!.drop();
    expect(s.env.feed).toBe("connecting");
    await tick(999);
    expect(sockets).toHaveLength(1);
    await tick(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.drop();
    await tick(2_000);
    expect(sockets).toHaveLength(3);
    sockets[2]!.open();
    expect(s.env.feed).toBe("connected");
    expect(calls.refreshAll).toBe(1);
  });

  it("after a reconnect's full refresh, the next frame starts a new count instead of a second full refresh", async () => {
    const { t, feed, sockets, calls } = setup();
    feed.start(); sockets[0]!.open();
    sockets[0]!.frame({ type: "commit", seq: 4, tables: ["a"] });
    sockets[0]!.drop();
    t.advance(1_000);
    await Promise.resolve(); await Promise.resolve();
    sockets[1]!.open();
    expect(calls.refreshAll).toBe(1);
    // Frames 5 to 8 went out while the socket was down (or the object restarted and counts from 1 again).
    sockets[1]!.frame({ type: "commit", seq: 9, tables: ["b"] });
    sockets[1]!.frame({ type: "commit", seq: 10, tables: ["c"] });
    expect(calls.refreshAll).toBe(1);
    expect(calls.commit).toEqual([["a"], ["b"], ["c"]]);
    sockets[1]!.frame({ type: "commit", seq: 12, tables: ["d"] });   // a gap on the new socket is still one
    expect(calls.refreshAll).toBe(2);
  });

  it("does not reconnect while the tab is hidden, and reconnects once it is visible", async () => {
    const { t, s, feed, sockets } = setup();
    feed.start(); sockets[0]!.open();
    s.setEnv({ hidden: true });
    sockets[0]!.drop();
    t.advance(120_000);
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    s.setEnv({ hidden: false });
    await Promise.resolve(); await Promise.resolve();
    expect(sockets).toHaveLength(2);
  });

  it("passes lease frames on", () => {
    const { feed, sockets, leases } = setup();
    feed.start(); sockets[0]!.open();
    sockets[0]!.frame({ type: "lease", state: "reset", gen: 2 });
    expect(leases).toEqual([{ type: "lease", state: "reset", gen: 2 }]);
  });

  it("pings on a timer and closes a socket whose pong never comes", async () => {
    const { t, feed, sockets } = setup();
    feed.start(); sockets[0]!.open();
    t.advance(LIVE_PING_EVERY_MS);
    expect(sockets[0]!.sent).toEqual([LIVE_PING]);
    sockets[0]!.frame(LIVE_PONG);
    t.advance(LIVE_PONG_TIMEOUT_MS);
    expect(sockets[0]!.closed).toBeNull();
    t.advance(LIVE_PING_EVERY_MS - LIVE_PONG_TIMEOUT_MS);
    expect(sockets[0]!.sent).toEqual([LIVE_PING, LIVE_PING]);
    t.advance(LIVE_PONG_TIMEOUT_MS);
    expect(sockets[0]!.closed).toBe(4000);
    t.advance(1_000);
    await Promise.resolve(); await Promise.resolve();
    expect(sockets).toHaveLength(2);
  });

  it("stop closes the socket, stops retrying and leaves the scheduler polling", () => {
    const { t, s, feed, sockets } = setup();
    feed.start(); sockets[0]!.open();
    feed.stop();
    expect(sockets[0]!.closed).toBe(1000);
    expect(s.env.feed).toBe("off");
    t.advance(120_000);
    expect(sockets).toHaveLength(1);
    expect(feed.active).toBe(false);
  });

  it("restart opens a fresh socket (a new world generation)", () => {
    const { feed, sockets, calls } = setup();
    feed.start(); sockets[0]!.open();
    feed.restart();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(calls.refreshAll).toBe(0);   // a restart is a first connect on the new world; the reset invalidates itself
  });
});
