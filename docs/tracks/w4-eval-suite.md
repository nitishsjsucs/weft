# Track w4-eval-suite

Branch `track/w4-eval-suite`. Builds docs/wave4.md section 4 and research/wave4/evals.md sections 4 to 9: the task
loader and validator, frozen worlds with named mutators and digests, graders G1 to G10, the runner with the suite cap
and the shared wave ledger, Phoenix experiments with trace links, the results JSON and the Markdown report, and the
dev split. How to run it is in `docs/evals.md`.

## Round 1 (2026-10-16)

Landed:

- `evals/suite/graders/index.ts`: G1 to G10 as pure functions of the trial evidence. G1 reads the registry's risk and
  approval (the old `executedRisky` list of five commands is gone from `evals/live/run.ts` too, and G1 now runs on
  every live case). G9 scans rows, simulator messages, memory and the exported OTLP payload, in raw, base64 and hex.
  `tests/evals-graders.test.ts` has a passing and a failing fixture for each grader.
- `evals/suite/loader.ts`, `worlds/index.ts`, `drivers.ts`, `evidence.ts`, `runner.ts`, `report.ts`, `phoenix.ts`,
  `run.ts`: the runner end to end. `tests/evals-suite.test.ts` validates every task, rebuilds a sample of worlds
  against their pinned digests, runs scripted trials (including the chat_can_propose variant in its own world),
  refuses a drifted world, stops before the suite cap and the wave cap, and checks the report keeps the variants
  apart.
- 50 dev tasks with reference notes and pinned digests, L1 to L10 among them (`legacyCase`).
- A scripted run of the whole dev split recorded into a private Phoenix (port 4920, data in
  `.scratch/w4-eval-suite/phoenix`): two experiments with code evaluators and per-trial trace links.

Shared contracts: none changed. `evals.ts`, `telemetry.ts`, `scripts/wave-ledger.ts` and `scripts/phoenix.ts` are
consumed as they are on main.

Decisions worth a look in review:

- G2 and G4 grade the task's own run tree (the main run and its children). Another routine that the same event
  starts (the new-hire routine on `offer.accepted` in RT-04) is not the task; G1 and G9 still cover every run.
- A routine run that a precheck or template path finishes without an agent run is a valid outcome (NT-01, NT-02,
  ON-01 and RT-06 on the scripted provider), not a harness error.
- runExperiment runs every example of its dataset, so the chat_can_propose experiment uses a dataset of that
  variant's tasks; datasets are named `weft-eval-<split>-<hash of the tasks>`. Phoenix names the trace project
  `Experiment-<id>` itself; the result file records it.
- Each trial appends its own wave ledger entry (stage `w4-eval-suite`), so a crash never loses spend.

Left for round 2 is in `.scratch/w4-eval-suite/left.md` (gitignored) and repeated here:

1. Nine dev tasks that need new worlds: PR-01 (`doubledBonus`), PR-03 (`cleanRun`), ON-02, OF-01
   (`imaniOffboarding`), MM-01 (`memoryDecision`), MM-03 (a procedure note), AI-03 (`candidateInjection`), SD-01
   (a stale dossier), SD-02 (a stale proposal subject).
2. Wave 4 capability tasks for compliance, portal and mentions once those tracks land (portal and mention drivers
   answer `SURFACE_UNAVAILABLE` today).
3. Cassettes for passing runs (harness 12 tier 2) and judges J1 to J4 (w4-eval-heldout builds the judges).
4. The digest test in `pnpm test` rebuilds a sample of four worlds (all of them with `WEFT_EVAL_ALL_DIGESTS=1`, and
   `pnpm eval:suite digests` always rebuilds all); under heavy machine load the full set took minutes.
