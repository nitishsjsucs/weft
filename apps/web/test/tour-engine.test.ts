// The tour's state machine, persistence and preflight (owner: tour), driven with fakes: no router, DOM or API.
import { describe, expect, it } from "vitest";
import {
  clearNavigation, clearTour, hasSeen, IDLE, loadTour, markNavigation, markSeen, OWN_NAV_MS, preflightReasons, readPreflight, reduce,
  resetErrorText, restorePlan, saveTour, SEED_NOW, takeOwnNavigation, TOUR_NAV_KEY, type TourEvent, type TourState,
} from "../src/components/tour/engine";
import { TOUR_RESET_COPY, TOUR_SEEN_KEY, TOUR_STATE_KEY, TOUR_STEPS } from "../src/components/tour/steps";

const run = (events: TourEvent[], from: TourState = IDLE) => events.reduce(reduce, from);
const start: TourEvent = { type: "start", at: 1000, prevPrincipal: "usr_theo", prevAgentOpen: false };

class FakeStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };

const rich = { seedProfile: "rich", clockNow: SEED_NOW, noticeForms: [] as string[], pendingCommands: [] as (string | null)[] };

describe("preflight", () => {
  it("starts straight away on a clean rich world", () => {
    expect(preflightReasons(rich)).toEqual([]);
  });
  it("offers the reset on a base world, a delivered DE 2088, a moved clock or a pending rate change", () => {
    expect(preflightReasons({ ...rich, seedProfile: "base" })).toHaveLength(1);
    expect(preflightReasons({ ...rich, seedProfile: null })).toHaveLength(1);
    expect(preflightReasons({ ...rich, noticeForms: ["NYS-45", "DE 2088"] })[0]).toMatch(/DE 2088/);
    expect(preflightReasons({ ...rich, clockNow: "2026-10-27T15:30:00.000Z" })[0]).toMatch(/clock/);
    expect(preflightReasons({ ...rich, pendingCommands: [null, "tax.update_rate"] })[0]).toMatch(/rate change/);
  });
  it("reads the facts through the API and treats a failed call as missing", async () => {
    const api: Record<string, unknown> = {
      "/v1/health": { seedProfile: "rich" },
      "/v1/sim/clock": { now: SEED_NOW },
      "/v1/notices?limit=100": { data: [{ formCode: "DE 2088" }] },
    };
    const facts = await readPreflight(async (p) => { if (!(p in api)) throw new Error("500"); return api[p]; });
    expect(facts).toEqual({ seedProfile: "rich", clockNow: SEED_NOW, noticeForms: ["DE 2088"], pendingCommands: [] });
    expect(preflightReasons(facts)).toHaveLength(1);
  });
});

describe("state machine", () => {
  it("goes idle > preflight > running on a suitable world", () => {
    const s = run([start]);
    expect(s.status).toBe("preflight");
    expect(s.prevPrincipal).toBe("usr_theo");
    const r = reduce(s, { type: "preflight-done", reasons: [] });
    expect(r.status).toBe("running");
    expect(r.stepId).toBe("welcome");
  });

  it("shows the reset dialog on a base world; reset starts step 1 with a fresh memo, skip keeps the world", () => {
    const s = run([start, { type: "memo", patch: { delivered: true } }, { type: "preflight-done", reasons: ["base"] }]);
    expect(s.status).toBe("reset");
    expect(s.resetFrom).toBe("start");
    const done = reduce(s, { type: "reset-done", at: 5000 });
    expect(done).toMatchObject({ status: "running", stepId: "welcome", memo: {}, startedAt: 5000 });
    const skip = reduce(s, { type: "reset-skip", at: 6000 });
    expect(skip).toMatchObject({ status: "running", startedAt: 6000, memo: { delivered: true } });
  });

  it("a reset from the menu cancels back to where the tour was", () => {
    const running = run([start, { type: "preflight-done", reasons: [] }, { type: "next" }]);
    const open = reduce(running, { type: "open-reset", from: "menu" });
    expect(open.status).toBe("reset");
    expect(reduce(open, { type: "reset-cancel" })).toMatchObject({ status: "running", stepId: "env-pill" });
    const idleOpen = reduce(IDLE, { type: "open-reset", from: "menu" });
    expect(reduce(idleOpen, { type: "reset-cancel" }).status).toBe("idle");
  });

  it("walks next and back, and Back over a once step keeps what it did", () => {
    let s = run([start, { type: "preflight-done", reasons: [] }]);
    s = run([{ type: "back" }], s);
    expect(s.stepId).toBe("welcome");
    s = run([{ type: "goto", stepId: "deliver-notice" }, { type: "memo", patch: { delivered: true, noticeRunId: "run_0001" } }, { type: "next" }], s);
    expect(s.stepId).toBe("agent-run");
    s = reduce(s, { type: "back" });
    expect(s.stepId).toBe("deliver-notice");
    expect(s.memo).toMatchObject({ delivered: true, noticeRunId: "run_0001" });
    s = run(TOUR_STEPS.map(() => ({ type: "next" }) as TourEvent), s);
    expect(s.status).toBe("done");
  });

  it("deep links jump to a step and unknown ids fall back to step 1", () => {
    expect(run([{ ...start, stepId: "inbox-proposal" } as TourEvent, { type: "preflight-done", reasons: [] }]).stepId).toBe("inbox-proposal");
    expect(run([{ ...start, stepId: "nope" } as TourEvent]).stepId).toBe("welcome");
  });

  it("replay goes back to step 1 through preflight with a fresh memo", () => {
    const s = run([start, { type: "preflight-done", reasons: [] }, { type: "goto", stepId: "finish" }, { type: "memo", patch: { approved: true } }, { type: "replay", at: 9000 }]);
    expect(s).toMatchObject({ status: "preflight", stepId: "welcome", memo: {}, startedAt: 9000 });
  });

  it("exit goes idle and keeps what to restore", () => {
    const s = run([start, { type: "preflight-done", reasons: [] }, { type: "exit" }]);
    expect(s.status).toBe("idle");
    expect(restorePlan(s, "usr_dana")).toEqual({ principal: "usr_theo", agentOpen: false });
    expect(restorePlan({ prevPrincipal: "usr_dana", prevAgentOpen: null }, "usr_dana")).toEqual({ principal: null, agentOpen: null });
  });
});

