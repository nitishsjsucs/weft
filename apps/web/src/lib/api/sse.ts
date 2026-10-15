"use client";
// Live run steps (SPEC 9.6): SSE over fetch (so the "Viewing as" principal header rides along), with a 1 s trace
// polling fallback whenever the stream is unavailable, blocked or ends early. Steps are merged by step number.
import type { AgentRunRow, RunStatus, RunStepRow, RunTrace } from "@weft/contracts";
import { getPrincipal, rawFetch } from "./hooks";
import { mocksEnabled } from "./mocks";

export const TERMINAL: RunStatus[] = ["done", "failed", "refused", "escalated", "expired", "cancelled"];
export const isTerminal = (s: RunStatus | undefined) => !!s && TERMINAL.includes(s);
/** Paused runs (waiting for an approval, or held) wake later, so they are re-checked slowly. */
export const isPaused = (s: RunStatus | undefined) => s === "waiting" || s === "held";

export interface RunWatch { run: AgentRunRow | null; steps: RunStepRow[]; trace: RunTrace | null; mode: "sse" | "polling" | "idle" }

/** Parses an SSE byte stream into (event, data) pairs. Exported for tests. */
export function createSseParser(onEvent: (event: string, data: string) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) onEvent(event, data.join("\n"));
    }
  };
}

export function mergeSteps(prev: RunStepRow[], incoming: RunStepRow[]): RunStepRow[] {
  const byN = new Map(prev.map((s) => [s.n, s]));
  for (const s of incoming) byN.set(s.n, s);
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

/**
 * Watches a run until it reaches a terminal or waiting state. Returns a stop function.
 * `forcePolling` (or `?sse=off` in the page URL, or mocks) skips SSE to exercise the fallback.
 */
export function watchRun(runId: string, onUpdate: (w: RunWatch) => void, opts: { forcePolling?: boolean } = {}): () => void {
  let stopped = false;
  let state: RunWatch = { run: null, steps: [], trace: null, mode: "idle" };
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const ctrl = new AbortController();
  const emit = (patch: Partial<RunWatch>) => { state = { ...state, ...patch }; if (!stopped) onUpdate(state); };
  const headers = () => ({ accept: "application/json", "x-weft-principal": getPrincipal() });

  async function pollOnce(): Promise<boolean> {
    if (stopped) return true;
    try {
      const res = await rawFetch(`/api/v1/agent/runs/${encodeURIComponent(runId)}/trace`, { headers: headers(), signal: ctrl.signal });
      if (!res.ok) return false;
      const trace = (await res.json()) as RunTrace;
      emit({ trace, run: trace.run, steps: mergeSteps(state.steps, trace.steps) });
      return isTerminal(trace.run.status);
    } catch { return false; }
  }
  function startPolling() {
    if (stopped || pollTimer) return;
    emit({ mode: "polling" });
    const loop = async () => {
      pollTimer = null;
      const done = await pollOnce();
      if (!stopped && !done) pollTimer = setTimeout(loop, isPaused(state.run?.status) ? 3_000 : 1_000);
    };
    void loop();
  }

  const sseOff = opts.forcePolling || mocksEnabled || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("sse") === "off");
  if (sseOff) startPolling();
  else {
    void (async () => {
      try {
        const res = await fetch(`/api/v1/agent/runs/${encodeURIComponent(runId)}/events`, { headers: { ...headers(), accept: "text/event-stream" }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        emit({ mode: "sse" });
        void pollOnce(); // history and the run row
        const parse = createSseParser((event, data) => {
          try {
            const v = JSON.parse(data) as unknown;
            if (v && typeof v === "object" && "n" in v && "stage" in v) emit({ steps: mergeSteps(state.steps, [v as RunStepRow]) });
            else if (v && typeof v === "object" && "status" in v && "id" in v) emit({ run: v as AgentRunRow });
            else if (v && typeof v === "object" && "run" in v && "steps" in v) { const t = v as RunTrace; emit({ trace: t, run: t.run, steps: mergeSteps(state.steps, t.steps) }); }
            if (event === "end" || event === "done" || event === "run.finished") void pollOnce();
          } catch { /* ignore malformed frames */ }
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parse(value);
        }
        if (!stopped && !isTerminal(state.run?.status)) startPolling();
        else void pollOnce();
      } catch {
        if (!stopped) startPolling();
      }
    })();
  }
  return () => { stopped = true; ctrl.abort(); if (pollTimer) clearTimeout(pollTimer); };
}
