// Label round trip against a running local Phoenix (owner: w4-eval-heldout). No model calls, no spend.
//   node_modules/.bin/tsx evals/suite/judges/smoke.ts --phoenix http://127.0.0.1:<port>
// Creates three synthetic AGENT root spans in the project `weft-judges-smoke`, writes human.* labels and llm.*
// verdicts through writeAnnotations, reads them back through exportLabels and checks they match.
import { randomBytes } from "node:crypto";
import { annotationsFor, assertLocal, exportLabels, writeAnnotations } from "./phoenix";
import { JUDGE_PROMPT_VERSION } from "./prompts";
import { parseLabel, type JudgeLabel } from "./validate";

const i = process.argv.indexOf("--phoenix");
const baseUrl = assertLocal(i >= 0 ? process.argv[i + 1]! : "http://127.0.0.1:6206");
const project = "weft-judges-smoke";
const hex = (n: number) => randomBytes(n).toString("hex");
const traceId = hex(16);
const spans = [hex(8), hex(8), hex(8)];
const now = Date.now();

const created = await fetch(`${baseUrl}/v1/projects/${project}/spans`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ data: spans.map((spanId, k) => ({
    name: "agent.run", context: { trace_id: traceId, span_id: spanId }, span_kind: "AGENT", parent_id: null,
    start_time: new Date(now + k * 1000).toISOString(), end_time: new Date(now + k * 1000 + 500).toISOString(), status_code: "OK",
    attributes: { "openinference.span.kind": "AGENT", "session.id": `smoke-${k}`, "input.value": "synthetic smoke input" },
  })) }),
});
if (!created.ok) throw new Error(`span create answered ${created.status}: ${(await created.text()).slice(0, 300)}`);

// Ingestion is asynchronous: wait until the spans are queryable.
for (let t = 0; t < 40; t++) {
  const r = await fetch(`${baseUrl}/v1/projects/${project}/spans?trace_id=${traceId}&limit=10`);
  if (r.ok && ((await r.json()) as { data?: unknown[] }).data?.length === spans.length) break;
  await new Promise((res) => setTimeout(res, 250));
}

const labels: JudgeLabel[] = [
  parseLabel({ id: spans[0], spanId: spans[0], judge: "J2_clarify", human: "fail", critique: "Picked a state without asking.", judgeVerdict: "fail", judgeReason: "No question asked.", promptVersion: JUDGE_PROMPT_VERSION }),
  parseLabel({ id: spans[1], spanId: spans[1], judge: "J4_no_invention", human: "pass", critique: "Says the data is not there.", judgeVerdict: null }),
  parseLabel({ id: spans[2], spanId: spans[2], judge: "J3_next_step", human: "pass", critique: "Points to the screen.", judgeVerdict: "fail", judgeReason: "No next step named.", promptVersion: JUDGE_PROMPT_VERSION }),
];
const wrote = await writeAnnotations({ baseUrl }, annotationsFor(labels));
let back: JudgeLabel[] = [];
for (let t = 0; t < 40; t++) {
  back = await exportLabels({ baseUrl, project }, spans);
  if (back.length === labels.length && back.every((b) => b.judgeVerdict !== null || b.judge === "J4_no_invention")) break;
  await new Promise((res) => setTimeout(res, 250));
}
const key = (l: JudgeLabel) => `${l.judge}|${l.id}`;
const want = [...labels].sort((a, b) => (key(a) < key(b) ? -1 : 1));
const got = [...back].sort((a, b) => (key(a) < key(b) ? -1 : 1));
const same = JSON.stringify(want) === JSON.stringify(got);
console.log(`wrote ${wrote} annotations on ${spans.length} spans; read back ${back.length} labels; round trip ${same ? "ok" : "MISMATCH"}`);
if (!same) { console.log(JSON.stringify({ want, got }, null, 2)); process.exit(1); }
