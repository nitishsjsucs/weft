# w4-eval-heldout: held-out test split, judges J1 to J4, anti-leak scan

Branch `track/w4-eval-heldout`, rounds 1 and 2. Owner paths: `evals/suite/tasks/test/**`,
`evals/suite/reference/test/**`, `evals/suite/test-manifest.json`, `evals/suite/judges/**`,
`tests/evals-antileak.test.ts`, this file. Live spend: $0.00 in round 1, $0.0107 in round 2 against the $0.10 stage
cap (the judge pilot and 12 live trials), every call recorded in the wave ledger under stage `w4-eval-heldout`.

This file publishes only per-group counts from the test split. Fixer tracks must not open the test tasks, their
reference notes, the oracles, the test mutators or any trace from a test run.

## What landed

| Piece | Where |
|---|---|
| 41 test tasks in the `EvalTask` shape, one reference note each | `evals/suite/tasks/test/*.json`, `evals/suite/reference/test/*.md` |
| 11 deterministic world mutators (SQL steps and one memory file), ids in the 09xx range | `evals/suite/tasks/test/worlds.ts` |
| Scripted oracles: the reference trajectory of each task as a scripted-provider script, plus the status lists | `evals/suite/tasks/test/oracles.ts` |
| Manifest: sha256 of every test file, per-group and per-kind counts; `--write` and check modes | `evals/suite/test-manifest.json`, `evals/suite/tasks/test/manifest.ts` |
| Split checks, solvability status, the anti-leak scan, judge and Phoenix tests (no spend) | `tests/evals-antileak.test.ts` |
| Judge prompts J1 cause, J2 clarify, J3 next step, J4 no invention (binary, reason first, version `j-2026-10-16.1`) | `evals/suite/judges/prompts.ts` |
| One judge call through Weft's `ModelProvider` with a spend ledger reserve and settle, wave ledger hooks | `evals/suite/judges/judge.ts` |
| Labels, the stratified 15 / 45 / 40 split, TPR and TNR with Wilson intervals, pilots, the bar, Rogan and Gladen | `evals/suite/judges/validate.ts` |
| Label export from and import into Phoenix span annotations (local only) | `evals/suite/judges/phoenix.ts` |
| CLI: `report`, `export`, `import`, `pilot` (opt-in live, stage cap $0.10) | `evals/suite/judges/cli.ts` |
| Fixture label set and synthetic pilot cases (not Nitish's labels, not test tasks) | `evals/suite/judges/fixtures/` |
| The recorded judge pilot on gpt-5.6-luna | `evals/suite/judges/pilots/` |
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
| **Total** | **41** (19 adversarial, 22 capability) |

Every group of `EvalGroup` has at least one test task. Ten tasks list both variants; the default variant never expects a
chat proposal, and `chat_can_propose` is only ever turned on by the runner's labeled variant. Test ids in the wave 4
groups start at 51 so they never collide with dev ids. Held-out tasks are never `kind: regression` (the suite loader
keeps that kind for tuned tasks), so the seven round 1 regression tasks are capability tasks now.

## Round 2: the split runs in the suite runner

- **Loads.** All 41 tasks pass the suite's own loader (`evals/suite/loader.ts` on `track/w4-eval-suite`) once it
  resolves the test mutators (contract request 1). The test file restates the loader's rules, so a task that would not
  load fails `pnpm test` here first.
- **Worlds.** Every distinct test world builds in the suite's world builder and gives the same digest twice.
- **Solvable.** A scratch probe ran every task variant through the suite's `runPlain` in scripted mode ($0): with its
  oracle, with the product's own scripted path where that is the reference, and with a null reply ("Done."). No trial
  ended in a harness error. Per group:

  | Group | Tasks | Solvable now (oracle or product path) | Blocked on the harness | Waits on a parity track | A null reply also passes |
  |---|---|---|---|---|---|
  | chat_questions | 3 | 3 | 0 | 0 | 2 |
  | charts_reports | 2 | 2 | 0 | 0 | 1 |
  | chat_proposals | 3 | 3 | 0 | 0 | 3 |
  | prebuilt_routines | 2 | 1 | 1 | 0 | 0 |
  | routine_drafting | 1 | 1 | 0 | 0 | 0 |
  | notices | 2 | 2 | 0 | 0 | 1 |
  | payroll_review | 2 | 2 | 0 | 0 | 0 |
  | onboarding_offboarding | 3 | 3 | 0 | 0 | 2 |
  | expenses_timeoff_benefits | 4 | 2 | 2 | 0 | 2 |
  | memory_recall | 2 | 2 | 0 | 0 | 1 |
  | prompt_injection | 3 | 3 | 0 | 0 | 0 |
  | approve_all | 1 | 1 | 0 | 0 | 1 |
  | ambiguous | 2 | 2 | 0 | 0 | 0 |
  | permissions | 2 | 2 | 0 | 0 | 2 |
  | stale_data | 2 | 2 | 0 | 0 | 0 |
  | secrets | 1 | 1 | 0 | 0 | 1 |
  | compliance | 2 | 0 | 0 | 2 | 0 |
  | portal | 2 | 0 | 0 | 2 | 0 |
  | mentions | 2 | 0 | 0 | 2 | 0 |
  | **Total** | **41** | **32** | **3** | **6** | **16** |

  "Blocked" means no reply can pass on the current harness; each reference note says why, and the oracle stays so the
  task passes once the harness changes. One more variant (a chat_can_propose run of a solvable task) is blocked the same
  way. "Waits" means the surface or command lands with a wave 4 parity track (portal
  and mention tasks answer `SURFACE_UNAVAILABLE` on main). The probe found four harness or product defects behind the
  blocked tasks; they went to the integrator in the round 2 status report, not here.
- **Expectations fixed.** The probe also showed six expectations that no right answer could meet in the runner (world
  setup the runner adds, system writes, harness-written summaries); those were corrected and their notes record what
  the probe showed. The manifest changed with them in reviewed commits.
- **What a null reply shows.** On 16 tasks a reply of "Done." also passes the deterministic graders. One is a task
  where doing nothing is the right answer; on the other 15 the graders check safety (no proposals, nothing executed,
  grounded text, a non-empty refusal) and whether the reply helps rests on the judge each of them lists (four refusal
  tasks gained J3 next step in round 2 for this reason). Until those judges validate, the suite report should show
  these tasks apart (contract request 5).
- **Live.** 12 trials on gpt-5.6-luna through the suite runner in live mode (one per task, default variant), 10 passed:

| Group | Live trials | Passed |
|---|---|---|
| chat_questions | 2 | 2 |
| charts_reports | 1 | 1 |
| chat_proposals | 1 | 1 |
| notices | 1 | 0 |
| expenses_timeoff_benefits | 1 | 0 |
| prompt_injection | 1 | 1 |
| approve_all | 1 | 1 |
| ambiguous | 1 | 1 |
| permissions | 1 | 1 |
| stale_data | 1 | 1 |
| secrets | 1 | 1 |

  Both failures are on tasks the scripted probe had already marked as failing on the current harness.
- **Judge pilot.** Eight synthetic cases (one pass and one fail per judge, nothing from the test split) on prompt
  `j-2026-10-16.1`: every verdict parsed, all eight matched the expected label, $0.0011. A pilot is not validation; the
  judges still need Nitish's labels.
- **Anti-leak on other checkouts.** `WEFT_ANTILEAK_ROOTS=<root>,<root>` scans other checkouts the same way. It passes on
  main and on the six other wave 4 worktrees (their working trees included), and a planted mutator name in an extra root
  fails it.

## How the split stays honest

- **Manifest.** Any edit to a test task, note, `worlds.ts` or `oracles.ts` changes a hash and fails `pnpm test` until the
  manifest is rewritten on purpose (`node_modules/.bin/tsx evals/suite/tasks/test/manifest.ts --write`), so it shows in
  review.
- **Anti-leak scan.** Tokens per task: the literals in the note's `leak` block, the mutator names, and every 7-word
  shingle of the input text (word-normalized, so case and punctuation tricks still match). Scanned: `packages/`,
  `apps/`, `scenarios/`, `docs/`, `research/`, `evals/` outside the held-out paths, `e2e/` and `scripts/`, in this
  checkout and in every root of `WEFT_ANTILEAK_ROOTS`. A hit names the task id, the token kind and the file, never the
  token. Planted literals, mutator names and an obfuscated prompt in a temp tree are caught; the judge code, prompts,
  fixtures and pilots are scanned too.
- **Solvability status** is checked in `pnpm test`: every task variant has an oracle, is passed by the product path, or
  waits on a parity track, and every blocked variant keeps an oracle.

## Judges

- One question per judge, pass and fail rules, the case marked as data, JSON with `reason` before `verdict`. A reply
  with the verdict first, no reason or no JSON is a parse error, never a verdict about the agent.
- Calls go through Weft's provider (`createProvider`, so the live guard refuses live providers in tests) and reserve
  then settle on Weft's spend ledger; a call whose worst case is over $0.005 is refused. The CLI pilot checks the wave
  ledger before each call and appends what it spent.
- Labels: `human.<judge id>` HUMAN annotations on the run's root span (label pass or fail, critique as explanation);
  judge verdicts go back as `llm.<judge id>` LLM annotations with the prompt version. `smoke.ts` round-tripped labels and
  verdicts through Phoenix 20.23.0 on ports 4950 and 4951 with a scratch working dir (stopped after).
- Validation: split per judge stratified by Nitish's verdict and keyed by label id; TPR (fails caught) and TNR (passes
  passed) with 95 percent Wilson intervals on test; under 60 labels a judge is a pilot; a judge counts only at test
  TPR >= 0.80 and TNR >= 0.90 on its current prompt version with every test label scored. `runJudge` marks a verdict
  `validated` only from that status.
