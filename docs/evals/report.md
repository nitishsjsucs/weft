# Wave 4 eval report

Live evaluation of the Weft agent on gpt-5.6-luna through the Responses API. The suite is evals/suite: 59 dev tasks and 41 held-out test tasks. Each task runs on a fixed seed world and is graded deterministically on end state first. Every run is a Phoenix experiment, one trace per task. All runs used k = 1. The defaults stayed in place throughout: agent.chat_can_propose and auto autonomy were off.

## Results

| Run | Commit | Dev | Held-out test | Live cost |
|---|---|---|---|---|
| Baseline | 6db1cfc | 46 of 55 (83.6%) | 34 of 41 (82.9%) | $0.060 dev, $0.043 test |
| Baseline, chat_can_propose variant (labeled, not the default) | 6db1cfc | 8 of 10 (80.0%) | | $0.016 |
| Round 1 | a90de1f | 49 of 55 (89.1%); 53 of 55 when re-graded offline with round 2's grounding grader | 32 of 41 (78.0%) | $0.069 dev, $0.045 test |
| Round 2 | 26c2d0f | 59 of 59 (100%) | 35 of 41 (85.4%) | $0.047 dev, $0.035 test |
| After the five-failure fix groups (fix5-dev) | 9011815 | 63 of 65 (96.9%) | | $0.089 dev |
| Same harness on retired-r1 (retired-after-fix5; the split above, now retired) | 8e626f0 | | 40 of 41 (97.6%) | $0.039 |
| Round 2 held-out split, two trials (heldout2-t1, heldout2-t2) | 8e626f0 | | 36 of 41 (87.8%) and 34 of 41 (82.9%) | $0.032 and $0.031 |

Safety held in every run: 0 unsafe actions, 0 successful injections, 0 canary hits. 0 of 7,875 stored spans match a key shape or the configured key value. Total live spend for the wave was $0.41 of a $3.00 cap.

**Read the held-out column, not the dev column.** Dev was tuned on during the fix rounds. Reviewers also found three reasons the round 2 dev score of 100% overstates quality:
- The grounding grader (G5) reused the guard's own evidence, so it could not fail on its own. A strict, independent grounding check is now recorded next to it (0ae6a81).
- 8 of the 59 dev trials never called the model. Five routine trials ran on deterministic templates because WEFT_BACKGROUND_LLM was unset, and three started no agent run.
- Refusal tasks passed on any non-empty reply.

The honest change is held-out 82.9% to 85.4%. Round 1's held-out dip came from a grader bug: G5 called the guard with its old two-argument signature after FG2 changed it. Round 2 fixed it.

## Where the agent failed (baseline taxonomy)

None of the 11 failure modes was a model limit. Most failures happened before the model could act.

| Count | Layer | Failure mode | Fix |
|---|---|---|---|
| 17 | eval bug | Trial world noise: missed weekly digest cron slots fired in every routine trial | Mark past cron slots done; filter digest counts by status; re-pin the worlds |
| 10 | verification guard | The grounding guard refused figures that were present in the run's evidence | Index untainted string leaves; accept request text and clock-derived windows; reserve a last-step repair |
| 8 | eval bug | Weak expectations: tasks could not fail on the behavior they described | Tighten 19 tasks; add a solvability lint |
| 6 | other | First-failure stage misattributed; runs without an agent left no span | Admission label for template trials; split G5 into grounding and content; precheck decision spans |
| 5 | tool design | Chat lacked the domain read the question needed | people.get concise now carries open onboarding items and offboarding steps |
| 3 | product bug | Notices other than rate changes started no agent run | Route every notice kind through planNotice; add notices.escalate |
| 3 | context and memory | Memory not consulted for why or habit questions | Recall from dossiers and term hits; tokenized memory.search |
| 2 | harness prompt | No clarifying question on an underspecified command | Rule: read the options, then end with one direct question |
| 2 | eval bug | A correct clarification failed because it had no question mark | G4 accepts explicit requests for the missing facts |
| 2 | tool design | actions.list run_id collided with pay-run ids | Distinct argument, refusal with a hint, nearest-name suggestions |
| 1 | tool design | Large or date-windowed results could not be filtered or paged | Start and end filters on people.search; consistent totals |

Fix groups by round:
- **Round 1:** notice routine and prechecks; grounding guard and loop repair; read tool shapes and chat tools; chat prompt and memory recall; eval suite.
- **Round 2:** eval suite; memory recall and routine citations; chat prompt, routing and read shapes; grounding and the shared evidence helper.

## The five failures every model shared

The model comparison (docs/evals/model-comparison.md) found five held-out tasks that failed in all 8 trials for every model, so they were harness work. Status on 2026-10-18:

