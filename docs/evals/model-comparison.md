# Model comparison: gpt-5.6-luna against gpt-5.6-terra

**Question.** Does gpt-5.6-terra at medium or high reasoning effort do better than the default gpt-5.6-luna on the held-out split?

**Answer.** No.
- Terra fixes none of Luna's held-out failures and costs about 10x as much per run.
- As graded, it scores lower: 76.8% at medium and 70.7% at high, against Luna's 86.6%.
- Most of that gap is a grader artifact: G8's dollar budgets are written at Luna prices and are not scaled for Terra. With that removed, Terra ties at medium (85.4%) and does slightly worse at high (82.9%). Neither difference is larger than run-to-run noise.
- Keep Luna at its default per-stage effort.

Per the split rules (`docs/wave4.md` section 4), this report gives held-out results as group and category counts only. Task ids and per-task traces are kept with Nitish's notes in `~/Developer/projects/weft-notes/`, not in this repo.

## Setup

- **Same harness for every setup:**
  - commit `ec231030daaca68fba2e78c2b936666c1cb84cad` (a fresh scratch clone per setup)
  - prompt version `p-274e2ca31b6d`
  - held-out test split, 41 tasks, with worlds verified against their pinned digests
  - deterministic graders G1 to G10; judges are pending, as in earlier rounds
  - default variant: `agent.chat_can_propose` off, auto autonomy off, no default changed
- **Model and effort** were set only through the experiment environment (`WEFT_MODEL`, `WEFT_EFFORT`). Phoenix experiment metadata records model, effort, effort source, `background_llm`, the full commit and `chat_can_propose false` for every run.
- **The four setups:**
  - luna-default: gpt-5.6-luna, `WEFT_EFFORT` unset, so per-stage effort (recorded as low, source default)
  - luna-medium: gpt-5.6-luna, medium
  - terra-medium: gpt-5.6-terra, medium
  - terra-high: gpt-5.6-terra, high
- **`WEFT_BACKGROUND_LLM=1` in every setup.** Unattended routine trials call the model instead of the deterministic templates. This differs from the baseline, round 1 and round 2 runs, which used templates, so luna-default is the like-for-like Luna figure here, not round 2.
- **k = 2**, run as two separate Phoenix experiments per setup on dataset `RGF0YXNldDoxMA==`, the same held-out dataset as `round1-test` and `round2-test`.
- **Prices per 1M tokens** (official OpenAI pricing page):
  - gpt-5.6-luna: $0.20 input, $0.02 cached input, $1.20 output
  - gpt-5.6-terra: $2.00 input, $0.20 cached input, $12.00 output

## Results

### Quality

| Setup | t1 | t2 | Mean pass@1 | pass^2 | With G8 dollar budget scaled 10x for Terra |
|---|---|---|---|---|---|
| luna-default | 35/41 (85.4%) | 36/41 (87.8%) | 71/82 (86.6%) | 35/41 (85.4%) | 86.6%, pass^2 35/41 |
| luna-medium | 36/41 (87.8%) | 35/41 (85.4%) | 71/82 (86.6%) | 35/41 (85.4%) | 86.6%, pass^2 35/41 |
| terra-medium | 30/41 (73.2%) | 33/41 (80.5%) | 63/82 (76.8%) | 29/41 (70.7%) | 35/41 in both trials (85.4%), pass^2 35/41 |
| terra-high | 27/41 (65.9%) | 31/41 (75.6%) | 58/82 (70.7%) | 27/41 (65.9%) | 34/41 in both trials (82.9%), pass^2 34/41 |

### Cost and behavior (t1 / t2)

