// Tracing provider (wave 4, docs/wave4.md section 3, research/wave4/phoenix.md 5.6, docs/telemetry.md). Owner:
// w4-telemetry. WEFT_TRACE=phoenix registers one OpenTelemetry provider that exports OTLP over HTTP (protobuf) to a
// local Phoenix; unset, nothing is registered, the OTel API stays a no-op and nothing is sent. Phoenix is local
// only: a URL that is not loopback is refused, and no Phoenix API key or header is ever sent.
//
// Redaction layer 3: RedactingSpanProcessor re-runs the executor's Redactor (injected into the brain by compose.ts
// and read back through traceRedact) over every string attribute, event attribute and status message in onEnding,
// while the span is still writable. Layer 1, at the source in packages/agent/src/otel.ts, is the one that counts.
import { LazyOpenInferenceSpanProcessor, OTLPTraceExporter, register, type NodeTracerProvider } from "@arizeai/phoenix-otel";
import { trace, type AttributeValue } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PHOENIX, TRACE_ENV } from "@weft/contracts";
import { traceRedact } from "@weft/agent";

type Env = Record<string, string | undefined>;

/** Second line of defense: redacts every string a finished span carries, before any exporter sees it. */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly redact: (s: string) => string = (s) => traceRedact(s)) {}
  onStart(): void {}
  onEnding(span: Span): void {
    const fix = (v: AttributeValue | undefined): AttributeValue | undefined => {
      if (typeof v === "string") return this.redact(v);
      if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? this.redact(x) : x)) as AttributeValue;
      return v;
    };
    for (const [k, v] of Object.entries(span.attributes)) {
      const r = fix(v);
      if (r !== undefined && JSON.stringify(r) !== JSON.stringify(v)) span.setAttribute(k, r);
    }
    for (const ev of span.events) {
      const attrs = ev.attributes as Record<string, AttributeValue | undefined> | undefined;
      if (!attrs) continue;
      for (const [k, v] of Object.entries(attrs)) attrs[k] = fix(v);
    }
    if (span.status.message) span.setStatus({ ...span.status, message: this.redact(span.status.message) });
  }
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

export interface TracingOptions {
  /** The Phoenix base URL (default WEFT_PHOENIX_URL, else http://127.0.0.1:<WEFT_PHOENIX_PORT or 6206>). Loopback only. */
  url?: string;
  /** The Phoenix project (default WEFT_PHOENIX_PROJECT, else "weft"). */
  projectName?: string;
  /** Tests pass an in-memory exporter; otherwise OTLP over HTTP to <url>/v1/traces. */
  exporter?: SpanExporter;
  /** Batch spans (default true; tests and smoke scripts pass false to export each span as it ends). */
  batch?: boolean;
  /** Install RedactingSpanProcessor (default true; the canary test turns it off to prove the source layer alone). */
  redactingProcessor?: boolean;
  env?: Env;
}

export interface Tracing {
  readonly provider: NodeTracerProvider;
  readonly url: string;
  readonly projectName: string;
  forceFlush(): Promise<void>;
  /** Flushes and detaches the global provider, so the OTel API is a no-op again. */
  shutdown(): Promise<void>;
}

/** True when a recording provider is registered (a probe span; nothing is exported because it never ends). */
export function isTracingActive(): boolean {
  return trace.getTracer("weft-probe").startSpan("probe").isRecording();
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function phoenixUrl(env: Env = process.env): string {
  return (env[TRACE_ENV.url] ?? `http://${PHOENIX.host}:${env.WEFT_PHOENIX_PORT ?? PHOENIX.httpPort}`).replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
}

export function startTracing(o: TracingOptions = {}): Tracing {
  const env = o.env ?? process.env;
  const url = (o.url ?? phoenixUrl(env)).replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) throw new Error(`WEFT_TRACE: Phoenix must run locally (got host ${host}); Weft never exports to a hosted account`);
  const projectName = o.projectName ?? env[TRACE_ENV.project] ?? PHOENIX.devProject;
  const exporter = o.exporter ?? new OTLPTraceExporter({ url: `${url}/v1/traces` });
  const spanProcessors: SpanProcessor[] = [
    ...(o.redactingProcessor === false ? [] : [new RedactingSpanProcessor()]),   // first: onEnding runs in array order
    new LazyOpenInferenceSpanProcessor({ exporter, batch: o.batch ?? true }),
  ];
  // spanProcessors replaces register's default exporter, so its url, apiKey and headers are never used.
  const provider = register({ projectName, url, spanProcessors: spanProcessors as never, global: true });
  let closed = false;
  return {
    provider, url, projectName,
    forceFlush: () => provider.forceFlush(),
    async shutdown() {
      if (closed) return;
      closed = true;
      await provider.shutdown().catch(() => undefined);
      const { detachGlobalTracerProvider } = await import("@arizeai/phoenix-otel");
      detachGlobalTracerProvider();
    },
  };
}

/**
 * The API's switch (apps/api/src/main.ts). WEFT_TRACE unset (or anything but "phoenix") installs nothing and returns
 * null. With phoenix, spans are batched and flushed on SIGINT, SIGTERM and beforeExit.
 */
export function startTracingFromEnv(env: Env = process.env, log: (line: string) => void = (l) => console.log(l)): Tracing | null {
  const mode = (env[TRACE_ENV.switch] ?? "").trim();
  if (!mode) return null;
  if (mode !== "phoenix") { log(`weft tracing: ${TRACE_ENV.switch}=${mode.slice(0, 20)} is not supported (use phoenix); tracing stays off`); return null; }
  const tracing = startTracing({ env });
  log(`weft tracing: exporting to Phoenix at ${tracing.url} (project ${tracing.projectName})`);
  const flush = () => { void tracing.forceFlush().catch(() => undefined); };
  process.once("SIGINT", flush);
  process.once("SIGTERM", flush);
  process.once("beforeExit", () => { void tracing.shutdown(); });
  return tracing;
}