| Group | Failure | Status |
|---|---|---|
| prompt_injection | G3 counted the proposal notifier's approval cards as sends | Fixed (AI-31); passes on retired-r1 |
| expenses_timeoff_benefits | A sum no tool returned | Fixed (EX-11); passes on retired-r1 |
| expenses_timeoff_benefits | A time-off figure only in another unit | Fixed (TO-11); passes on retired-r1 |
| prebuilt_routines | The routine's own precheck figures were not grounding evidence | Fixed (RT-21); passes on retired-r1 |
| notices | A rate notice that states the rate already in effect got a "3.4% to 3.4%" `tax.update_rate` proposal. It was first read as a duplicate proposal; that fix (NT-08, NT-09) is real but did not clear this task, which still fails on retired-r1 | Fixed on dev on rf/notices-and-proposals (NT-10): acknowledge-only plan, `DOMAIN_NO_CHANGE` in `tax.update_rate`; not yet measured on a held-out split |

The retired-r1 run after the fixes passed 40 of 41; its one failure is the notices task. The round 2 held-out split passed 36 and 34 of 41 in two trials, with 0 unsafe actions, 0 taint misses and 0 canary hits in all three runs. Experiments: retired-after-fix5 `RXhwZXJpbWVudDozNQ==`, heldout2-t1 `RXhwZXJpbWVudDozNg==`, heldout2-t2 `RXhwZXJpbWVudDozNw==`, fix5-dev `RXhwZXJpbWVudDozMA==`.

## Still open

- **Held-out round 2 (the 26c2d0f run, on what is now retired-r1):** 6 of 41 fail. The failing graders are G3 twice, G5 twice, G4 once and G8 once. The first failed stage was result use for 4, tool selection for 1 and final text for 1. Two of the 6 ran on templates, so no model was involved.
- **Problems in traces that still passed:**
  - Expense review calls expenses.explain once per expense: 11 of 14 steps on EX-01.
  - Chat has no channel read, so "catch me up on #general" answers that there is no feed.
  - The routine summary dropped pending proposals. This is fixed in 295bb14 but not yet measured live.
- **Measurement gaps:**
  - Every run was k = 1.
  - The text-quality judges J3 and J4 are still pending.
  - The chat_can_propose variant has not been rerun since the baseline.
  - The template routine trials need a labeled WEFT_BACKGROUND_LLM=1 run.
- **Not yet measured live:** d12b74e (tool description examples, which change the cached tool-list prefix) and 295bb14 (routine summary).

## Browse it in Phoenix

Phoenix 20.23.0 runs locally, loopback only, with data in ~/Developer/projects/weft-notes/phoenix (outside the repo).

```bash
cd ~/Developer/projects/weft && pnpm phoenix:status
```

`pnpm phoenix:up` starts it, or reuses an instance that is already running, and refuses a non-loopback bind. `pnpm phoenix:down` stops it.

Open http://127.0.0.1:6206/datasets. Each eval run is an experiment on its split's dataset. Use the dataset's Experiments tab to compare runs task by task and open any trace. A trace shows the run (AGENT), its stages (CHAIN), model calls with tokens, cache hits and cost (LLM), executor calls with their outcome (TOOL), memory recall (RETRIEVER), and the grounding and taint checks (GUARDRAIL).

| Run | Dataset | Experiment | Trace project |
|---|---|---|---|
| baseline (dev) | RGF0YXNldDox | RXhwZXJpbWVudDox | UHJvamVjdDoy |
| baseline-test | RGF0YXNldDoy | RXhwZXJpbWVudDoy | UHJvamVjdDoz |
| chat_can_propose variant | RGF0YXNldDoz | RXhwZXJpbWVudDoz | UHJvamVjdDo0 |
| round1 (dev) | RGF0YXNldDo5 | RXhwZXJpbWVudDo5 | UHJvamVjdDoxMQ== |
| round1-test | RGF0YXNldDoxMA== | RXhwZXJpbWVudDoxMA== | UHJvamVjdDoxMg== |
| round2 (dev) | RGF0YXNldDoxMw== | RXhwZXJpbWVudDoxNA== | UHJvamVjdDoxNg== |
| round2-test | RGF0YXNldDoxMA== | RXhwZXJpbWVudDoxNQ== | UHJvamVjdDoxNw== |

## Next

1. **Harness round 3, dev split only:** batch expenses.explain for the expense routine, and add a channel read on a chat route.
2. **Measurement round:** k = 3 on the prompt-dependent tasks, the judges turned on, and a labeled WEFT_BACKGROUND_LLM=1 variant.
3. **Re-pin the worlds** with a readable canary and the EX-01 proposal-count check, then re-run dev and test so d12b74e and 295bb14 are measured.
4. **Model comparison:** gpt-5.6-luna against gpt-5.6-terra at medium and high effort on the held-out split. In progress; results will be in docs/evals/model-comparison.md.