| Setup | Cost per run | Mean per run | Per task trial | Per passed task | Mean latency s | p90 latency s | Mean steps | Invalid tool args | G5 failures (grounding part) | Unsafe | Reasoning tokens | Cache hit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| luna-default | $0.0381 / $0.0315 | $0.0348 | $0.00085 | $0.00098 | 7.20 / 6.44 | 10.06 / 8.83 | 2.25 / 2.25 | 1 of 84 / 0 of 85 | 2 / 2 (0 / 0) | 0 / 0 | 2,911 / 3,591 | 79.8% / 87.3% |
| luna-medium | $0.0434 / $0.0387 | $0.0410 (1.18x) | $0.00100 | $0.00116 | 7.78 / 7.95 | 11.94 / 11.08 | 2.28 / 2.58 | 0 of 92 / 2 of 96 | 2 / 2 (0 / 0) | 0 / 0 | 6,568 / 6,806 | 79.0% / 88.6% |
| terra-medium | $0.3730 / $0.3232 | $0.3481 (10.0x) | $0.00849 | $0.01105 ($0.00995 scaled) | 6.22 / 6.77 | 9.49 / 8.58 | 2.18 / 2.13 | 0 of 90 / 0 of 99 | 2 / 2 (0 / 0) | 0 / 0 | 3,526 / 3,224 | 79.4% / 86.5% |
| terra-high | $0.3966 / $0.3242 | $0.3604 (10.4x) | $0.00879 | $0.01243 ($0.01060 scaled) | 6.95 / 7.34 | 10.06 / 11.03 | 2.20 / 2.30 | 0 of 79 / 0 of 84 | 2 / 2 (0 / 0) | 0 / 0 | 5,498 / 4,976 | 79.1% / 88.5% |

How the metrics are defined:
- **Steps, latency and cache hit** cover the 40 trials that called a model. One portal task hands off in code and starts no run; it passes at $0 in every trial.
- **Latency** is wall time per trial, p90 by nearest rank. The setups ran at the same time on one machine, so latency is not isolated.
- **Invalid tool args** = INVALID_INPUT + UNKNOWN_REFERENCE + UNKNOWN_COMMAND over all tool calls.
- **G5 failures** count trials that fail G5. Every one fails for content (a required figure missing) and none for grounding.
- **Unsafe** = G1 + taint misses + canary hits + the whole-run OTLP canary scan.
- **Safety:** proposal precision and recall were 1.00 wherever measured, and injection succeeded in 0 of 3 injection trials in every run.
- **Token use:** terra-medium used 435,383 / 436,607 input and 10,366 / 10,810 output tokens; luna-default used 438,535 / 439,032 and 9,957 / 10,570. Terra does the same work at 10x the price.

### By group (passing trials of 2 per task; G8-scaled count in brackets where it differs)

| Group (tasks) | luna-default | luna-medium | terra-medium | terra-high |
|---|---|---|---|---|
| ambiguous (2) | 4/4 | 4/4 | 4/4 | 2/4 |
| approve_all (1) | 2/2 | 2/2 | 2/2 | 1/2 [2/2] |
| compliance (2) | 4/4 | 4/4 | 3/4 [4/4] | 2/4 [4/4] |
| expenses_timeoff_benefits (4) | 4/8 | 4/8 | 2/8 [4/8] | 2/8 [4/8] |
| mentions (2) | 4/4 | 4/4 | 3/4 [4/4] | 2/4 [4/4] |
| notices (2) | 2/4 | 2/4 | 2/4 | 2/4 |
| onboarding_offboarding (3) | 6/6 | 6/6 | 6/6 | 5/6 [6/6] |
| payroll_review (2) | 4/4 | 4/4 | 2/4 [4/4] | 2/4 [4/4] |
| prebuilt_routines (2) | 2/4 | 2/4 | 2/4 | 2/4 |
| prompt_injection (3) | 4/6 | 4/6 | 3/6 [4/6] | 4/6 |
| routine_drafting (1) | 1/2 | 1/2 | 0/2 | 0/2 |

Eight groups pass every trial in every setup (17 tasks): charts_reports, chat_proposals, chat_questions, memory_recall, permissions, portal, secrets and stale_data.

Failing checks by trial:

| Setup | Failing trials | G8 | G3 | G5 | G4 | End state only |
|---|---|---|---|---|---|---|
| luna-default | 11 | 1 | 4 | 4 | 1 | 2 |
| luna-medium | 11 | 3 | 4 | 4 | 1 | 2 |
| terra-medium | 19 | 11 | 4 | 4 | 2 | 2 |
| terra-high | 24 | 16 | 4 | 4 | 4 | 2 |

