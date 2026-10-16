// code.run engine (harness 3, SPEC 9.9): model-written JavaScript in QuickJS-WASM (quickjs-emscripten, MIT), in
// process, behind the SandboxEngine contract. One runtime and one context per run, disposed in finally.
//
// The only door out is weft.call(name, args), an async RPC: it returns a Promise inside the box, the host runs the
// call (serialized, one at a time) and resolves it, then pumps the box's job queue. This uses the sync WASM variant
// with promises rather than the asyncify variant: an asyncified host function cannot be called from a job queued
// after an await (the stack cannot be unwound twice), and model-written scripts await. Host time is not guest time,
// so the CPU deadline counts only time spent inside the box; the wall deadline counts everything.
//
// Limits (DEFAULT_CODE_LIMITS): heap and stack through the runtime, CPU and wall through the interrupt handler and a
// host timer, a call budget and a byte budget on inner results (an over-budget call is refused as data and the run
// ends CALL_BUDGET), a cap on the returned value and on captured console output. The box has no fetch, require,
// process, timers, filesystem or network: QuickJS ships none of them and nothing is injected but weft.call,
// console and inputs.
import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import type { CodeRunInput, CodeRunLimits, CodeRunResult, SandboxEngine } from "@weft/contracts";

type ErrorCode = NonNullable<CodeRunResult["error"]>["code"];
type HostCall = (name: string, args: unknown) => Promise<unknown>;

/** What the box gets back from weft.call when the host refuses before running anything. */
export function refusedAsData(code: string, message: string): Record<string, unknown> {
  return { ok: false, refusal: { code, message }, tainted: false };
}

/** The outcome label and taint of one inner result (a ToolOutcome-shaped value, or anything else). */
export function describeResult(v: unknown): { outcome: string; tainted: boolean } {
  const o = (v ?? {}) as { ok?: unknown; status?: unknown; refusal?: { code?: unknown }; tainted?: unknown };
  const tainted = o.tainted === true;
  if (o.ok === true) return { outcome: typeof o.status === "string" ? o.status : "ok", tainted };
  if (o.ok === false) return { outcome: `refused:${typeof o.refusal?.code === "string" ? o.refusal.code : "UNKNOWN"}`, tainted };
  return { outcome: "ok", tainted };
}

const PRELUDE = `"use strict";
(() => {
  const call = globalThis.__weft_call, log = globalThis.__weft_log, raw = globalThis.__weft_inputs;
  delete globalThis.__weft_call; delete globalThis.__weft_log; delete globalThis.__weft_inputs;
  const show = (a) => a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
  const rpc = (name, args) => call(String(name), JSON.stringify(args === undefined ? {} : args)).then((s) => JSON.parse(s));
  const weft = Object.freeze({
    call: rpc,
    memory: Object.freeze({ search: (query, opts) => rpc("memory__search", { ...(opts || {}), query }), read: (path) => rpc("memory__read", { path }) }),
  });
  Object.defineProperty(globalThis, "weft", { value: weft, enumerable: false, writable: false, configurable: false });
  const console = Object.freeze({ log: (...a) => log(show(a)), info: (...a) => log(show(a)), warn: (...a) => log(show(a)), error: (...a) => log(show(a)) });
  Object.defineProperty(globalThis, "console", { value: console, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(globalThis, "inputs", { value: JSON.parse(raw), enumerable: false, writable: false, configurable: false });
  Object.defineProperty(globalThis, "__weft_json", { value: (v) => (v === undefined ? "null" : JSON.stringify(v)), enumerable: false });
})();`;

/** The model's source runs as the body of an async function: it may await weft.call and must return its value. */
export function wrapSource(source: string): string {
  return `(async () => {\n${source}\n})()`;
}

function message(ctx: QuickJSContext, h: QuickJSHandle): string {
  try {
    const d = ctx.dump(h) as { name?: string; message?: string } | string | null;
    if (d && typeof d === "object") return `${d.name ?? "Error"}: ${d.message ?? ""}`.trim();
    return String(d);
  } catch {
    // Reading the error needs memory; when even that fails the heap is exhausted.
    return "InternalError: out of memory (the error could not be read)";
  }
}

function classify(msg: string, interrupted: "cpu" | "wall" | null): ErrorCode {
  if (interrupted) return "SANDBOX_TIMEOUT";
  if (/out of memory|stack overflow|Maximum call stack/i.test(msg)) return "SANDBOX_OOM";
  if (/interrupted/i.test(msg)) return "SANDBOX_TIMEOUT";
  return "SANDBOX_ERROR";
}

