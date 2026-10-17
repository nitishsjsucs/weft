// Judge validation (owner: w4-eval-heldout; research/wave4/evals.md section 6.2): Nitish's pass or fail labels per
// judge, a deterministic stratified split about 15 / 45 / 40 into train (few-shot), dev (prompt iteration) and test
// (run once on a frozen prompt), and TPR and TNR with 95 percent Wilson intervals. A failure is the positive class:
// TPR is the share of Nitish's fails the judge also fails, TNR the share of his passes the judge also passes.
// A judge with fewer than 60 labels is a pilot; a judge counts toward task success only at test TPR >= 0.80 and
// TNR >= 0.90 on its current prompt version and outside pilot status.
import { createHash } from "node:crypto";
import { JudgeId } from "../../../packages/contracts/src/evals";
import { JUDGE_PROMPT_VERSION } from "./prompts";

export const PILOT_UNDER_LABELS = 60;
export const BAR = { tpr: 0.8, tnr: 0.9 } as const;
export const SPLIT_SHARES = { train: 0.15, dev: 0.45 } as const;   // test takes the rest (about 0.40)
const Z95 = 1.959963984540054;

export type Verdict = "pass" | "fail";
export type LabelSplit = "train" | "dev" | "test";

export interface JudgeLabel {
  id: string;                       // stable example id (root span id, or task:variant:trial)
  judge: JudgeId;
  human: Verdict;                   // Nitish's label
  critique: string;                 // his one-line critique (few-shot material for train)
  spanId: string | null;
  traceId: string | null;
  taskId: string | null;
  judgeVerdict: Verdict | null;     // the judge's verdict on the same example, once run
  judgeReason: string | null;
  promptVersion: string | null;     // the judge prompt version that produced judgeVerdict
}
export interface LabelFile { version: 1; labels: JudgeLabel[] }

const LABEL_KEYS = new Set(["id", "judge", "human", "critique", "spanId", "traceId", "taskId", "judgeVerdict", "judgeReason", "promptVersion"]);
const isVerdict = (v: unknown): v is Verdict => v === "pass" || v === "fail";
const optStr = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`LABELS_INVALID: ${what} must be a string or null`);
  return v;
};

/** Validates one label strictly (unknown keys refused) and fills the optional fields with null or "". */
export function parseLabel(raw: unknown, at = "label"): JudgeLabel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`LABELS_INVALID: ${at} is not an object`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!LABEL_KEYS.has(k)) throw new Error(`LABELS_INVALID: ${at} has unknown key ${k}`);
  if (typeof o.id !== "string" || !o.id) throw new Error(`LABELS_INVALID: ${at}.id`);
  const judge = JudgeId.safeParse(o.judge);
  if (!judge.success) throw new Error(`LABELS_INVALID: ${at}.judge`);
  if (!isVerdict(o.human)) throw new Error(`LABELS_INVALID: ${at}.human must be pass or fail`);
  if (o.judgeVerdict !== undefined && o.judgeVerdict !== null && !isVerdict(o.judgeVerdict)) throw new Error(`LABELS_INVALID: ${at}.judgeVerdict`);
  return {
    id: o.id, judge: judge.data, human: o.human, critique: optStr(o.critique, `${at}.critique`) ?? "",
    spanId: optStr(o.spanId, `${at}.spanId`), traceId: optStr(o.traceId, `${at}.traceId`), taskId: optStr(o.taskId, `${at}.taskId`),
    judgeVerdict: (o.judgeVerdict as Verdict | null | undefined) ?? null, judgeReason: optStr(o.judgeReason, `${at}.judgeReason`),
    promptVersion: optStr(o.promptVersion, `${at}.promptVersion`),
  };
}

export function parseLabelFile(raw: unknown): LabelFile {
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { labels?: unknown }).labels)) {
    throw new Error("LABELS_INVALID: expected { version: 1, labels: [...] }");
  }
  const labels = (raw as { labels: unknown[] }).labels.map((l, i) => parseLabel(l, `labels[${i}]`));
  const seen = new Set<string>();
  for (const l of labels) {
    const k = `${l.judge}|${l.id}`;
    if (seen.has(k)) throw new Error(`LABELS_INVALID: duplicate label ${k}`);
    seen.add(k);
  }
  return { version: 1, labels };
}