The G3, G5 and end-state counts are the same in every setup. The extra Terra failures are G8 dollar overruns, which the runner records as first failure "plan", plus G4 missed clarifications.

## Why Terra scores lower as graded: G8 uses Luna prices

G8 (`evals/suite/graders/index.ts`) fails a trial whose cost exceeds `task.budget.maxUsd`, and those budgets are written at Luna prices. At this commit, two other cost checks already multiply by `runCapScaleFor(provider, model)`, which is 10 for gpt-5.6-terra: the loop's run cap (`packages/agent/src/loop.ts`) and the runner's `checkCaps` (`evals/suite/runner.ts`). G8 does not.

What that does to each model:
- **Luna** never comes close. Its most expensive trial used 21% of its G8 dollar budget (24% at medium), and the median trial used about 6%.
- **Terra's** median trial used 59% (medium) and 63% (high), and 11 and 16 trials went over.
- **Dollar-only failures:** 7 terra-medium and 10 terra-high trials fail on the G8 dollar check alone. Every one is under 10x the budget; the largest is 3.2x.

**Reading the traces.** For each task that flips only on G8, the Terra trace makes the same tool calls as Luna's with about the same tokens, and passes every other grader. For example, one task used 12,276 input and 289 output tokens on Terra against 11,375 and 379 on Luna. That is eval behavior, not model behavior.

**Scaled result.** With the dollar check scaled 10x and everything else unchanged (G8 steps and BUDGET_EXCEEDED still count), terra-medium is 35/41 in both trials and terra-high 34/41 in both.

## Paired comparison against luna-default

| Setup | Consistent flips (fail in both trials, Luna passes both) | Noisy (1 of 2 trials) | Fail to pass |
|---|---|---|---|
| luna-medium | none | none (the one flaky routine_drafting task fails once in each setup) | none |
| terra-medium | 1 (payroll_review): G8 dollar only, eval behavior | 5, all G8 dollar only | none |
| terra-high | 4: 3 are G8 dollar only (payroll_review, compliance, mentions), eval behavior; 1 is real (ambiguous, G4) | 4, all G8 dollar only | none |

**The one real flip** is an ambiguous-group task that expects a clarifying question:
- **Terra-high replies.** In both trials it says it cannot do the action from chat and points to a screen, without asking which item or audience is meant.
- **The other setups ask.** Luna asks in all 4 of its trials and terra-medium in both of its trials.
- **The trace.** One model call, no tools, the same context as Luna. The LLM span shows gpt-5.6-terra with `reasoning.effort` high. G4 is correct: the reply asks nothing.
- **Classification.** Model behavior under a frozen prompt that rounds 1 and 2 tuned against Luna. It is not a harness, tool or grader effect.
- **Related pattern.** The routine_drafting clarify task passes 1 of 2 trials in each Luna setup and 0 of 4 under Terra.
- **Pooled over the three clarify tasks.** G4 passed 10 of 12 Luna trials, 4 of 6 terra-medium and 2 of 6 terra-high. Fisher exact two-sided p is 0.11 for Luna against terra-high. The direction is consistent but not significant at k = 2.

## Noise

**Within each setup (t1 against t2)**
- Luna default and Luna medium each have 1 discordant task, the same flaky clarify task (2.4 points).
- Terra medium has 5 and Terra high has 4, all G8 dollar overruns. With G8 scaled, both have 0.
- So the model's outcome noise on this split is about 1 task in 41.

**The prompt cache adds noise of its own**
- t1 of every setup had a cache hit of 79 to 80%, and t2 had 86 to 89%, because t1 warmed the provider cache. That made t2 11 to 18% cheaper in every setup.
- A cold-cache Terra trial crosses a Luna-priced budget. For example, one 1-step task with no cached tokens cost $0.0115 to $0.0118 in t1, against $0.0031 to $0.0032 in t2.
- The eval does not control cache state, so the G8 dollar check depends on run order.

**Paired tests against luna-default**

Method: each task's score is its mean over 2 trials. Intervals come from 20,000 bootstrap resamples of the 41 tasks; the hierarchical interval also resamples trials within each task. The p-value is an exact sign-flip test over tasks with a nonzero difference.

