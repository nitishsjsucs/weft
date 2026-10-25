// The cursor assistant's run as the client reads it (components/assist/run-core.ts): which presentation effects may
// play and when (never one from a step the run sent back for a repair), the refusal the popover says out loud, the
// request fitted under the API's byte cap, the clipped answer and the handoff's progress lines. Also the URL view
// state helpers (lib/url-state.ts) and a static check that every manifest anchor's attributes are rendered somewhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RunStepRow } from "@weft/contracts";
import { ASSIST_ANCHORS, EMPTY_CURSOR, SCREEN_LIMITS, type AssistEffect, type AssistRunRequest, type ScreenItem } from "../../../packages/contracts/src/ext/assist";
import { bodyBytes, cardTaint, chipLabel, clipAnswer, effectTrailLabel, fitAssistRequest, playableEffects, progressSteps, refusedChange } from "../src/components/assist/run-core";
import { createTrail } from "../src/components/assist/trail-core";
import { oneOf, patchedSearch, setUrlState, URL_STATE_EVENT } from "../src/lib/url-state";

let n = 0;
const step = (over: Partial<RunStepRow>): RunStepRow => ({
  runId: "run_0001", n: ++n, parentN: null, stage: "dispatch", kind: "tool_call", callId: null, toolName: null, toolArgs: null, outcome: "ok",
  result: null, native: null, usage: null, costUsdMicros: 0, attempt: 1, requestId: null, prefixHash: null, timings: null, createdAt: "2026-10-26T15:30:00.000Z", ...over,
});
const model = () => step({ kind: "model_call", stage: "model", outcome: null });
const ui = (tool: string, data: unknown, outcome: RunStepRow["outcome"] = "ok") => step({ toolName: tool, outcome, result: { outcome: { ok: outcome === "ok", status: "done", data } } });
const point = { effect: "point", target: { kind: "anchor", anchor: "inbox-approvals" }, label: "Here", selectors: ['[data-tour~="inbox-card"]'], hint: null };
/** The loop's mark on a batch's presentation words (loop.ts): grounded, or withheld. */
const mark = (presentation: "grounded" | "withheld") => step({ kind: "verify", stage: "post", result: { presentation, offending: [] } });

describe("playableEffects", () => {
  it("plays a step's calls once a later model call started or the run finished", () => {
    n = 0;
    const steps = [model(), ui("ui__point", point), ui("ui__say", { effect: "say" }), mark("grounded")];
    expect(playableEffects(steps, false)).toEqual([]);
    expect(playableEffects(steps, true).map((p) => p.effect.effect)).toEqual(["point", "say"]);
    expect(playableEffects([...steps, model()], false).map((p) => p.n)).toEqual([2, 3]);
  });
  it("never plays a step that was sent back for a repair, and plays the repaired step after it", () => {
    n = 0;
    const walk = { effect: "steps", steps: [{ route: null, target: { kind: "anchor", anchor: "payroll-needs-review" }, label: "Needs review", text: "17 paychecks", selectors: [] }] };
    const steps = [model(), ui("ui__steps", walk), ui("ui__say", { effect: "say" }), mark("withheld"), step({ kind: "notice", stage: "post", outcome: null, result: { notice: "repair" } }), model(), ui("ui__point", point), mark("grounded")];
    expect(playableEffects(steps, true).map((p) => p.effect.effect)).toEqual(["point"]);
  });
  it("fails closed: a batch the loop withheld or never marked is not played, whatever follows it", () => {
    n = 0;
    const walk = { effect: "steps", steps: [{ route: null, target: { kind: "anchor", anchor: "payroll-needs-review" }, label: "Needs review", text: "17 paychecks need review, $12,345.67 in all.", selectors: [] }] };
    // A read and an invented walkthrough in one batch, then a plain line: the walkthrough never plays.
    const mixed = [model(), step({ toolName: "payroll__get_run" }), ui("ui__steps", walk), mark("withheld"), model(), ui("ui__say", { effect: "say" }), mark("grounded")];
    expect(playableEffects(mixed, true).map((p) => p.effect.effect)).toEqual(["say"]);
    // The same beside a handoff, or as the last step with no repair left: no mark that says grounded, nothing plays.
    expect(playableEffects([model(), ui("ui__steps", walk), ui("ui__handoff", { effect: "handoff", reason: "analysis" }), mark("withheld")], true)).toEqual([]);
    expect(playableEffects([model(), ui("ui__point", point)], true)).toEqual([]);
  });
  it("skips refused calls, reads and anything that is not an effect", () => {
    n = 0;
    const steps = [model(), ui("ui__show", null, "refused:NOT_PERMITTED"), step({ toolName: "payroll__get_run", result: { outcome: { ok: true, data: { effect: "point" } } } }), ui("ui__point", { effect: "approve" })];
    expect(playableEffects(steps, true)).toEqual([]);
    expect(refusedChange(steps)).toBe(true);
    expect(refusedChange([ui("ui__show", null, "refused:UNKNOWN_REFERENCE")])).toBe(false);
  });
});