- Report on the fixture: `node_modules/.bin/tsx evals/suite/judges/cli.ts report --labels evals/suite/judges/fixtures/labels.fixture.json`.
- Pilot: `WEFT_LIVE_OPENAI=1 WEFT_LLM=openai WEFT_SECRETS_FILE=... node_modules/.bin/tsx evals/suite/judges/cli.ts pilot --cases evals/suite/judges/fixtures/pilot-cases.json --out <file>`.

## Contract requests (for w4-eval-suite and the integrator)

1. **Test mutators.** `knownMutator` and `buildWorld` also resolve names in `TEST_MUTATORS`
   (`evals/suite/tasks/test/worlds.ts`): run each SQL step on the trial database after the prebuilt routine rows, and
   write the memory files into the trial memory repository and commit them at the world clock (so the digest is
   reproducible). The probe used exactly this (about 20 lines in `worlds/index.ts`); the diff is in
   `.scratch/contract-requests/w4-eval-heldout-test-mutators.diff`.
2. **World digests.** Test tasks carry `digest: null`; `pnpm eval:suite digests --write` fills them in one reviewed commit
   that also rewrites the manifest.
3. **Reports.** The suite report shows only per-group pass counts for the test split, never task ids, texts or trace
   links.
4. **G5 on receipt summaries.** A routine run that files proposals ends with the harness's own receipt summary. G5
   grounds it against tool results, but its figures come from proposal previews, so a correct run fails G5. Either
   skip G5 on harness-written summaries or ground them against the previews.
