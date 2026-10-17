// Telemetry seam (wave 4, docs/wave4.md section 3). Owner: w4-telemetry, which replaces the bodies with OpenTelemetry
// and OpenInference spans per research/wave4/phoenix.md. The exported names and signatures are the contract the eval
// runner and apps/api code against; until the track lands they record nothing and send nothing.
import type { EvalTraceTags, RunTraceTags, TraceRedact } from "@weft/contracts";

let redact: TraceRedact = (v) => v;
/** apps/api/src/compose.ts injects the executor's Redactor (value redaction) here; the brain never imports the vault. */
export function setTraceRedactor(r: TraceRedact): void { redact = r; }
/** Every span attribute value passes through this before it is set. */
export function traceRedact<T>(value: T): T { return redact(value); }

let tags: Partial<EvalTraceTags> | null = null;
/** Process-wide eval tags: the eval runner sets them before a trial and clears them after (trials run one at a time). */
export const runTraceTags: RunTraceTags = {
  set(next) { tags = next ? { ...next } : null; },
  current() { return tags ? { ...tags } : null; },
};
