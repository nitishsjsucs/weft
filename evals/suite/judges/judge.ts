// One judge call through Weft's own provider (owner: w4-eval-heldout). The provider comes from createProvider, so the
// live guard applies (tests get the scripted provider unless WEFT_LIVE_OPENAI=1), and every call reserves and settles
// against Weft's spend ledger before and after the model step. `phoenix-evals` is used for nothing at run time: it
// would call OpenAI directly and bypass the ledger.
import type { JudgeId, JudgeVerdict } from "../../../packages/contracts/src/evals";
import type { ModelProvider, SpendLedger, Usage } from "../../../packages/contracts/src/index";
import { pricesFor, reserveUsd, stepCostUsd, usdToMicros } from "../../../packages/agent/src/cost";
import { judgeSystemPrompt, renderCase, JUDGE_PROMPT_VERSION, type FewShot, type JudgeCase } from "./prompts";

export const JUDGE_MAX_OUTPUT_TOKENS = 300;
/** A judge call never needs more than this; a reservation above it means the case was not bounded. */
export const JUDGE_CALL_USD_CAP = 0.005;

export interface JudgeStatus { promptVersion: string; counts: boolean }

export interface RunJudgeInput {
  judge: JudgeId;
  case: JudgeCase;
  provider: ModelProvider;
  ledger: SpendLedger;
  fewShot?: readonly FewShot[];
  /** The latest validation result for this judge; a verdict is `validated` only when it counts for this prompt version. */
  status?: JudgeStatus | null;
  env?: Record<string, string | undefined>;
  /** Called with the worst-case USD before the call (the wave ledger check); throw to stop. */
  beforeSpend?: (worstUsd: number) => void;
  /** Called with the settled USD after the call (the wave ledger append). */
  afterSpend?: (usd: number) => void;
}

export interface RunJudgeResult { verdict: JudgeVerdict | null; error: string | null; usage: Usage | null; costUsd: number }

/** Parses `{"reason": ..., "verdict": "pass"|"fail"}` from the model text; the reason must come first and be non-empty. */
export function parseJudgeOutput(text: string): { pass: boolean; reason: string } | { error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "JUDGE_PARSE: no JSON object in the output" };
  let o: unknown;
  try { o = JSON.parse(text.slice(start, end + 1)); } catch { return { error: "JUDGE_PARSE: the JSON object does not parse" }; }
  if (!o || typeof o !== "object") return { error: "JUDGE_PARSE: not an object" };
  const keys = Object.keys(o);
  const rec = o as Record<string, unknown>;
  if (typeof rec.reason !== "string" || !rec.reason.trim()) return { error: "JUDGE_PARSE: missing reason" };
  if (rec.verdict !== "pass" && rec.verdict !== "fail") return { error: "JUDGE_PARSE: verdict is not pass or fail" };
  if (keys.indexOf("reason") > keys.indexOf("verdict")) return { error: "JUDGE_PARSE: verdict came before the reason" };
  return { pass: rec.verdict === "pass", reason: rec.reason.trim() };
}

export async function runJudge(input: RunJudgeInput): Promise<RunJudgeResult> {
  const { judge, provider, ledger } = input;
  const env = input.env ?? process.env;
  const frozenPrompt = judgeSystemPrompt(judge, input.fewShot ?? []);
  const userText = renderCase(input.case);
  const prices = pricesFor(provider.id, env, provider.model);
  const approxInput = Math.ceil((frozenPrompt.length + userText.length) / 3.5);
  const worst = reserveUsd(approxInput, JUDGE_MAX_OUTPUT_TOKENS, prices);
  if (worst > JUDGE_CALL_USD_CAP) return { verdict: null, error: `JUDGE_BUDGET: worst case $${worst.toFixed(4)} is over $${JUDGE_CALL_USD_CAP}`, usage: null, costUsd: 0 };
  input.beforeSpend?.(worst);
  const runId = `judge_${judge}_${input.case.id}`.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 120);
  const res = await ledger.reserve({ runId, usdMicros: usdToMicros(worst), model: provider.model, live: provider.live });
  if (!res.ok) return { verdict: null, error: `BUDGET_EXCEEDED: ${res.cap} cap`, usage: null, costUsd: 0 };
  let costUsd = 0;
  try {
    const step = await provider.step({
      runId, agentKind: "main", model: provider.model, frozenPrompt, tools: [], toolChoice: { mode: "auto" },
      history: [{ kind: "user", text: userText }], effort: "low", maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      cacheKey: `weft:judge:${judge}:${JUDGE_PROMPT_VERSION}`,
    });
    costUsd = stepCostUsd(step.usage, prices);
    await ledger.settle(res.reservationId, usdToMicros(costUsd));
    input.afterSpend?.(costUsd);
    if (step.stop === "error") return { verdict: null, error: `PROVIDER: ${step.error?.code ?? "error"}`, usage: step.usage, costUsd };
    const parsed = parseJudgeOutput(step.text);
    if ("error" in parsed) return { verdict: null, error: parsed.error, usage: step.usage, costUsd };
    const validated = Boolean(input.status?.counts && input.status.promptVersion === JUDGE_PROMPT_VERSION);
    return { verdict: { judge, pass: parsed.pass, reason: parsed.reason, validated, costUsd }, error: null, usage: step.usage, costUsd };
  } catch (e) {
    await ledger.release(res.reservationId).catch(() => undefined);
    return { verdict: null, error: `PROVIDER: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, usage: null, costUsd };
  }
}