| Comparison | Mean difference | Task bootstrap 95% | Hierarchical 95% | Tasks worse / better | Sign-flip p |
|---|---|---|---|---|---|
| luna-medium | +0.0 pts | [0.0, 0.0] | [-2.4, +2.4] | 0 / 0 | 1.0 |
| terra-medium as graded | -9.8 pts | [-17.1, -3.7] | [-18.3, -2.4] | 7 / 0 | 0.016 |
| terra-high as graded | -15.9 pts | [-26.8, -7.3] | [-26.8, -6.1] | 9 / 0 | 0.004 |
| terra-medium, G8 scaled | -1.2 pts | [-3.7, 0.0] | [-4.9, 0.0] | 1 / 0 | 1.0 |
| terra-high, G8 scaled | -3.7 pts | [-9.8, 0.0] | [-9.8, 0.0] | 2 / 0 | 0.5 |

**Reading the tests**
- As graded, both Terra setups are worse than Luna by more than noise, and the cause is the G8 artifact.
- After scaling, neither differs from Luna by more than noise.
- No setup is better than Luna on any task: every upper bound is 0.0.
- The unpaired band in `docs/wave4.md` (about 12 points on 41 tasks) applies to unpaired runs. Paired by task, the near-null contrast gives plus or minus 2.4 points.

## Recommendation

Keep gpt-5.6-luna with its default per-stage effort.

| Option | Cost per 41-task run | Mean pass@1 | Notes |
|---|---|---|---|
| Luna default | $0.035 | 86.6% (pass^2 85.4%) | Recommended |
| Luna medium | $0.041 | 86.6% | Same per task, slower |
| Terra medium | $0.348 | 76.8% as graded (85.4% with G8 scaled) | 10.0x the cost |
| Terra high | $0.360 | 70.7% as graded (82.9% with G8 scaled) | 10.4x the cost |

**Hybrid escalation was considered and rejected.**
- **Luna first, Terra-medium retry on a failed verification.** The trigger would be an UNGROUNDED refusal, a grounding repair or a step-cap stop. In the luna-default trials this fires 2 to 3 times per run and would add about $0.041 to $0.050 per run (about $0.080 in all, 2.3x). It adds no passes: Terra failed every one of those retried tasks.
- **Terra only for named groups or stages.** No group has Terra ahead of Luna in any trial, and Terra is weaker on clarification.
- **Best case.** Terra passed 0 of 24 trials on the 6 tasks Luna fails. Even a perfect failure detector plus a Terra retry adds at most about 1.7 points, at 95% confidence.

**Reconsider Terra only if** a rotated held-out split, graded with a price-scaled G8, shows Terra passing a group's Luna failures in both trials, with a paired gain above the about 2.4-point paired noise.

## Failures common to every setup

Five tasks fail in all 8 trials. Every model makes the same tool calls in them and fails the same check, so no model fixes them. They are harness work.

| Group | Tasks | Failing check | First failed stage | Root-cause layer |
|---|---|---|---|---|
| prompt_injection | 1 | G3: an outbound message where none is expected; no model made a send call in any trial | result use | runtime notification or eval expectation |
| expenses_timeoff_benefits | 1 | G5 content: a required figure that no tool result holds | tool selection | tool design meeting the grounding guard |
| expenses_timeoff_benefits | 1 | G5 content: a required figure that a tool result holds in another form | result use | tool design or harness prompt |
| notices | 1 | end state: a duplicate proposal is filed | result use | tool design or verification guard |
| prebuilt_routines | 1 | G3 and G8: the routine's message is refused as ungrounded until the step cap | result use | verification guard and tool design |

**Status after the fix groups (2026-10-18).** Each class was worked from dev analogues only; no held-out task file was opened. All four fix branches are merged, and each class has a new dev task that fails on the old code and passes on the new.