const rank = (judge: string, id: string) => createHash("sha256").update(`${judge}\u0000${id}`).digest("hex");

/** Deterministic split per judge, stratified by Nitish's verdict so each split keeps the class balance. Adding a
 * label can move others only within its own class; ids, not file order, decide. */
export function assignSplits(labels: readonly JudgeLabel[]): Map<string, LabelSplit> {
  const out = new Map<string, LabelSplit>();
  const groups = new Map<string, JudgeLabel[]>();
  for (const l of labels) {
    const k = `${l.judge}|${l.human}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const [, g] of groups) {
    const sorted = [...g].sort((a, b) => (rank(a.judge, a.id) < rank(b.judge, b.id) ? -1 : 1));
    const nTrain = Math.round(sorted.length * SPLIT_SHARES.train);
    const nDev = Math.round(sorted.length * (SPLIT_SHARES.train + SPLIT_SHARES.dev)) - nTrain;
    sorted.forEach((l, i) => out.set(`${l.judge}|${l.id}`, i < nTrain ? "train" : i < nTrain + nDev ? "dev" : "test"));
  }
  return out;
}

export interface Interval { low: number; high: number }

/** 95 percent Wilson score interval for k successes in n trials; null when n is 0. */
export function wilson(k: number, n: number, z = Z95): Interval | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface Confusion { tp: number; fn: number; tn: number; fp: number; unscored: number }
export interface Rates { n: number; confusion: Confusion; tpr: number | null; tnr: number | null; tprInterval: Interval | null; tnrInterval: Interval | null }

/** TPR and TNR over labels that carry a judge verdict; labels without one are counted as unscored. */
export function rates(labels: readonly JudgeLabel[]): Rates {
  const c: Confusion = { tp: 0, fn: 0, tn: 0, fp: 0, unscored: 0 };
  for (const l of labels) {
    if (!l.judgeVerdict) { c.unscored++; continue; }
    if (l.human === "fail") { if (l.judgeVerdict === "fail") c.tp++; else c.fn++; }
    else if (l.judgeVerdict === "pass") c.tn++; else c.fp++;
  }
  const pos = c.tp + c.fn;
  const neg = c.tn + c.fp;
  return {
    n: labels.length, confusion: c,
    tpr: pos ? c.tp / pos : null, tnr: neg ? c.tn / neg : null,
    tprInterval: wilson(c.tp, pos), tnrInterval: wilson(c.tn, neg),
  };
}

/** Rogan and Gladen: the true failure rate behind an observed judge failure rate, clipped to [0, 1]; null when the
 * judge is no better than chance (TPR + TNR <= 1). */
export function correctedFailureRate(observedFailRate: number, tpr: number, tnr: number): number | null {
  const d = tpr + tnr - 1;
  if (d <= 0) return null;
  return Math.min(1, Math.max(0, (observedFailRate + tnr - 1) / d));
}

/** The bar a judge must clear on its test split; every test label needs a verdict. */
export function passesBar(r: Rates): boolean {
  return r.tpr !== null && r.tnr !== null && r.confusion.unscored === 0 && r.tpr >= BAR.tpr && r.tnr >= BAR.tnr;
}

export interface JudgeReport {
  judge: JudgeId;
  labels: number;
  passes: number;
  fails: number;
  splits: Record<LabelSplit, { n: number; passes: number; fails: number }>;
  dev: Rates;
  test: Rates;
  pilot: boolean;
  meetsBar: boolean;
  counts: boolean;
  promptVersion: string;
  /** Labels whose judge verdict came from another prompt version; they are left out of the rates. */
  staleVerdicts: number;
  notes: string[];
}

export function judgeReport(judge: JudgeId, all: readonly JudgeLabel[], promptVersion = JUDGE_PROMPT_VERSION): JudgeReport {
  const mine = all.filter((l) => l.judge === judge);
  const splits = assignSplits(mine);
  const current = (l: JudgeLabel): JudgeLabel => (l.judgeVerdict && l.promptVersion !== promptVersion ? { ...l, judgeVerdict: null } : l);
  const staleVerdicts = mine.filter((l) => l.judgeVerdict && l.promptVersion !== promptVersion).length;
  const of = (s: LabelSplit) => mine.filter((l) => splits.get(`${l.judge}|${l.id}`) === s);
  const count = (ls: JudgeLabel[]) => ({ n: ls.length, passes: ls.filter((l) => l.human === "pass").length, fails: ls.filter((l) => l.human === "fail").length });
  const test = rates(of("test").map(current));
  const dev = rates(of("dev").map(current));
  const pilot = mine.length < PILOT_UNDER_LABELS;
  const meetsBar = passesBar(test);
  const notes: string[] = [];
  if (pilot) notes.push(`pilot: ${mine.length} labels, under ${PILOT_UNDER_LABELS}; verdicts are for triage only`);
  if (test.confusion.unscored) notes.push(`${test.confusion.unscored} test labels have no judge verdict on ${promptVersion}`);
  if (staleVerdicts) notes.push(`${staleVerdicts} verdicts came from an older prompt version and were left out`);
  const fails = mine.filter((l) => l.human === "fail").length;
  if (mine.length && fails < 15) notes.push(`only ${fails} fails labeled; aim for at least 15`);
  if (!meetsBar && test.tpr !== null && test.tnr !== null) notes.push(`below the bar (TPR ${BAR.tpr}, TNR ${BAR.tnr}) on test`);
  return {
    judge, labels: mine.length, passes: mine.length - fails, fails,
    splits: { train: count(of("train")), dev: count(of("dev")), test: count(of("test")) },
    dev, test, pilot, meetsBar, counts: meetsBar && !pilot, promptVersion, staleVerdicts, notes,
  };
}

export function validationReport(labels: readonly JudgeLabel[], promptVersion = JUDGE_PROMPT_VERSION): JudgeReport[] {
  return JudgeId.options.map((j) => judgeReport(j, labels, promptVersion));
}

const pct = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
const ci = (i: Interval | null) => (i ? `${i.low.toFixed(2)} to ${i.high.toFixed(2)}` : "n/a");

export function reportMarkdown(reports: readonly JudgeReport[]): string {
  const lines = [
    `# Judge validation (${reports[0]?.promptVersion ?? JUDGE_PROMPT_VERSION})`, "",
    `A failure is the positive class. Bar: test TPR at least ${BAR.tpr} and TNR at least ${BAR.tnr}; under ${PILOT_UNDER_LABELS} labels a judge is a pilot and never counts.`, "",
    "| Judge | Labels (pass/fail) | Train | Dev | Test | Test TPR (95% CI) | Test TNR (95% CI) | Dev TPR | Dev TNR | Status |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of reports) {
    const status = r.counts ? "counts" : r.pilot ? "pilot" : r.meetsBar ? "meets bar" : "below bar";
    lines.push(`| ${r.judge} | ${r.labels} (${r.passes}/${r.fails}) | ${r.splits.train.n} | ${r.splits.dev.n} | ${r.splits.test.n} | ${pct(r.test.tpr)} (${ci(r.test.tprInterval)}) | ${pct(r.test.tnr)} (${ci(r.test.tnrInterval)}) | ${pct(r.dev.tpr)} | ${pct(r.dev.tnr)} | ${status} |`);
  }
  const notes = reports.flatMap((r) => r.notes.map((n) => `- ${r.judge}: ${n}`));
  if (notes.length) lines.push("", "Notes:", "", ...notes);
  return `${lines.join("\n")}\n`;
}

/** The status file the judge runner reads: a verdict is `validated` only when its judge counts on this prompt version. */
export function judgeStatus(reports: readonly JudgeReport[]): Record<string, { promptVersion: string; counts: boolean; labels: number; tpr: number | null; tnr: number | null }> {
  return Object.fromEntries(reports.map((r) => [r.judge, { promptVersion: r.promptVersion, counts: r.counts, labels: r.labels, tpr: r.test.tpr, tnr: r.test.tnr }]));
}

/** Few-shot examples for a judge come only from its train split; dev and test never reach the prompt. */
export function trainExamples(labels: readonly JudgeLabel[], judge: JudgeId): JudgeLabel[] {
  const mine = labels.filter((l) => l.judge === judge);
  const splits = assignSplits(mine);
  return mine.filter((l) => splits.get(`${l.judge}|${l.id}`) === "train");
}
