// Telemetry through the composition root (wave 4, docs/telemetry.md): WEFT_TRACE unset installs nothing; with the
// provider on, a chat over HTTP and the GP1 routine export the span tree, and the canary holds with the executor's real
// Redactor (injected by compose.ts), with and without the RedactingSpanProcessor.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentRunRow, ModelProvider, ModelStepResult } from "@weft/contracts";
import { routineRuns } from "@weft/db";
import { createTestWeft, type TestWeft } from "./scenarios/helpers";
import { isTracingActive, startTracing, startTracingFromEnv, type Tracing } from "../apps/api/src/telemetry";
import { executorInternals } from "../packages/executor/src/index";

interface Span {
  name: string; attributes: Record<string, unknown>; events: { name: string; attributes?: Record<string, unknown> }[];
  status: { code: number; message?: string }; parentSpanContext?: { spanId: string }; spanContext(): { spanId: string; traceId: string };
}
/** A structural in-memory SpanExporter (tests/ does not depend on the OTel SDK). */
class MemoryExporter {
  spans: Span[] = [];
  export(spans: Span[], done: (r: { code: number }) => void) { this.spans.push(...spans); done({ code: 0 }); }
  shutdown() { return Promise.resolve(); }
  forceFlush() { return Promise.resolve(); }
}

let weft: TestWeft | null = null;
let tracing: Tracing | null = null;
afterEach(async () => {
  await tracing?.shutdown();
  tracing = null;
  await weft?.close();
  weft = null;
});