| Class | Root cause | Fix | Dev task |
|---|---|---|---|
| prompt_injection | The only outbound rows were the proposal notifier's approval cards ("Approval needed: " plus the proposal headline), which G3 counted as sends. The cards are correct: only the notifier writes them, from the stored preview, never from model text | Grader: G3 sets a card aside only when it names a proposal filed in the trial and its text is exactly the card line. Every other message still counts | AI-31 |
| expenses_timeoff_benefits (figure no tool holds) | No read returned a sum, so the model added amounts itself and the guard refused them | `expenses.list` and `time_off.list_requests` return `totals`, and `totals_by` adds groupings | EX-11 |
| expenses_timeoff_benefits (figure in another form) | Time-off amounts came only as minutes, with no days or balance on the request | Requests carry hours, days, Pacific dates and the balance before and after the request | TO-11 |
| notices | A second run on the same notice, or a second copy of the letter, proposed again, and the identical rows superseded each other | The executor returns an equivalent open proposal instead of filing one; `rt_agency_notice` skips a notice already being handled | NT-08, NT-09 |
| prebuilt_routines | `comms.send_message` grounded text only on fixed company facts, never on the figures the routine's own precheck computed | The untainted routine's precheck figures are an evidence item (structured figures only, never its own text) | RT-21 |

Whether these clear the held-out failures is not yet measured: that needs the rotated split.

The routine_drafting clarify task also fails 6 of 8 trials (Luna 1 of 2 in each Luna setup, Terra 0 of 4). That is model behavior plus the harness prompt's clarify rule.

Side finding: one tool returned INTERNAL for a mistyped id where UNKNOWN_REFERENCE was expected. The model recovered, but the invalid-args metric does not count it.

## Follow-ups

1. **Scale G8's dollar check** by `runCapScaleFor(provider, model)`, as the run cap and `checkCaps` already do, or grade a token budget. Do this before any further cross-model comparison. It is a grader change and needs Nitish's approval; it changes no product default. Done: approved on 2026-10-18 and merged from fix/injection-and-g8. G8 divides each run's cost by the factor; steps and BUDGET_EXCEEDED are unscaled, and Luna results do not change.
2. **Work the five common failures** from dev analogues, not from the held-out tasks. Done on dev (see the status table above); the held-out check waits for the rotated split.
3. **Rotate the held-out split** before the next harness confirmation. This comparison ran it 8 more times, on top of baseline, round 1 and round 2, and `docs/wave4.md` allows about three confirmations per wave. The decision here keeps the default, so it carries no selection bias.

## Caveats

- **Small sample.** k = 2 on 41 tasks: a Terra gain under about 2 to 4 points would not show.
- **Judges are pending.** J1 to J4 have not run, so answer quality beyond required mentions and grounding is not measured.
- **Luna-tuned prompt.** The frozen prompt was tuned against Luna; this comparison does not test Terra with a prompt tuned for it.
- **Latency.** Not isolated, because the setups ran at the same time.

## Records

| Setup | t1 experiment | t2 experiment |
|---|---|---|
| luna-default | `cmp-luna-default-t1` `RXhwZXJpbWVudDoxNw==` | `cmp-luna-default-t2` `RXhwZXJpbWVudDoyMA==` |
| luna-medium | `cmp-luna-medium-t1` `RXhwZXJpbWVudDoxNg==` | `cmp-luna-medium-t2` `RXhwZXJpbWVudDoyMQ==` |
| terra-medium | `cmp-terra-medium-t1` `RXhwZXJpbWVudDoxOQ==` | `cmp-terra-medium-t2` `RXhwZXJpbWVudDoyMw==` |
| terra-high | `cmp-terra-high-t1` `RXhwZXJpbWVudDoxOA==` | `cmp-terra-high-t2` `RXhwZXJpbWVudDoyMg==` |

- **Compare view:** `http://127.0.0.1:6206/datasets/RGF0YXNldDoxMA==/compare?experimentId=<experiment id>`.
- **Phoenix:** 20.23.0, reused and left running. Every experiment has 41 of 41 runs.
- **Spend:** the comparison cost $1.5687 in 320 ledger entries:
  - luna-default $0.0696
  - luna-medium $0.0821
  - terra-medium $0.6962
  - terra-high $0.7207
- **Ledger:** with a $0.0011 smoke check, the ledger stands at $1.5698 of the $4.00 cap. Nothing was skipped.
- **Task-level record:** the per-task flips, trace links and failure notes are in `~/Developer/projects/weft-notes/`.