export function createQuickJsEngine(): SandboxEngine {
  return {
    id: "quickjs",
    async run(input: CodeRunInput, limits: CodeRunLimits, call: HostCall): Promise<CodeRunResult> {
      // A fresh WASM module per run (a few ms): an out-of-memory or teardown failure can never leak into the next run.
      const QuickJS = await newQuickJSWASMModule(RELEASE_SYNC);
      const wallStart = Date.now();
      const wallDeadline = wallStart + limits.wallMs;
      let guestMs = 0;
      let segStart = 0;
      let inGuest = false;
      let interrupted: "cpu" | "wall" | null = null;
      let budget: string | null = null;
      let logs = "";
      let logsCut = false;
      let tainted = false;
      let callBytes = 0;
      const calls: CodeRunResult["calls"] = [];
      const deferreds = new Set<QuickJSDeferredPromise>();
      let queue: Promise<void> = Promise.resolve();
      const inflight: Promise<{ d: QuickJSDeferredPromise; json: string }>[] = [];
      let rt: QuickJSRuntime | null = null;
      let ctx: QuickJSContext | null = null;
      const handles: QuickJSHandle[] = [];

      const result = (ok: boolean, value: unknown, error: CodeRunResult["error"]): CodeRunResult => ({
        ok, value: ok ? value : null, artifactRef: null, logs: logsCut ? `${logs}\n[logs cut at ${limits.maxLogBytes} bytes]` : logs, tainted, calls, error, memoryAt: "",
      });
      const fail = (code: ErrorCode, msg: string) => result(false, null, { code, message: msg.slice(0, 500) });
      const timeoutMessage = () => (interrupted === "wall" ? `the run passed the ${limits.wallMs} ms wall deadline` : `the script used more than ${limits.cpuMs} ms of CPU`);

      /** Run guest code, counting its time against the CPU deadline. */
      const guest = <T>(fn: () => T): T => {
        segStart = Date.now();
        inGuest = true;
        try { return fn(); } finally { inGuest = false; guestMs += Date.now() - segStart; }
      };

      try {
        rt = QuickJS.newRuntime();
        rt.setMemoryLimit(limits.heapBytes);
        rt.setMaxStackSize(limits.stackBytes);
        rt.setInterruptHandler(() => {
          const now = Date.now();
          if (now > wallDeadline) { interrupted = "wall"; return true; }
          if (inGuest && guestMs + (now - segStart) > limits.cpuMs) { interrupted = "cpu"; return true; }
          return false;
        });
        const c = rt.newContext();
        ctx = c;

        const logFn = c.newFunction("__weft_log", (h) => {
          const line = c.getString(h);
          if (logsCut) return;
          const next = logs ? `${logs}\n${line}` : line;
          if (Buffer.byteLength(next) > limits.maxLogBytes) { logs = Buffer.from(next).subarray(0, limits.maxLogBytes).toString(); logsCut = true; } else logs = next;
        });
        const callFn = c.newFunction("__weft_call", (nameH, argsH) => {
          const name = c.getString(nameH);
          const argsJson = c.getString(argsH);
          const d = c.newPromise();
          deferreds.add(d);
          const n = calls.length + 1;
          const settle = (json: string) => ({ d, json });
          if (n > limits.maxCalls || budget) {
            budget ??= `more than ${limits.maxCalls} weft.call calls`;
            calls.push({ command: name, outcome: "refused:CALL_BUDGET", ms: 0 });
            inflight.push(Promise.resolve(settle(JSON.stringify(refusedAsData("CALL_BUDGET", `At most ${limits.maxCalls} calls per code.run; this one was not run.`)))));
            return d.handle;
          }
          if (Buffer.byteLength(argsJson) > limits.maxCallBytes) {
            calls.push({ command: name, outcome: "refused:CALL_BUDGET", ms: 0 });
            budget ??= "an argument object over the byte budget";
            inflight.push(Promise.resolve(settle(JSON.stringify(refusedAsData("CALL_BUDGET", "The arguments are too large.")))));
            return d.handle;
          }
          const entry = { command: name, outcome: "pending", ms: 0 };
          calls.push(entry);
          // Serialized: inner calls share the executor's transaction, so they never overlap.
          const p = queue.then(async () => {
            const t0 = Date.now();
            let out: unknown;
            try {
              out = await call(name, JSON.parse(argsJson) as unknown);
            } catch (e) {
              out = refusedAsData("INTERNAL", e instanceof Error ? e.message.slice(0, 200) : "the host call failed");
            }
            entry.ms = Date.now() - t0;
            const desc = describeResult(out);
            entry.outcome = desc.outcome;
            tainted ||= desc.tainted;
            let json = JSON.stringify(out ?? null);
            callBytes += Buffer.byteLength(json);
            if (callBytes > limits.maxCallBytes) {
              budget ??= `inner results over ${limits.maxCallBytes} bytes`;
              entry.outcome = "refused:CALL_BUDGET";
              json = JSON.stringify(refusedAsData("CALL_BUDGET", `Inner results passed ${limits.maxCallBytes} bytes; ask for less (filters, limits, concise format).`));
            }
            return settle(json);
          });
          queue = p.then(() => undefined, () => undefined);
          inflight.push(p);
          return d.handle;
        });
        const inputsH = c.newString(JSON.stringify(input.inputs ?? null));
        handles.push(logFn, callFn, inputsH);
        c.setProp(c.global, "__weft_log", logFn);
        c.setProp(c.global, "__weft_call", callFn);
        c.setProp(c.global, "__weft_inputs", inputsH);

        const pre = guest(() => c.evalCode(PRELUDE, "prelude.js"));
        if (pre.error) { const m = message(c, pre.error); pre.error.dispose(); return fail("SANDBOX_ERROR", `prelude: ${m}`); }
        pre.value.dispose();

        const main = guest(() => c.evalCode(wrapSource(input.source), "code.js"));
        if (main.error) {
          const m = message(c, main.error);
          main.error.dispose();
          const code = classify(m, interrupted);
          return fail(code, code === "SANDBOX_TIMEOUT" ? timeoutMessage() : m);
        }
        const promise = main.value;
        handles.push(promise);

        for (;;) {
          const jobs = guest(() => rt!.executePendingJobs());
          if (jobs.error) {
            const m = message(c, jobs.error);
            jobs.error.dispose();
            const code = classify(m, interrupted);
            if (code !== "SANDBOX_ERROR") return fail(code, code === "SANDBOX_TIMEOUT" ? timeoutMessage() : m);
          }
          if (interrupted) return fail("SANDBOX_TIMEOUT", timeoutMessage());
          const state = c.getPromiseState(promise);
          if (state.type === "fulfilled") {
            const value = state.value;
            handles.push(value);
            const jsonFn = c.getProp(c.global, "__weft_json");
            handles.push(jsonFn);
            const out = guest(() => c.callFunction(jsonFn, c.undefined, value));
            if (out.error) {
              const m = message(c, out.error);
              out.error.dispose();
              const code = classify(m, interrupted);
              return fail(code, code === "SANDBOX_ERROR" ? `the return value is not JSON: ${m}` : m);
            }
            const json = c.getString(out.value);
            out.value.dispose();
            if (Buffer.byteLength(json) > limits.maxValueBytes) {
              return fail("SANDBOX_ERROR", `the return value is ${Buffer.byteLength(json)} bytes, over the ${limits.maxValueBytes} byte cap; return a smaller summary`);
            }
            if (budget) return fail("CALL_BUDGET", `the script made ${budget}`);
            return result(true, JSON.parse(json) as unknown, null);
          }
          if (state.type === "rejected") {
            const m = message(c, state.error);
            state.error.dispose();
            const code = classify(m, interrupted);
            if (budget && code === "SANDBOX_ERROR") return fail("CALL_BUDGET", `the script made ${budget}, then failed: ${m}`);
            return fail(code, code === "SANDBOX_TIMEOUT" ? timeoutMessage() : m);
          }
          if (inflight.length === 0) return fail("SANDBOX_ERROR", "the script is waiting on a promise that nothing resolves (only weft.call is asynchronous)");
          // Wait for the next host call, but never past the wall deadline.
          const left = wallDeadline - Date.now();
          let timer: NodeJS.Timeout | undefined;
          const next = await Promise.race([
            inflight[0]!,
            new Promise<null>((ok) => { timer = setTimeout(() => ok(null), Math.max(0, left)); }),
          ]);
          clearTimeout(timer);
          if (next === null) { interrupted = "wall"; return fail("SANDBOX_TIMEOUT", timeoutMessage()); }
          inflight.shift();
          const s = c.newString(next.json);
          next.d.resolve(s);
          s.dispose();
          deferreds.delete(next.d);
          next.d.dispose();
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        return fail(classify(m, interrupted), m);
      } finally {
        // Inner calls share the caller's transaction: let any in flight finish before the caller moves on.
        await Promise.allSettled(inflight);
        for (const d of deferreds) { try { d.dispose(); } catch { /* already gone */ } }
        for (const h of handles) { try { if (h.alive) h.dispose(); } catch { /* already gone */ } }
        try { ctx?.dispose(); } catch { /* a teardown error never crashes the run (harness 3.5) */ }
        try { rt?.dispose(); } catch { /* same */ }
      }
    },
  };
}