describe("cardTaint", () => {
  const run = (tainted: boolean) => ({ id: "run_0009", tainted, taintedBy: tainted ? "screen:labels" : null }) as never;
  const prop = (id: string, proposerRunId: string | null, taintedBy: string | null = null) => ({ id, proposerRunId, taintedBy }) as never;
  it("a card a tainted run only showed carries the run's taint, so it has no Approve; a clean run's card has none", () => {
    expect(cardTaint({ run: run(true), proposals: [prop("prp_0042", "run_0001")] }, "prp_0042")).toBe("screen:labels");
    expect(cardTaint({ run: run(false), proposals: [prop("prp_0042", "run_0001")] }, "prp_0042")).toBeNull();
  });
  it("a card the run filed, or a proposal tainted on its own, keeps the proposal's taint", () => {
    expect(cardTaint({ run: run(true), proposals: [prop("prp_0043", "run_0009", "run:run_0009")] }, "prp_0043")).toBe("run:run_0009");
    expect(cardTaint({ run: run(false), proposals: [prop("prp_0044", "run_0001", "thread:thr_x")] }, "prp_0044")).toBe("thread:thr_x");
  });
});

describe("effectTrailLabel", () => {
  const point: AssistEffect = { effect: "point", target: { kind: "anchor", anchor: "inbox-approvals" }, label: "Approve prp_0019 now", selectors: [], hint: null };
  it("a clean run's point is recorded with its label; a tainted run's carries none of its words into the next question", () => {
    expect(effectTrailLabel(point, false)).toBe("The assistant showed Approve prp_0019 now");
    const tainted = effectTrailLabel(point, true)!;
    expect(tainted).toBe("The assistant showed something");
    expect(tainted).not.toContain("prp_0019");
    const show: AssistEffect = { effect: "show", via: "intent", intent: "approval.card", params: { proposalId: "prp_0019" }, route: "/app/inbox?proposal=prp_0019", anchor: "inbox-proposal", selectors: [], label: "Safe to approve" };
    expect(effectTrailLabel(show, true)).not.toContain("Safe");
    // The trail line the next request sends holds no model words from the tainted run.
    const trail = createTrail();
    trail.push({ kind: "effect", label: tainted, route: "/app/inbox" }, 0);
    expect(JSON.stringify(trail.list(1_000))).not.toContain("prp_0019");
  });
  it("a navigation names its validated route; a popover line and a handoff are not recorded", () => {
    expect(effectTrailLabel({ effect: "navigate", route: "/app/payroll", target: null, label: "Ignore this", selectors: [], hint: null }, true)).toBe("The assistant opened /app/payroll");
    expect(effectTrailLabel({ effect: "say" }, false)).toBeNull();
    expect(effectTrailLabel({ effect: "handoff", reason: "change" }, false)).toBeNull();
    expect(effectTrailLabel({ effect: "steps", steps: [] }, true)).toBe("The assistant started a walkthrough");
  });
});

describe("progressSteps", () => {
  it("lists the handoff run's reads and proposals in plain words, not presentation calls", () => {
    n = 0;
    const lines = progressSteps([model(), step({ toolName: "payroll__list_runs" }), ui("ui__say", { effect: "say" }), step({ toolName: "payroll__propose_off_cycle", outcome: "pending:prp_0100" })], (s) => s.toolName!.replace("__", "."));
    expect(lines.map((l) => [l.text, l.outcome])).toEqual([["payroll.list_runs", "ok"], ["payroll.propose_off_cycle", "pending:prp_0100"]]);
  });
});

