// Per-world module state (world.ts, otel.ts; docs/cloudflare/design.md 4.2 and 6.4): CompanyDO instances that share an
// isolate never share the trace redactor, its learned tokens or the run-start recall notes. Unbound, there is one
// world (NODE_WORLD), so Node keeps today's single process state.
import { afterEach, describe, expect, it } from "vitest";
import { NODE_WORLD } from "../../../contracts/src/ext/cf-db";
import { bindWorldScope, currentWorld, perWorld, setTraceRedactor, traceRedact } from "../../src/index";
import { learnedSize, noteRunRecall, peekRecallNote, traceRedactText } from "../../src/otel";

let world = "slot-1";
const scope = { current: () => world };
afterEach(() => {
  bindWorldScope(null);
  world = "slot-1";
});

describe("per-world agent state", () => {
  it("unbound, every caller is in the Node world", () => {
    expect(currentWorld()).toBe(NODE_WORLD);
    const v = perWorld(() => ({ n: 0 }));
    v().n++;
    expect(v().n).toBe(1);
  });

  it("acceptance: two worlds in one isolate keep their own redactor and their own learned tokens", () => {
    bindWorldScope(scope);
    world = "slot-1";
    setTraceRedactor(<T>(v: T): T => (typeof v === "string" ? (v.replaceAll("SECRET-ONE-111", "[redacted]") as T) : v));
    world = "slot-2";
    setTraceRedactor(<T>(v: T): T => v);
    world = "slot-1";
    expect(traceRedact("key SECRET-ONE-111")).toBe("key [redacted]");
    expect(traceRedactText("key SECRET-ONE-111")).toBe("key [redacted]");
    expect(learnedSize()).toBeGreaterThan(0);
    world = "slot-2";
    // slot-2's redactor never saw slot-1's secret, and slot-1's learned token does not leak into slot-2's memory.
    expect(learnedSize()).toBe(0);
    expect(traceRedact("key SECRET-ONE-111")).toBe("key SECRET-ONE-111");
    world = "slot-1";
    setTraceRedactor(<T>(v: T): T => v);
    expect(learnedSize()).toBe(0);
  });

  it("per-world values are created on first use in each world and kept apart", () => {
    bindWorldScope(scope);
    const notes = perWorld((w) => ({ w, items: [] as string[] }));
    world = "slot-1";
    notes().items.push("a");
    world = "showcase";
    expect(notes()).toEqual({ w: "showcase", items: [] });
    world = "slot-1";
    expect(notes()).toEqual({ w: "slot-1", items: ["a"] });
    // Run-start recall notes are per world too: the same run id in two worlds is two runs.
    noteRunRecall("run_0001", { query: "q1", reason: null, chars: 3 });
    world = "slot-2";
    expect(peekRecallNote("run_0001")).toBeUndefined();
    noteRunRecall("run_0001", { query: "q2", reason: "no_block", chars: 0 });
    world = "slot-1";
    expect(peekRecallNote("run_0001")).toMatchObject({ query: "q1" });
    world = "slot-2";
    expect(peekRecallNote("run_0001")).toMatchObject({ query: "q2" });
  });

  it("a scope that throws falls back to the Node world rather than failing a request", () => {
    bindWorldScope({ current: () => { throw new Error("no store"); } });
    expect(currentWorld()).toBe(NODE_WORLD);
  });
});
