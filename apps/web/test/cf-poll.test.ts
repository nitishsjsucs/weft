// Polling discipline on the hosted build (track cf5-web; docs/cloudflare/design.md 4.5 and 6.5): the interval policy,
// the scheduler (hidden tabs, idle backoff, the change feed, commit frames by x-weft-tables, the 60 s safety net) and
// the visibility and idle trackers, all on a fake clock.
import { afterEach, describe, expect, it } from "vitest";
import { clearTables, COMMIT_DEBOUNCE_MS, installTrackers, pollInterval, PollScheduler, recordTables, safetyNetMs, TABLES_MAX_URLS, tablesFor, touches, urlKey, type PollEnv, type Timers } from "../src/lib/api/poll";

class FakeTimers implements Timers {
  t = 0;
  private q: { at: number; fn: () => void; id: number }[] = [];
  private id = 0;
  now() { return this.t; }
  set(fn: () => void, ms: number) { const id = ++this.id; this.q.push({ at: this.t + Math.max(0, ms), fn, id }); return id; }
  clear(h: unknown) { this.q = this.q.filter((x) => x.id !== h); }
  /** Runs every timer due within `ms`, in order. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  get pending() { return this.q.length; }
}

const hosted = (p: Partial<PollEnv> = {}): PollEnv => ({ hosted: true, hidden: false, idle: false, level: 0, feed: "off", ...p });

afterEach(() => clearTables());

describe("pollInterval", () => {
  it("is the base interval on Node, whatever else is set", () => {
    expect(pollInterval(5_000, { hosted: false, hidden: true, idle: true, level: 3, feed: "connected" })).toBe(5_000);
  });
  it("doubles on the hosted build, triples again from level 1, and stops while hidden or fed by the feed", () => {
    expect(pollInterval(5_000, hosted())).toBe(10_000);
    expect(pollInterval(5_000, hosted({ level: 1 }))).toBe(30_000);
    expect(pollInterval(5_000, hosted({ hidden: true }))).toBeNull();
    expect(pollInterval(5_000, hosted({ feed: "connected" }))).toBeNull();
    expect(pollInterval(5_000, hosted({ feed: "showcase" }))).toBeNull();
    expect(pollInterval(5_000, hosted({ feed: "connecting" }))).toBe(10_000);
  });
  it("multiplies by 4 when idle, capped at 60 s, never shorter than before", () => {
    expect(pollInterval(5_000, hosted({ idle: true }))).toBe(40_000);
    expect(pollInterval(10_000, hosted({ idle: true }))).toBe(60_000);
    expect(pollInterval(15_000, hosted({ idle: true, level: 1 }))).toBe(90_000);
    expect(pollInterval(5_000, hosted({ idle: true }), false)).toBe(20_000);
  });
  it("skips the multipliers when asked (the run trace fallback picks its own)", () => {
    expect(pollInterval(5_000, hosted({ level: 2 }), false)).toBe(5_000);
  });
});

describe("safetyNetMs", () => {
  it("runs once a minute while the feed is connected, not at level 1 and above", () => {
    expect(safetyNetMs(hosted({ feed: "connected" }))).toBe(60_000);
    expect(safetyNetMs(hosted({ feed: "connected", level: 1 }))).toBeNull();
    expect(safetyNetMs(hosted({ feed: "showcase" }))).toBe(60_000);
    expect(safetyNetMs(hosted({ feed: "showcase", level: 2 }))).toBe(180_000);
    expect(safetyNetMs(hosted({ feed: "off" }))).toBeNull();
    expect(safetyNetMs(hosted({ feed: "connected", hidden: true }))).toBeNull();
    expect(safetyNetMs({ ...hosted({ feed: "connected" }), hosted: false })).toBeNull();
  });
});

describe("x-weft-tables", () => {
  it("records the tables a URL read and matches commits against them", () => {
    recordTables("/api/v1/proposals?status=pending", "proposals, proposal_votes");
    expect([...(tablesFor("/api/v1/proposals?status=pending") ?? [])]).toEqual(["proposals", "proposal_votes"]);
    expect(touches("/api/v1/proposals?status=pending", ["workers"])).toBe(false);
    expect(touches("/api/v1/proposals?status=pending", ["workers", "proposals"])).toBe(true);
    recordTables("http://127.0.0.1:5790/api/v1/sim/clock", null);
    expect(tablesFor("/api/v1/sim/clock")).toBeNull();
    expect(touches("/api/v1/sim/clock", ["anything"])).toBe(true);   // unknown reads always match
    expect(touches("/api/v1/never-fetched", ["x"])).toBe(true);
    expect(touches(null, ["x"])).toBe(true);
    expect(urlKey("https://weft.example/api/v1/x?y=1")).toBe("/api/v1/x?y=1");
  });

  it("keeps the most recently fetched TABLES_MAX_URLS URLs; a dropped one reads as unknown", () => {
    expect(TABLES_MAX_URLS).toBe(256);
    recordTables("/api/v1/proposals", "proposals");
    for (let i = 0; i < TABLES_MAX_URLS - 1; i++) recordTables(`/api/v1/workers?page=${i}`, "workers");
    recordTables("/api/v1/proposals", "proposals");   // fetched again: now the most recent
    recordTables("/api/v1/workers?page=last", "workers");
    expect(tablesFor("/api/v1/workers?page=0")).toBeUndefined();
    expect(touches("/api/v1/workers?page=0", ["proposals"])).toBe(true);
    expect([...(tablesFor("/api/v1/proposals") ?? [])]).toEqual(["proposals"]);
    expect(touches("/api/v1/proposals", ["workers"])).toBe(false);
    expect(tablesFor("/api/v1/workers?page=1")).toEqual(new Set(["workers"]));
    expect(tablesFor("/api/v1/workers?page=last")).toEqual(new Set(["workers"]));
    for (let i = 0; i < 1_000; i++) recordTables(`/api/v1/runs?cursor=${i}`, null);
    expect(tablesFor("/api/v1/runs?cursor=999")).toBeNull();
    expect(tablesFor("/api/v1/runs?cursor=743")).toBeUndefined();
    expect(tablesFor("/api/v1/runs?cursor=744")).toBeNull();
  });
});

function setup(env: Partial<PollEnv> = {}) {
  const t = new FakeTimers();
  const s = new PollScheduler(env, t);
  const fired: string[] = [];
  const add = (name: string, baseMs: number, url: string | null = `/api/${name}`, extra: { commits?: boolean; multiply?: boolean } = {}) => {
    // A participant that fetches as soon as it fires, as useGet does a moment later.
    const reg = s.register({ url, baseMs, ...extra, fire: () => { fired.push(name); reg.ran(); } });
    return reg;
  };
  return { t, s, fired, add };
}

describe("PollScheduler", () => {
  it("polls each participant at its hosted interval", () => {
    const { t, fired, add } = setup();
    add("clock", 5_000);
    add("health", 15_000);
    t.advance(30_000);
    expect(fired.filter((x) => x === "clock")).toHaveLength(3);
    expect(fired.filter((x) => x === "health")).toHaveLength(1);
  });

  it("makes no request while hidden, then fires what went stale once visible", () => {
    const { t, s, fired, add } = setup();
    add("clock", 5_000);
    add("health", 15_000);
    s.setEnv({ hidden: true });
    t.advance(120_000);
    expect(fired).toEqual([]);
    s.setEnv({ hidden: false });
    expect(fired.sort()).toEqual(["clock", "health"]);
  });

  it("backs off while idle and catches up when input returns", () => {
    const { t, s, fired, add } = setup();
    add("clock", 5_000);
    s.setEnv({ idle: true });
    t.advance(39_999);
    expect(fired).toEqual([]);
    t.advance(1);
    expect(fired).toEqual(["clock"]);
    t.advance(15_000);
    s.setEnv({ idle: false });   // 15 s since the last fetch, over the 10 s hosted interval
    expect(fired).toEqual(["clock", "clock"]);
  });

  it("with the feed connected, makes at most one request a minute however many queries are mounted", () => {
    const { t, s, fired, add } = setup();
    for (let i = 0; i < 12; i++) add(`q${i}`, 3_000 + i * 1_000);
    s.setEnv({ feed: "connected" });
    t.advance(60_000 * 5);
    expect(fired).toHaveLength(5);
    expect(new Set(fired).size).toBe(5);   // round robin: the least recently fetched each time
  });

  it("refreshes from the feed only at level 1 and above", () => {
    const { t, s, fired, add } = setup();
    add("a", 5_000);
    s.setEnv({ feed: "connected", level: 1 });
    t.advance(600_000);
    expect(fired).toEqual([]);
  });

  it("refetches only the participants whose recorded tables a commit wrote, once per burst", () => {
    const { t, s, fired, add } = setup({ feed: "connected" });
    recordTables("/api/proposals", "proposals");
    recordTables("/api/clock", "settings");
    add("proposals", 5_000);
    add("clock", 5_000);
    add("loop", 4_000, null);   // a loop over several URLs matches every commit
    add("session", 60_000, "/api/_session", { commits: false });
    s.commit(["proposals", "actions"]);
    s.commit(["proposals"]);
    t.advance(COMMIT_DEBOUNCE_MS);
    expect(fired.sort()).toEqual(["loop", "proposals"]);
  });

  it("skips a commit refetch when a fetch already started after the frame (the mutation's own refetch)", () => {
    const { t, s, fired } = setup({ feed: "connected" });
    recordTables("/api/proposals", "proposals");
    const reg = s.register({ url: "/api/proposals", baseMs: 5_000, fire: () => fired.push("proposals") });
    s.commit(["proposals"]);
    t.advance(10);
    reg.ran();
    t.advance(COMMIT_DEBOUNCE_MS);
    expect(fired).toEqual([]);
  });

  it("marks commit frames while hidden and refetches those on visible", () => {
    const { t, s, fired, add } = setup({ feed: "connected" });
    recordTables("/api/proposals", "proposals");
    recordTables("/api/clock", "settings");
    add("proposals", 5_000);
    add("clock", 5_000);
    s.setEnv({ hidden: true });
    s.commit(["proposals"]);
    t.advance(60_000);
    expect(fired).toEqual([]);
    s.setEnv({ hidden: false });
    expect(fired).toEqual(["proposals"]);
  });

  it("refreshAll refetches every participant that follows commits", () => {
    const { t, s, fired, add } = setup({ feed: "connected" });
    add("a", 5_000);
    add("b", 5_000);
    add("session", 60_000, "/api/_session", { commits: false });
    s.refreshAll();
    t.advance(COMMIT_DEBOUNCE_MS);
    expect(fired.sort()).toEqual(["a", "b"]);
  });

  it("goes back to interval polling when the feed drops", () => {
    const { t, s, fired, add } = setup({ feed: "connected" });
    add("a", 5_000);
    t.advance(30_000);
    expect(fired).toEqual([]);
    s.setEnv({ feed: "connecting" });   // 30 s since the last fetch: due at once
    expect(fired).toEqual(["a"]);
    t.advance(10_000);
    expect(fired).toEqual(["a", "a"]);
  });

  it("unregisters cleanly and keeps no timers", () => {
    const { t, s, add } = setup({ feed: "connected" });
    const r = add("a", 5_000);
    r.unregister();
    expect(s.size).toBe(0);
    expect(t.pending).toBe(0);
  });

  it("re-arms a participant that skipped its fetch", () => {
    const t = new FakeTimers();
    const s = new PollScheduler({}, t);
    let n = 0;
    s.register({ url: "/api/x", baseMs: 5_000, fire: () => { n++; } });   // never calls ran()
    t.advance(35_000);
    expect(n).toBe(3);
  });

  it("whenVisible resolves at once, or on the next visible", async () => {
    const t = new FakeTimers();
    const s = new PollScheduler({ hidden: true }, t);
    let done = false;
    const p = s.whenVisible().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    s.setEnv({ hidden: false });
    await p;
    expect(done).toBe(true);
    await s.whenVisible();
  });
});

describe("installTrackers", () => {
  it("follows document visibility and goes idle after 2 minutes without input", () => {
    const t = new FakeTimers();
    const s = new PollScheduler({}, t);
    const win = new EventTarget() as unknown as Window;
    const doc = Object.assign(new EventTarget(), { hidden: false }) as unknown as Document & { hidden: boolean };
    const off = installTrackers(s, win, doc, t);
    (doc as { hidden: boolean }).hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(s.env.hidden).toBe(true);
    (doc as { hidden: boolean }).hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(s.env.hidden).toBe(false);
    t.advance(119_000);
    expect(s.env.idle).toBe(false);
    t.advance(2_000);
    expect(s.env.idle).toBe(true);
    win.dispatchEvent(new Event("keydown"));
    expect(s.env.idle).toBe(false);
    t.advance(60_000);
    win.dispatchEvent(new Event("pointermove"));
    t.advance(100_000);
    expect(s.env.idle).toBe(false);
    t.advance(30_000);
    expect(s.env.idle).toBe(true);
    off();
    win.dispatchEvent(new Event("keydown"));
    expect(s.env.idle).toBe(true);
  });
});