describe("fitAssistRequest", () => {
  const item = (i: number, over: Partial<ScreenItem> = {}): ScreenItem => ({ n: i + 1, kind: "heading", label: "x".repeat(60), box: [0, i * 20, 400, 18], ...over });
  const req = (items: ScreenItem[], extra = 0): AssistRunRequest => ({
    text: "Where do I approve time off?", pageContext: "/app/inbox", threadId: "thr_0123456789abcdef0123", recipe: "assist",
    assist: {
      screen: { route: "/app/inbox", title: "Inbox", tab: null, items, intents: [], truncated: false, viewport: [1440, 900] },
      cursor: { ...EMPTY_CURSOR, trail: [{ entity: "wrk_0001", kind: "worker", label: "y".repeat(extra) }] },
      records: [{ source: "/v1/workers", count: 1, rows: [{ id: "wrk_0001", fields: [{ name: "displayName", value: "z".repeat(60) }] }] }],
      trail: [{ kind: "navigate", label: "Opened Inbox", route: "/app/inbox", agoS: 3 }],
    },
  });
  it("leaves a request that fits alone", () => {
    const r = req([item(0)]);
    expect(fitAssistRequest(r)).toBe(r);
  });
  it("drops records, then the trail, then the hover trail, then the lowest ranked items, until it fits", () => {
    const items = [...Array.from({ length: 79 }, (_, i) => item(i)), item(79, { kind: "card", entity: "prp_0014", anchor: "inbox-time-off" })];
    const r = req(items);
    const max = bodyBytes(r) - 600;
    const out = fitAssistRequest(r, max)!;
    expect(bodyBytes(out)).toBeLessThanOrEqual(max);
    expect(out.assist.records).toEqual([]);
    expect(out.assist.trail).toEqual([]);
    expect(out.assist.cursor.trail).toEqual([]);
    expect(out.assist.screen.truncated).toBe(true);
    expect(out.assist.screen.items.some((i) => i.entity === "prp_0014")).toBe(true);
    expect(fitAssistRequest(r, 200)).toBeNull();
    expect(bodyBytes(req(items))).toBeLessThan(SCREEN_LIMITS.bodyBytes);
  });
});

describe("clipAnswer", () => {
  it("cuts a long answer at a sentence, never inside a citation", () => {
    const text = `${"Payroll went up because of the new hires. ".repeat(12)}The rest [res_0042] is in the run.`;
    const out = clipAnswer(text, 200);
    expect(out.clipped).toBe(true);
    expect(out.text.endsWith("hires.…")).toBe(true);
    expect(clipAnswer("Short [res_0001].", 200)).toEqual({ text: "Short [res_0001].", clipped: false });
    expect(clipAnswer(`word ${"a".repeat(10)} [res_00`, 18).text).not.toContain("[res");
  });
});

describe("chipLabel", () => {
  it("keeps a record's name and reads an unnamed pay run by its date", () => {
    expect(chipLabel({ id: "wrk_0026", label: "Lena Brooks" })).toBe("Lena Brooks");
    expect(chipLabel({ id: "pay_2026_10_30", label: "Pay run" })).toBe("the Oct 30 pay run");
    expect(chipLabel({ id: "prp_0001", label: "The proposal" })).toBe("the proposal");
  });
});

describe("URL view state", () => {
  it("patches the query in place: set, replace, remove, keep the rest in order", () => {
    expect(patchedSearch("?a=1&tab=pay", { tab: null, paycheck: "wrk_0026" })).toBe("?a=1&paycheck=wrk_0026");
    expect(patchedSearch("?tab=pay", { tab: "benefits" })).toBe("?tab=benefits");
    expect(patchedSearch("?tab=pay", { tab: "" })).toBe("");
    expect(patchedSearch("", { "filter.band": "needs_review" })).toBe("?filter.band=needs_review");
  });
  it("accepts only a page's own options", () => {
    expect(oneOf(["pay", "profile"])("pay")).toBe(true);
    expect(oneOf(["pay", "profile"])("salary")).toBe(false);
  });
  it("writes the query with the entry's own router state, so it never cancels a navigation in flight", () => {
    const routerState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"] };
    const calls: { state: unknown; url: string }[] = [];
    const events: string[] = [];
    vi.stubGlobal("window", {
      location: { pathname: "/app/expenses", search: "?expense=exp_0005", hash: "" },
      history: { state: routerState, replaceState: (state: unknown, _t: string, url: string) => calls.push({ state, url }) },
      dispatchEvent: (e: Event) => events.push(e.type),
    });
    try {
      setUrlState({ expense: null });
      setUrlState({ expense: "exp_0005" });
      expect(calls).toEqual([{ state: routerState, url: "/app/expenses" }]);
      expect(events).toEqual([URL_STATE_EVENT]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the manifest's anchors", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []; });
  const all = files(src).filter((f) => !f.slice(src.length).startsWith("/components/assist/")).map((f) => readFileSync(f, "utf8")).join("\n");
  it("select only attributes the app renders", () => {
    const missing: string[] = [];
    for (const [token, a] of Object.entries(ASSIST_ANCHORS)) {
      for (const sel of a.selectors) {
        for (const m of sel.matchAll(/\[([a-z-]+)(?:[~^$*|]?=)?/g)) if (!all.includes(`${m[1]}=`)) missing.push(`${token}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
