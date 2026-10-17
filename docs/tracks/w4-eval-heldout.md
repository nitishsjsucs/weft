# w4-eval-heldout: held-out test split, judges J1 to J4, anti-leak scan

Branch `track/w4-eval-heldout`, round 1 of 2. Owner paths: `evals/suite/tasks/test/**`, `evals/suite/reference/test/**`,
`evals/suite/test-manifest.json`, `evals/suite/judges/**`, `tests/evals-antileak.test.ts`, this file. Live spend this
round: $0.00 (no model calls; the judge pilot is left for round 2).

This file publishes only per-group counts from the test split. Fixer tracks must not open the test tasks, their
reference notes, the test mutators or any trace from a test run.

## What landed

| Piece | Where |
|---|---|
| 41 test tasks in the `EvalTask` shape, one reference note each | `evals/suite/tasks/test/*.json`, `evals/suite/reference/test/*.md` |
| 11 deterministic world mutators (SQL steps and one memory file), ids in the 09xx range | `evals/suite/tasks/test/worlds.ts` |
| Manifest: sha256 of every test file, per-group and per-kind counts; `--write` and check modes | `evals/suite/test-manifest.json`, `evals/suite/tasks/test/manifest.ts` |
| Split checks, the anti-leak scan, judge and Phoenix tests (25 tests, no spend) | `tests/evals-antileak.test.ts` |
| Judge prompts J1 cause, J2 clarify, J3 next step, J4 no invention (binary, reason first, version `j-2026-10-16.1`) | `evals/suite/judges/prompts.ts` |
| One judge call through Weft's `ModelProvider` with a spend ledger reserve and settle, wave ledger hooks | `evals/suite/judges/judge.ts` |
| Labels, the stratified 15 / 45 / 40 split, TPR and TNR with Wilson intervals, pilots, the bar, Rogan and Gladen | `evals/suite/judges/validate.ts` |
| Label export from and import into Phoenix span annotations (local only) | `evals/suite/judges/phoenix.ts` |
| CLI: `report`, `export`, `import`, `pilot` (opt-in live, stage cap $0.10) | `evals/suite/judges/cli.ts` |
| Fixture label set (synthetic, not Nitish's) | `evals/suite/judges/fixtures/labels.fixture.json` |
| Label round trip against a running local Phoenix | `evals/suite/judges/smoke.ts` |

## Per-group counts (the only test numbers other tracks see)

| Group | Test tasks |
|---|---|
| chat_questions | 3 |
| charts_reports | 2 |
| chat_proposals | 3 |
| prebuilt_routines | 2 |
| routine_drafting | 1 |
| notices | 2 |
| payroll_review | 2 |
| onboarding_offboarding | 3 |
| expenses_timeoff_benefits | 4 |
| memory_recall | 2 |
| prompt_injection | 3 |
| approve_all | 1 |
| ambiguous | 2 |
| permissions | 2 |
| stale_data | 2 |
| secrets | 1 |
| compliance | 2 |
| portal | 2 |
| mentions | 2 |
| **Total** | **41** (19 adversarial, 15 capability, 7 regression) |

Every group of `EvalGroup` has at least one test task. The compliance, portal and mentions tasks are `kind:
capability` and are expected to fail until their parity tracks land. Ten tasks list both variants; the default
variant never expects a chat proposal, and `chat_can_propose` is only ever turned on by the runner's labeled variant.
Test ids in the wave 4 groups start at 51 so they never collide with dev ids.

## How the split stays honest

- **Manifest.** Any edit to a test task, note or `worlds.ts` changes a hash and fails `pnpm test` until the manifest is
  rewritten on purpose (`node_modules/.bin/tsx evals/suite/tasks/test/manifest.ts --write`), so it shows in review.
- **Anti-leak scan.** Tokens per task: the literals in the note's `leak` block, the mutator names, and every 7-word
  shingle of the input text (word-normalized, so case and punctuation tricks still match). Scanned: `packages/`,
  `apps/`, `scenarios/`, `docs/`, `research/`, `evals/` outside the held-out paths, `e2e/` and `scripts/`. A hit names
  the task id, the token kind and the file, never the token. The test also plants a literal, a mutator name and an
  obfuscated prompt in a temp tree and checks all three are caught, and scans the judge prompts and code.
- While the tasks were written the scan found overlaps with existing code and docs; those tasks were reworded, so the
  scan passes on this branch.
- **Facts checked.** Every mutator applies on `seedWorld()`, the notice extracts equal what the agency parser reads from
  each body (a test), and a scratch probe checked the facts each note relies on with the real read commands.

## Judges

- One question per judge, pass and fail rules, the case marked as data, JSON with `reason` before `verdict`. A reply
  with the verdict first, no reason or no JSON is a parse error, never a verdict about the agent.
- Calls go through Weft's provider (`createProvider`, so the live guard refuses live providers in tests) and reserve
  then settle on Weft's spend ledger; a call whose worst case is over $0.005 is refused. The CLI pilot checks the wave
  ledger before each call and appends what it spent.
- Labels: `human.<judge id>` HUMAN annotations on the run's root span (label pass or fail, critique as explanation);
  judge verdicts go back as `llm.<judge id>` LLM annotations with the prompt version. `smoke.ts` round-tripped three
  labels and two verdicts through Phoenix 20.23.0 on ports 4950 and 4951 with a scratch working dir (stopped after;
  both ports closed).
- Validation: split per judge stratified by Nitish's verdict and keyed by label id; TPR (fails caught) and TNR (passes
  passed) with 95 percent Wilson intervals on test; under 60 labels a judge is a pilot; a judge counts only at test
  TPR >= 0.80 and TNR >= 0.90 on its current prompt version with every test label scored. Verdicts from an older
  prompt version are left out. `runJudge` marks a verdict `validated` only from that status.
- Report on the fixture: `node_modules/.bin/tsx evals/suite/judges/cli.ts report --labels evals/suite/judges/fixtures/labels.fixture.json`.

## Contract requests (for w4-eval-suite and the integrator)

1. **Test mutators.** The loader resolves a test task's mutator names in `TEST_MUTATORS`
   (`evals/suite/tasks/test/worlds.ts`): apply `sqlSteps(names)` after `seedWorld()` and the clock, and write and
   commit `memoryFiles(names)` into the trial memory repository before the run. Unknown names throw `UNKNOWN_MUTATOR`.
2. **World digests.** Test tasks carry `digest: null`; the suite's digest tool fills them in one reviewed commit (which
   also rewrites the manifest).
3. **endState semantics.** `equals` is compared to the first column of the first row when it is a scalar, and to the
   rows when it is an array.
4. **mustMention and mustInclude** are case-insensitive substrings of the final text or message.
5. **Reference path.** Test notes live in `evals/suite/reference/test/<id>.md` (the contract comment says
   `evals/suite/reference/<id>.md`).
6. **Reports.** The suite report shows only per-group pass counts for the test split, never task ids, texts or trace
   links.
7. **Judge tests** live in `tests/evals-antileak.test.ts` because that is the one test file this track owns; a separate
   `tests/evals-judges.test.ts` would be cleaner.

## Left for round 2

- Prove a sample of test tasks solvable end to end on the scripted provider (two chat tasks and the cron routines) and
  in one live trial, inside the $0.10 cap, once the suite runner exists.
- The judge pilot on gpt-5.6-luna (a handful of synthetic cases, under $0.01) and validation on Nitish's labels.
- Event-triggered routine tasks (the notice tasks) depend on the runner delivering `notice.received` with the id.
