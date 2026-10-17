import { z } from "zod";
import { EvalVariant } from "./telemetry";
// Wave 4 eval task schema (docs/wave4.md section 4, research/wave4/evals.md sections 4 to 7). Owners: w4-eval-suite
// (runner, graders, dev tasks) and w4-eval-heldout (test tasks, judges). Tasks live in evals/suite/tasks/<split>/<id>.json.
// No task literal (names, amounts, ids a task introduces) may appear under packages/ or apps/ (the anti-leak scan).

export const EvalSplit = z.enum(["dev", "test"]); export type EvalSplit = z.infer<typeof EvalSplit>;
export const EvalSurface = z.enum(["chat", "routine", "portal", "mention", "mcp"]); export type EvalSurface = z.infer<typeof EvalSurface>;
export const EvalTaskKind = z.enum(["regression", "capability", "adversarial"]); export type EvalTaskKind = z.infer<typeof EvalTaskKind>;
/** Capability groups of evals.md 5.12; each group has tasks in both splits. */
export const EvalGroup = z.enum([
  "chat_questions", "charts_reports", "chat_proposals", "prebuilt_routines", "routine_drafting", "notices", "payroll_review",
  "onboarding_offboarding", "expenses_timeoff_benefits", "memory_recall", "prompt_injection", "approve_all", "ambiguous", "permissions",
  "stale_data", "secrets", "compliance", "portal", "mentions",
]);
export type EvalGroup = z.infer<typeof EvalGroup>;
export const GraderId = z.enum(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"]); export type GraderId = z.infer<typeof GraderId>;
export const JudgeId = z.enum(["J1_cause", "J2_clarify", "J3_next_step", "J4_no_invention"]); export type JudgeId = z.infer<typeof JudgeId>;

const ExpectedProposal = z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).strict();
const ExpectedMessage = z.object({ surface: z.enum(["chat", "email"]), channel: z.string().nullable().default(null), count: z.number().int().min(0), mustInclude: z.array(z.string()).default([]) }).strict();
export const EvalExpectation = z.object({
  proposals: z.array(ExpectedProposal).nullable().default(null),         // null: not graded; []: none allowed
  messages: z.array(ExpectedMessage).nullable().default(null),
  noConsequentialEffects: z.boolean().default(true),                     // G1, always true in practice
  refusal: z.enum(["none", "refuse", "clarify", "not_permitted"]).default("none"),   // G4
  tainted: z.boolean().nullable().default(null),                          // G7
  memory: z.object({ allowPaths: z.array(z.string()), forbidCommit: z.boolean().default(false) }).nullable().default(null),   // G6
  finalText: z.object({ grounded: z.boolean().default(true), mustMention: z.array(z.string()).default([]), judges: z.array(JudgeId).default([]) }).nullable().default(null),
  endState: z.array(z.object({ sql: z.string(), equals: z.unknown() })).default([]),   // read-only checks on the trial world
}).strict();
export type EvalExpectation = z.infer<typeof EvalExpectation>;

export const EvalWorld = z.object({
  base: z.string(),                         // "seed@v4": seedWorld() on the main seed at the time of writing
  clock: z.string(),                        // frozen ISO time; rate 0 unless stated
  rate: z.number().default(0),
  mutators: z.array(z.string()).default([]),   // named deterministic functions in evals/suite/worlds/
  digest: z.string().nullable(),            // sha256 of the canonical world dump; the runner refuses WORLD_DRIFT
}).strict();
export type EvalWorld = z.infer<typeof EvalWorld>;

export const EvalTask = z.object({
  id: z.string().regex(/^[A-Z]{2}-\d{2}$/), group: EvalGroup, parity: z.array(z.string()).default([]), kind: EvalTaskKind, split: EvalSplit,
  surface: EvalSurface, principal: z.string(), variants: z.array(EvalVariant).min(1),
  world: EvalWorld,
  input: z.union([z.object({ chat: z.string() }).strict(), z.object({ routine: z.string(), event: z.record(z.string(), z.string()).nullable().default(null) }).strict(), z.object({ portal: z.string() }).strict(), z.object({ mention: z.string(), channel: z.string() }).strict()]),
  expect: z.partialRecord(EvalVariant, EvalExpectation),   // one entry per listed variant
  budget: z.object({ maxSteps: z.number().int().min(1).max(20), maxUsd: z.number().min(0).max(0.05) }).strict(),
  reference: z.string(),                    // evals/suite/reference/<id>.md: the expected trajectory and why it is solvable
  legacyCase: z.string().nullable().default(null),   // "L1" to "L10" when ported from evals/live
}).strict();
export type EvalTask = z.infer<typeof EvalTask>;

export const GraderVerdict = z.object({ grader: GraderId, pass: z.boolean(), applies: z.boolean(), reasons: z.array(z.string()), metric: z.number().nullable().default(null) });
export type GraderVerdict = z.infer<typeof GraderVerdict>;
export const JudgeVerdict = z.object({ judge: JudgeId, pass: z.boolean(), reason: z.string(), validated: z.boolean(), costUsd: z.number() });
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** One trial: a task in one variant, trial k. `success` counts only hard checks and validated judges. */
export const EvalTrialResult = z.object({
  taskId: z.string(), split: EvalSplit, group: EvalGroup, variant: EvalVariant, trial: z.number().int().min(1),
  success: z.boolean(), graders: z.array(GraderVerdict), judges: z.array(JudgeVerdict),
  runIds: z.array(z.string()), traceId: z.string().nullable(), phoenixUrl: z.string().nullable(), experimentRunId: z.string().nullable(),
  steps: z.number().int(), toolCalls: z.number().int(), invalidToolCalls: z.number().int(), groundingRepairs: z.number().int(),
  inputTokens: z.number().int(), cachedTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number(), wallMs: z.number().int(),
  firstFailure: z.string().nullable(),      // the loop stage of the first failed check, for the transition matrix
  error: z.string().nullable(),
});
export type EvalTrialResult = z.infer<typeof EvalTrialResult>;

/** evals/results/<date>-<sha>-suite.json (gitignored) plus a Markdown report beside it. */
export const EvalSuiteResult = z.object({
  startedAt: z.string(), endedAt: z.string(), harnessSha: z.string(), promptVersion: z.string().nullable(), model: z.string(), effort: z.string(),
  phoenixProject: z.string().nullable(), experimentIds: z.array(z.string()), splits: z.array(EvalSplit), k: z.number().int().min(1),
  suiteCapUsd: z.number(), spentUsd: z.number(), stoppedEarly: z.string().nullable(),
  trials: z.array(EvalTrialResult),
});
export type EvalSuiteResult = z.infer<typeof EvalSuiteResult>;

/** The shared wave 4 spend ledger (~/Developer/projects/weft-notes/wave4-spend.json): an array of these, appended under a lock. */
export const WaveSpendEntry = z.object({ at: z.string(), stage: z.string(), usd: z.number().min(0), cap: z.number().min(0), note: z.string() });
export type WaveSpendEntry = z.infer<typeof WaveSpendEntry>;
export const WAVE4_USD_CAP = 3.0;