describe("persistence", () => {
  it("saves a running tour and resumes it after a reload at the same step", () => {
    const store = new FakeStorage();
    const s = run([start, { type: "preflight-done", reasons: [] }, { type: "goto", stepId: "approve" }, { type: "memo", patch: { rateProposalId: "prp_0007" } }]);
    saveTour(store, s);
    const back = loadTour(store);
    expect(back).toMatchObject({ stepId: "approve", memo: { rateProposalId: "prp_0007" }, prevPrincipal: "usr_theo" });
    const resumed = reduce(IDLE, { type: "resume", persisted: back! });
    expect(resumed.status).toBe("resume");
    expect(reduce(resumed, { type: "resume-accept" })).toMatchObject({ status: "running", stepId: "approve" });
    saveTour(store, reduce(s, { type: "exit" }));
    expect(store.getItem(TOUR_STATE_KEY)).toBeNull();
  });

  it("ignores bad or blocked storage", () => {
    const store = new FakeStorage();
    store.setItem(TOUR_STATE_KEY, "{not json");
    expect(loadTour(store)).toBeNull();
    store.setItem(TOUR_STATE_KEY, JSON.stringify({ stepId: "gone" }));
    expect(loadTour(store)).toBeNull();
    expect(() => saveTour(blocked, run([start, { type: "preflight-done", reasons: [] }]))).not.toThrow();
    expect(loadTour(blocked)).toBeNull();
    expect(() => clearTour(blocked)).not.toThrow();
    expect(hasSeen(blocked)).toBe(true);
  });

  it("carries on by itself after a full page load the tour caused, and only then", () => {
    const store = new FakeStorage();
    const s = run([start, { type: "preflight-done", reasons: [] }, { type: "goto", stepId: "memory" }]);
    saveTour(store, s);
    // The tour pushed /app/memory and Next fell back to a document load: same path, within the window.
    markNavigation(store, "/app/memory", 5_000);
    expect(takeOwnNavigation(store, "/app/memory", 6_000)).toBe(true);
    expect(store.getItem(TOUR_NAV_KEY), "the mark is used once").toBeNull();
    expect(reduce(IDLE, { type: "resume", persisted: loadTour(store)!, auto: true })).toMatchObject({ status: "running", stepId: "memory" });
    // A person's own reload (no mark), a different page, or a stale mark asks first.
    expect(takeOwnNavigation(store, "/app/memory", 6_000)).toBe(false);
    markNavigation(store, "/app/memory", 5_000);
    expect(takeOwnNavigation(store, "/app/routines", 6_000)).toBe(false);
    markNavigation(store, "/app/memory", 5_000);
    expect(takeOwnNavigation(store, "/app/memory", 5_000 + OWN_NAV_MS + 1)).toBe(false);
    expect(reduce(IDLE, { type: "resume", persisted: loadTour(store)!, auto: false }).status).toBe("resume");
    // Exit clears the mark with the state; blocked storage never throws.
    markNavigation(store, "/app/memory", 5_000);
    clearTour(store);
    expect(store.getItem(TOUR_NAV_KEY)).toBeNull();
    expect(() => { markNavigation(blocked, "/app", 1); clearNavigation(blocked); }).not.toThrow();
    expect(takeOwnNavigation(blocked, "/app", 1)).toBe(false);
  });

  it("marks the tour seen", () => {
    const store = new FakeStorage();
    expect(hasSeen(store)).toBe(false);
    markSeen(store);
    expect(store.getItem(TOUR_SEEN_KEY)).toBe("1");
    expect(hasSeen(store)).toBe(true);
  });
});

describe("reset errors", () => {
  it("says reset is off on a 501 and shows the API's text otherwise", () => {
    expect(resetErrorText(501, "NotImplemented", "reset disabled", TOUR_RESET_COPY.disabled)).toBe(TOUR_RESET_COPY.disabled);
    expect(resetErrorText(500, "Internal", "boom", TOUR_RESET_COPY.disabled)).toBe("Internal: boom");
    expect(resetErrorText(null, null, "Failed to fetch", TOUR_RESET_COPY.disabled)).toBe("Failed to fetch");
  });
});
