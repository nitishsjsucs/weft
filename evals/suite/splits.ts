// The suite's split registry (docs/wave4.md section 14, research/wave4/evals.md section 7). Owner: w4-eval-heldout for
// the held-out rows, w4-eval-suite for dev. Each split lives in evals/suite/tasks/<split>/ and
// evals/suite/reference/<split>/. Exactly one split is the held-out test split that confirmations run on; a rotated-out
// test split becomes a named retired split: frozen, still runnable (`pnpm eval:suite --split retired-r1`), still
// covered by its manifest and the anti-leak scan, and still reported as per-group counts only, so its numbers stay
// comparable with the runs made while it was held out. The dataset row registers each split's Phoenix dataset
// (`weft-eval-<stem>-<hash>`, phoenix.ts datasetFor); tests/evals-antileak.test.ts checks it against the task files.
import type { EvalSplit } from "../../packages/contracts/src/evals";

export type HeldOutSplit = Exclude<EvalSplit, "dev">;

export interface SplitInfo {
  status: "dev" | "held_out" | "retired";
  /** Held-out round: 1 is the split written for wave 4 (2026-10-16), 2 the rotation of 2026-10-18. */
  round: number | null;
  authored: string;
  retired: string | null;
  /** Confirmation runs made on the split while it was held out (docs/wave4.md section 14). */
  confirmations: number | null;
  /** The name stem of its Phoenix dataset. A retired split keeps the stem it had while held out, so a continuity run
   * records into the same dataset as its earlier runs and Phoenix compares them side by side. */
  datasetStem: string;
  /** The registered dataset, `weft-eval-<stem>-<hash>`; null for dev, whose tasks the fixers edit. */
  dataset: string | null;
  /** The held-out manifest path; null for dev. */
  manifest: string | null;
}

export const SPLITS: Readonly<Record<EvalSplit, SplitInfo>> = {
  dev: { status: "dev", round: null, authored: "2026-10-16", retired: null, confirmations: null, datasetStem: "dev", dataset: null, manifest: null },
  test: {
    status: "held_out", round: 2, authored: "2026-10-18", retired: null, confirmations: 0,
    datasetStem: "test", dataset: "weft-eval-test-bd4217b292", manifest: "evals/suite/test-manifest.json",
  },
  "retired-r1": {
    status: "retired", round: 1, authored: "2026-10-16", retired: "2026-10-18", confirmations: 11,
    datasetStem: "test", dataset: "weft-eval-test-dbc843f9b5", manifest: "evals/suite/retired-r1-manifest.json",
  },
};

export const ALL_SPLITS = Object.keys(SPLITS) as EvalSplit[];
/** What `--split all` and `pnpm eval:ci` run: dev and the active held-out split. Retired splits run on request. */
export const ACTIVE_SPLITS: EvalSplit[] = ALL_SPLITS.filter((s) => SPLITS[s].status !== "retired");
export const HELD_OUT_SPLITS = ALL_SPLITS.filter((s): s is HeldOutSplit => s !== "dev");
export const RETIRED_SPLITS = ALL_SPLITS.filter((s): s is HeldOutSplit => SPLITS[s].status === "retired");
/** A split whose trials are reported as per-group counts only (the test split and every retired split). */
export const isHeldOut = (split: string): boolean => split !== "dev";