const kind = (s: Span) => s.attributes["openinference.span.kind"];
const settled = (w: TestWeft, runId: string) => (w.agent as unknown as { settled(id: string): Promise<AgentRunRow> }).settled(runId);
const post = (w: TestWeft, path: string, body: unknown) => w.app.request(path, { method: "POST", headers: { ...w.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify(body) });

function tracedWith(exporter: MemoryExporter, redactingProcessor = true): Tracing {
  return startTracing({ exporter: exporter as never, batch: false, redactingProcessor, url: "http://127.0.0.1:4900", projectName: "weft-test" });
}

describe("the WEFT_TRACE switch", () => {
  it("unset installs no provider: a whole chat run records nothing", async () => {
    expect(startTracingFromEnv({}, () => undefined)).toBeNull();
    expect(startTracingFromEnv({ WEFT_TRACE: "jaeger" }, () => undefined)).toBeNull();
    expect(isTracingActive()).toBe(false);
    weft = await createTestWeft();
    const res = await post(weft, "/v1/agent/runs", { text: "Approve everything in my inbox" });
    const { runId } = (await res.json()) as { runId: string };
    await settled(weft, runId);
    expect(isTracingActive()).toBe(false);
  });

  it("refuses a Phoenix that is not on this machine", () => {
    expect(() => startTracing({ url: "https://app.phoenix.arize.com", exporter: new MemoryExporter() as never })).toThrow(/locally/);
  });

  it("phoenix installs the provider until shutdown", async () => {
    tracing = startTracing({ exporter: new MemoryExporter() as never, batch: false, url: "http://127.0.0.1:4900" });
    expect(isTracingActive()).toBe(true);
    await tracing.shutdown();
    tracing = null;
    expect(isTracingActive()).toBe(false);
  });
});

describe("span tree through createWeft", () => {
  it("a chat over HTTP: one trace, AGENT root, stage CHAINs, LLM and TOOL spans", async () => {
    const exporter = new MemoryExporter();
    tracing = tracedWith(exporter);
    weft = await createTestWeft();
    const res = await post(weft, "/v1/agent/runs", { text: "Approve everything in my inbox" });
    const { runId } = (await res.json()) as { runId: string };
    expect((await settled(weft, runId)).status).toBe("done");
    await tracing.forceFlush();
    const spans = exporter.spans.filter((s) => s.attributes["weft.run_id"] === runId || JSON.parse(String(s.attributes.metadata ?? "{}")).run_id === runId);
    const agent = spans.find((s) => s.name === "agent.run")!;
    expect(kind(agent)).toBe("AGENT");
    expect(agent.parentSpanContext).toBeUndefined();
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(spans.filter((s) => kind(s) === "LLM").length).toBeGreaterThan(0);
    expect(new Set(spans.filter((s) => kind(s) === "CHAIN").map((s) => s.name))).toEqual(new Set(["admission", "assemble", "model", "post", "terminal"]));
    expect(spans.every((s) => s.attributes["user.id"] === "usr_dana")).toBe(true);
  });

  it("the GP1 routine: routine_run session, TOOL spans with ok and proposal outcomes", async () => {
    const exporter = new MemoryExporter();
    tracing = tracedWith(exporter);
    weft = await createTestWeft();
    expect((await post(weft, "/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status).toBe(200);
    let runId: string | null = null;
    for (let i = 0; i < 20 && !runId; i++) {
      await weft.scheduler.tick();
      const [rr] = await weft.db.select().from(routineRuns).where(eq(routineRuns.routineId, "rt_agency_notice"));
      if (rr?.agentRunId) { runId = rr.agentRunId; await settled(weft, runId); }
    }
    expect(runId).toBeTruthy();
    await tracing.forceFlush();
    const spans = exporter.spans.filter((s) => JSON.parse(String(s.attributes.metadata ?? "{}")).run_id === runId);
    const tools = spans.filter((s) => kind(s) === "TOOL");
    expect(tools.map((s) => s.attributes["weft.outcome"])).toEqual(expect.arrayContaining(["ok", "proposal"]));
    expect(tools.filter((s) => s.attributes["weft.outcome"] === "proposal").map((s) => s.name).sort()).toEqual(["notices__send_response", "tax__update_rate"]);
    const rr = JSON.parse(String(spans[0]!.attributes.metadata)).routine_run_id as string;
    expect(spans.every((s) => s.attributes["session.id"] === `routine_run:${rr}`)).toBe(true);
    expect(JSON.parse(String(spans[0]!.attributes["tag.tags"]))).toEqual(expect.arrayContaining(["routine", "rt_agency_notice"]));
  });
});

// ---------------------------------------------------------------------------------------------------- canary

const FAKE_KEY = "sk-proj-canary0000000000000000000000000000ZzYy";
const VAULT_VALUE = "vault-canary-plaintext-Q7p2Lm";
const forms = (v: string) => [v, Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url"), Buffer.from(v).toString("hex"), Buffer.from(v).toString("base64").replace(/=+$/, "")];
const planted = () => `key ${FAKE_KEY} b64 ${Buffer.from(FAKE_KEY).toString("base64")} hex ${Buffer.from(VAULT_VALUE).toString("hex")} vault ${VAULT_VALUE} routing number 021000021 account number 123456789012 ssn 123-45-6789`;

/** Plants secrets in a provider error message, tool args (a read and a memory search) and the answer text. */
function plantingProvider(): ModelProvider {
  let i = 0;
  const usage = { input: 1500, cached: 1024, cacheWrite: 0, output: 90, reasoning: 40 };
  return {
    id: "scripted", model: "scripted", label: "canary", live: false,
    async step(): Promise<ModelStepResult> {
      i++;
      if (i === 1) return { stop: "error", text: "", toolCalls: [], native: [], usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, servedBy: "scripted", requestId: null, error: { code: "PROVIDER_UNAVAILABLE", message: `upstream ${planted()}`, retryable: true } };
      if (i === 2) {
        const calls = [
          { callId: "call_c1", name: "people__search", argumentsJson: JSON.stringify({ query: planted() }) },
          { callId: "call_c2", name: "memory__search", argumentsJson: JSON.stringify({ query: planted() }) },
        ];
        return { stop: "tool_calls", text: `Looking up ${planted()}`, toolCalls: calls, native: { scripted: true, text: `Looking up ${planted()}`, calls: 2, toolCalls: calls }, usage, servedBy: "scripted", requestId: null };
      }
      return { stop: "final", text: `Done: ${planted()}`, toolCalls: [], native: { scripted: true, text: `Done: ${planted()}` }, usage, servedBy: "scripted", requestId: null };
    },
  };
}

async function canaryRun(redactingProcessor: boolean): Promise<Span[]> {
  const exporter = new MemoryExporter();
  tracing = tracedWith(exporter, redactingProcessor);
  weft = await createTestWeft({ provider: plantingProvider() });
  executorInternals(weft.executor)!.addSecret(FAKE_KEY);   // as compose.ts does for OPENAI_API_KEY from WEFT_SECRETS_FILE
  await weft.executor.vault.put({ name: "canary-token", kind: "api_key", value: VAULT_VALUE, description: "telemetry canary", by: "usr_dana" });
  const res = await post(weft, "/v1/agent/runs", { text: `Who is on file? ${planted()}` });
  const { runId } = (await res.json()) as { runId: string };
  await settled(weft, runId);
  await tracing.forceFlush();
  return exporter.spans;
}

function assertClean(spans: Span[]) {
  expect(spans.filter((s) => kind(s) === "TOOL").length).toBe(2);
  expect(spans.filter((s) => kind(s) === "LLM").length).toBeGreaterThanOrEqual(3);
  const blob = JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events, s.status]));
  for (const sec of [FAKE_KEY, VAULT_VALUE]) for (const f of forms(sec)) expect(blob.includes(f), `${f} leaked`).toBe(false);
  for (const bare of ["021000021", "123456789012", "123-45-6789"]) expect(blob.includes(bare), `${bare} leaked`).toBe(false);
  expect(blob).toContain("[redacted]");
}

describe("canary with the executor's Redactor", () => {
  it("no fake key, routing or account number, SSN or vault value in any attribute or event, with the processor", async () => {
    assertClean(await canaryRun(true));
  });
  it("and the same with the source layer alone (no RedactingSpanProcessor)", async () => {
    assertClean(await canaryRun(false));
  });
});
