// Judge tooling CLI (owner: w4-eval-heldout). Run from the repo root with node_modules/.bin/tsx.
//   report --labels <file> [--status <out.json>] [--md <out.md>]   TPR, TNR and Wilson intervals per judge
//   export --phoenix <url> --project <name> --spans <file> --out <labels.json>   Phoenix human.* annotations to labels
//   import --phoenix <url> --labels <file>                         labels (and judge verdicts) to Phoenix annotations
//   pilot  --cases <file> [--out <file>]                           live judge calls on gpt-5.6-luna, opt-in and capped
// The pilot needs WEFT_LIVE_OPENAI=1, WEFT_LLM=openai and WEFT_SECRETS_FILE; it checks the shared wave 4 ledger
// before each call and appends what it spent, under the stage cap of $0.10 for w4-eval-heldout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JudgeId } from "../../../packages/contracts/src/evals";
import { JudgeId as JudgeIdEnum } from "../../../packages/contracts/src/evals";
import { exportLabels, annotationsFor, writeAnnotations } from "./phoenix";
import type { JudgeCase } from "./prompts";
import { JUDGE_PROMPT_VERSION } from "./prompts";
import { judgeStatus, parseLabelFile, reportMarkdown, validationReport } from "./validate";

const ROOT = resolve(import.meta.dirname, "../../..");
export const STAGE = "w4-eval-heldout";
export const STAGE_CAP_USD = 0.1;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const need = (name: string) => { const v = arg(name); if (!v) { console.error(`missing --${name}`); process.exit(2); } return v; };
const writeOut = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "report") {
    const file = parseLabelFile(JSON.parse(readFileSync(need("labels"), "utf8")));
    const reports = validationReport(file.labels);
    const md = reportMarkdown(reports);
    process.stdout.write(md);
    const status = arg("status"); if (status) writeOut(status, `${JSON.stringify(judgeStatus(reports), null, 2)}\n`);
    const mdOut = arg("md"); if (mdOut) writeOut(mdOut, md);
    return;
  }
  if (cmd === "export") {
    const spans = readFileSync(need("spans"), "utf8").split(/\s+/).filter(Boolean);
    const labels = await exportLabels({ baseUrl: need("phoenix"), project: need("project") }, spans);
    writeOut(need("out"), `${JSON.stringify({ version: 1, labels }, null, 2)}\n`);
    console.log(`exported ${labels.length} labels from ${spans.length} spans`);
    return;
  }
  if (cmd === "import") {
    const file = parseLabelFile(JSON.parse(readFileSync(need("labels"), "utf8")));
    const n = await writeAnnotations({ baseUrl: need("phoenix") }, annotationsFor(file.labels));
    console.log(`wrote ${n} annotations`);
    return;
  }
  if (cmd === "pilot") {
    if (process.env.WEFT_LIVE_OPENAI !== "1" || process.env.WEFT_LLM !== "openai") {
      console.error("pilot is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=openai with WEFT_SECRETS_FILE");
      process.exit(2);
    }
    process.env.WEFT_LIVE_USD_CAP ??= "0.10";
    const { createProvider, createSpendLedger } = await import("../../../packages/agent/src/index");
    const { assertWaveBudget, appendWaveSpend } = await import("../../../scripts/wave-ledger");
    const { runJudge } = await import("./judge");
    const cases = JSON.parse(readFileSync(need("cases"), "utf8")) as { judge: JudgeId; expected: "pass" | "fail"; case: JudgeCase }[];
    const ledger = createSpendLedger({ dir: join(ROOT, ".data/eval-judges/spend"), env: process.env });
    const provider = createProvider({ env: process.env, ledger, testMode: false });
    const rows: unknown[] = [];
    let spent = 0;
    for (const c of cases) {
      JudgeIdEnum.parse(c.judge);
      const r = await runJudge({
        judge: c.judge, case: c.case, provider, ledger,
        beforeSpend: (worst) => { assertWaveBudget({ stage: STAGE, stageCapUsd: STAGE_CAP_USD, nextUsd: worst }); },
        afterSpend: (usd) => { spent += usd; },
      });
      rows.push({ id: c.case.id, judge: c.judge, expected: c.expected, got: r.verdict ? (r.verdict.pass ? "pass" : "fail") : null, reason: r.verdict?.reason ?? null, error: r.error, usd: r.costUsd, usage: r.usage });
      console.log(`${c.judge} ${c.case.id}: expected ${c.expected}, got ${r.verdict ? (r.verdict.pass ? "pass" : "fail") : `error ${r.error}`} ($${r.costUsd.toFixed(5)})`);
    }
    if (spent > 0) appendWaveSpend({ stage: STAGE, usd: spent, cap: STAGE_CAP_USD, note: `judge pilot, ${cases.length} calls, prompt ${JUDGE_PROMPT_VERSION}` });
    const out = arg("out"); if (out) writeOut(out, `${JSON.stringify({ promptVersion: JUDGE_PROMPT_VERSION, model: provider.model, spentUsd: spent, rows }, null, 2)}\n`);
    console.log(`spent $${spent.toFixed(5)} on ${provider.model}`);
    return;
  }
  console.error("usage: cli.ts report|export|import|pilot (see the header)");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