5. **Judges in the trial.** Once a judge counts, the runner calls `runJudge` for the judges a task lists and fills
   `trial.judges`; until then the report keeps judge-dependent tasks apart.
6. **Solvability in CI after the merge.** With both branches merged, a scripted run of `oracles.ts` through `runPlain`
   (every oracle passes, every null reply on a substantive task fails, blocked variants fail) can join `pnpm test`.
7. **Judge tests** live in `tests/evals-antileak.test.ts` because that is the one test file this track owns; a separate
   `tests/evals-judges.test.ts` would be cleaner.

The round 1 requests for `endState` semantics, `mustMention` matching and the reference path are already how the suite
behaves (the probe exercised all three), so they are dropped.

## Left

- Validate the judges on Nitish's labels (40 to 60 per judge, exported from Phoenix annotations with the CLI).
- Pin the test world digests with the suite (contract request 2).
- Re-run the oracles when a blocked task's harness change lands, and when the portal, mention and compliance surfaces
  reach main.

## Round 2 (2026-10-18): rotation

The round 1 split moved to `evals/suite/tasks/retired-r1/` (status retired, frozen, runnable with `--split retired-r1`,
same Phoenix dataset `weft-eval-test-dbc843f9b5`). Round 2 is the new `evals/suite/tasks/test/`: 41 tasks, the same
counts per group as round 1, 17 new mutators in the 08xx id range, 33 oracles and 8 product-path routine tasks, dataset
`weft-eval-test-bd4217b292`. The author read only round 1's per-group counts. Scripted solvability
(`tsx evals/suite/solvability.ts --split test`): 49 of 49 variants solved, a null reply passes none (round 1: 47 of 50,
a null reply passes 25). Two product behaviors shaped tasks: chat has no routine drafting tool (drafting is the Routines
screen's route), and the act-mode intent check needs one of its verbs, so the off-cycle request says "Pay". Observed
while probing, not checked further: the tools route answers `people.get` for a manager's non-report with the pay
included; the round 2 manager-scope tasks grade the reply, not the read. Details are in `docs/wave4.md` section 14.
