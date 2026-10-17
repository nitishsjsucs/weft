# Error analysis, round 1 (wave 4)

Lead analysis over the round 1 run (`docs/evals/2026-10-17-round1.md`, harness `a90de1f`, prompt `p-598e27523eb9`,
`gpt-5.6-luna`, k = 1), against the round 2 baseline (`docs/evals/error-analysis.md`, harness `6db1cfc`). It follows
the same method: open coding of every failing dev trace and every dev pass whose task has no content check, a root-cause
pass against the code at `7ec72b3`, then an adversarial re-check of the top causes (section 3). Read: the 55 round 1
dev traces (Phoenix trace project `UHJvamVjdDoxMQ==`, 1,196 spans exported over the REST API) and the 55 baseline dev
traces (`UHJvamVjdDoy`) for paired comparison. Held-out test traces were not opened: this analysis uses only the
published per-group counts, the failing-grader counts and the categories in the round 1 report.

Spend for this stage: $0.00 (read-only, no reruns). Wave ledger: $0.3051 of $3.00.

Headline: 49 of 55 dev and 32 of 41 held-out pass, with 0 unsafe actions. Of the 6 dev failures, 4 are one eval
bug (G5 grades with less evidence than the harness guard), 1 is a context and citation gap (MM-03), and 1 is a
prompt rule that reached too far (CQ-02). None is a model limit. The open coding also found 3 confident wrong answers
that pass only because their tasks have no content check and the judges are still pending (BN-02, CT-02, IN-01), one
product bug that spends half a routine's step budget (RT-02), and a measurement gap: the held-out compliance group fell
from 2 of 2 to 0 of 2 and the dev split has no compliance task to diagnose it with.

## 1. Taxonomy

Count is trials affected on dev (55) unless the row says otherwise. "Hidden" means the trial passes today only because
its task does not grade the behavior its reference describes.

| ID | Failure mode | Count | Layer | Examples (trace) | Root cause |
|---|---|---|---|---|---|
| R1 | G5 refuses figures the harness guard accepted: request figures, clock dates and the bounds of a relative window | 4 failing dev (BN-02, CP-01, OC-01, TO-01); 4 failing held-out (by category) | eval-bug | BN-02 `ae9199cbef7a` "October 2026"; CP-01 `fc8ae07354a8` "Oct 27", "15", "$1,500.00"; OC-01 `b8ce741c2d45` "15"; TO-01 `5c3289bd5669` "November 2", "November 8". Each trace's `grounding.check` span reads `{"ok":true,"offending":[]}`, 0 repairs, no fallback | `g5()` calls `check(text, toolResults(...))` with two arguments (`evals/suite/graders/index.ts` line 251). The loop calls `check(text, ev.results, ev.opts)` (`packages/agent/src/loop.ts` line 542), where `ev.opts` carries `request`, `now` and the run's echoed tool arguments (lines 282 to 296). FG2 and FG5 of round 1 landed separately and nothing tests that the two agree |
| R2 | A recalled procedure arrives as its heading line, so the rule it states never reaches the model | 1 failing (MM-03) | context-memory | MM-03 `7406729b7f31`: the `<recall>` block holds `knowledge/procedures/notice-escalation.md#L11` with the excerpt "id proc-notice-escalation. # Notice escalation". The routine instructions say to escalate "if a procedure in recall says to escalate"; the recall says nothing, so the run follows the derived `file_return` plan (prepare, draft, propose the filing and the reply) | `store.recall` turns every search hit into one line (`packages/executor/src/memory/store.ts` lines 368 to 377, one hit per file, the snippet of the matching line). The heading was the first line of the file to match a query word ("notice"), so it was kept and the steps below it (escalate, cite) were dropped as a second hit in the same file. The routine is not offered `memory.read` or `memory.search` (`AGENCY_NOTICE_PLAN_TOOLS`, `packages/routines/src/agency-notice.ts` line 39), so it could not open the note itself |
| R3 | A routine run cannot cite what steered it, so a task that asks for the citation fails even on a perfect run | 1 failing (MM-03 `mustMention`) | tool-design | MM-03: G5 wants "notice-escalation" in the run summary. The summary is "Prepared NY NYS-45 ... (#3); Drafted response 1 ... (#4); Proposed File NY NYS-45 ... (prp_0001); Proposed File response 1 ... (prp_0002)" | Harness 4.3: a routine summary is built from result summaries and proposal titles, never the prose (`routineSummary`, `loop.ts` lines 587 to 594). `notices.escalate` takes `{notice_id, reason_code}` and summarizes "Escalated ntc_... to the tax specialist with N evidence items" (`packages/core/src/commands/parity.ts` line 327). No structured field can carry a procedure reference, so "notice-escalation" can never appear |
| R4 | A "why did a figure change" question is sent to memory instead of to the drivers in the data | 1 failing (CQ-02) | harness-prompt (with tool-design) | CQ-02 `5609bacb2f1b`: step 1 is `reports.query` (payroll cost, Jul to Sep) plus `memory.search "payroll Q3"` (0 hits); step 2 widens the cost query to April. No headcount or hires read. Baseline `379f59b2bb48` ran four reads in step 1, `hires_and_departures_by_month` and `headcount_by_state` among them, and wrote "Headcount was flat at 45 ... 0 hires and 0 departures" | The round 1 memory rule (`packages/agent/src/prompts/index.ts` line 113) opens "Why and habit questions use memory", and the model applied it to a data question. `payroll_cost_by_month` rows carry no headcount or hires, so naming a driver always takes a second metric. The premise is false in `seed@v4` (only September has paid runs, 0 hires in Q3, headcount flat at 45): the round 1 answer refuted it correctly but did not check the drivers |
| R5 | An empty list of stored rows is reported as "none", although the job that writes those rows never ran | 2 hidden wrong answers (BN-02, IN-01); 1 weak (IN-02) | tool-design | BN-02: `benefits.list_findings {month: 2026-10}` returns `{"count":0}`, and the answer is "No benefits overbilling findings were recorded for October 2026". IN-01: `integrations.list_sync_items {status: all, vendor: workday}` returns 0 items, and the answer is "Workday is in sync" | Findings exist only after `benefits.reconcile` (an R1 write, not on the chat list) has run for the month (`packages/core/src/commands/benefits.ts` lines 75 to 109). The carrier simulator plants three errors on every invoice (`packages/sim/src/carrier.ts` lines 2 to 6): a departed worker keeps a full month on the bill, and the first single-coverage member is billed the family tier. Both are overbilling in October, so "no overbilling" is wrong. Sync items exist only after `integrations.sync_now`; the seed has none, and `integrations.status` (health, last sync) is not the tool the integrations route swaps in. Neither read says whether the month was reconciled or the vendor ever synced |
| R6 | Chat has no read for what contractors are owed, and the task reference names data the world does not have | 1 hidden (CT-02) | tool-design, eval-bug | CT-02: "What do we owe contractors this month in USD?" answered "$0.00" from `payroll_cost_by_month` (`contractor_cents: 0`), which counts paid payouts only | `CHAT_TOOLS_W3` and `CHAT_DOMAIN_ROUTES` (`packages/contracts/src/wave3.ts` line 138) have no contractors read. The reference says "payouts and rates are seeded", but the seed holds FX rates and no payout rows |
| R7 | `flagged_only` is ignored in a detailed pay run read, so the read returns the 44 ready paychecks instead of the 4 flagged ones | 1 trial at its step cap (RT-02, 6 of 6 steps, 3 wasted) | product-bug | RT-02: `payroll.get_run {flagged_only: true, response_format: detailed}` offloads 44 rows to `art_0001`; two `agent.read_artifact` pages follow, then the concise `get_run` it needed | `concisePayrollRun` sets `listOthers = filters.detailed \|\| ...` (`packages/core/src/payroll/views.ts` line 78), so detailed mode lists the ready rows whatever `flaggedOnly` says |
| R8 | Grounding reads a day range after a month name as a date plus a bare number | 1 repair (CP-04); the answer lost its dates | verification-guard | CP-04: the draft wrote the request's dates as a month, a day, an en dash and a second day ("November 23 to 27, 2026" and "November 23 to 25" in that form). The guard refused "27" and "25"; the repaired answer says only "on the listed dates" | `packages/grounding/src/dates.ts` parses "Month D" and the trailing day stays a numeral with no matching leaf, although `2026-11-27` and `2026-11-25` are in the result |
| R9 | No dev signal for three held-out groups, one of which regressed | held-out compliance 2 of 2 to 0 of 2; compliance, portal and mentions have 0 dev tasks | eval-bug (coverage) | Per-group counts only (section 1 of the round 1 report) | The dev split was stratified before the wave 4 groups had dev tasks. Round 1 changed the behavior the compliance group depends on: `rt_compliance_notices` was folded into `rt_agency_notice`, an informational notice now skips instead of `notices.acknowledge`, escalation moved from `handoffs.open` to `notices.escalate`, and the routine now acts (approval-gated) on every notice kind. Which of these the held-out failures hit is not known from here, by design. Only 3 dev tasks (NT-01, NT-02, MM-03) cover the planner's 6 plans |

Not a category: `PROVIDER_UNAVAILABLE` ("Connection error.") on 17 of 145 LLM spans in 14 of 55 dev traces (11.7%),
about the baseline's rate. Every one fails in 20 to 110 ms and is retried within 10 ms, and the retry succeeds, so
the latency cost is under 0.1 s per trace and nothing is lost. The pattern (instant failure on a reused connection)
fits a stale pooled keep-alive socket after the gap between trials. The provider runs with `maxRetries: 0` by design
(the loop reserves every attempt), so this stays as is; the spans already carry `weft.retry`.

Efficiency note: the system prompt grew from 8,622 to 10,353 characters in round 1 (+20%). Per model call, prompt
tokens rose 11% and uncached prompt tokens 23%. That is most of the cost rise on dev ($0.0597 to $0.0694) despite
fewer tool calls (137 to 113). New prompt rules in round 2 should replace text, not add to it.

### Transition matrix (last good stage to first failed stage)

| Last good | First failed | Trials | Mode |
|---|---|---|---|
| final text | grader | BN-02, CP-01, OC-01, TO-01 | R1 (the agent did not fail) |
| admission | context | MM-03 | R2, then R3 at final text |
| context | tool selection | CQ-02 | R4 |
| tool selection | result use (hidden) | BN-02, IN-01 | R5 |
| context | tool selection (hidden) | CT-02 | R6 (the tool is not offered) |
| result use | budget (near miss) | RT-02 | R7 |

The runner labeled MM-03 "tool selection". Its first failure is context: the run escalated nowhere because the rule
never reached it, and it could not have read the note.

## 2. Ranked fixes

Gain is counted on today's graders for dev, then held-out by category, then the quality gain that does not move a
count. Confidence is high when the fix is deterministic code and medium when it depends on the model following a prompt
rule or a recalled procedure (confirm those at k = 3).

| Rank | Fix | Modes | Expected gain | Confidence | Group |
|---|---|---|---|---|---|
| 1 | G5 grades with the guard's evidence: the task request, the world clock and the main run's echoed tool arguments, built by one shared helper that the loop also uses; an agreement test pins G5 and the guard to the same verdict; G5 reports how many figures were grounded only by the request or the clock | R1 | +4 dev (49 to 53 of 55); +4 held-out by category (32 to 36 of 41) | high | FG1, FG4 |
| 2 | A recall hit in `knowledge/procedures/` (and `knowledge/decisions/`) brings the note's body excerpt, not the matched line, ranked above timeline hits; the routine context lists each recalled procedure's path | R2 | MM-03 escalates (end state) | medium | FG2 |
| 3 | `notices.escalate` takes an optional `procedure_ref`, validated by the executor (an existing, untainted `knowledge/procedures/*.md` path), returned in its data and named in its summary ("... per knowledge/procedures/x.md"); when the run-start recall holds a procedure, the engine adds it to the derived escalation arguments; a harness 4.3 amendment line records that a citation is a structured field, never prose | R3 | MM-03 passes with rank 2 (+1 dev, 55 with ranks 1 to 4) | high for the field, medium for the run | FG2 |
| 4 | The memory rule covers decisions, policies and habits ("why do we", "who usually"), not changes in a figure; a short change rule says to compare with the prior period, read the drivers (headcount, hires and departures, pay changes) in the same batch, and say so plainly when the data shows no change; `payroll_cost_by_month` rows carry `workers_paid`, `hires` and `departures` for the period | R4 | +1 dev (CQ-02); fewer wasted memory searches on data questions | medium (prompt), high (report shape) | FG3 |
| 5 | Empty reads say what they cover: `benefits.list_findings` returns `reconciled` and `last_reconciled_at` for the month and, for a month never reconciled, a read-only preview (`computeFindings` without `storeFindings` or the event), labeled preview, which needs a non-storing read of the carrier simulator because `invoice(month)` stores the invoice on its first call (if that is not acceptable, return `reconciled: false` and say so); `integrations.list_sync_items` returns each vendor's `last_sync_at`, and the integrations route swaps in `integrations.status` | R5 | No count today (hidden); BN-02 and IN-01 answer correctly, which the tightened tasks in rank 8 then grade | high | FG3 |
| 6 | `payroll.get_run` honors `flagged_only` in detailed mode | R7 | RT-02 3 steps instead of 6; less spend and latency on every payroll review run | high | FG3 |
| 7 | A day range after a month name ("Month D1 to D2", with "to", a hyphen or an en dash, with or without a year) is read as two dates | R8 | Removes CP-04's repair and keeps its dates; dev repairs 1 to 0 | high | FG4 |
| 8 | Dev coverage and task truth: new dev tasks for compliance, portal and mentions written from the parity spec (not from held-out failures), one dev task per untested notice plan (penalty, informational, unknown kind); BN-02 and IN-01 gain content checks once rank 5 lands; CT-02's reference is corrected and its world gets a scheduled payout mutator, and a contractors route offers `contractors.list_payouts` (rank 8 needs the route, FG3) | R5, R6, R9 | Dev may first drop by up to 3 (hidden failures surface); the compliance regression becomes diagnosable on dev | high | FG1, FG3 |

Expected outcome on today's graders: 49 of 55 dev becomes 53 of 55 from rank 1 alone, and 55 of 55 with ranks 2 to 4.
Held-out moves from 32 to about 36 of 41 from rank 1; the compliance group needs rank 8 first. Rank 8 then moves hidden
failures into view, so rebaseline with the tightened suite before claiming a rate. Both pending decisions stay off:
no fix here changes `agent.chat_can_propose` or auto autonomy.

## 3. Adversarial check of the top causes

**RC1, G5 evidence mismatch (R1). Holds, with one risk the fix must cover.** Line 251 of
`evals/suite/graders/index.ts` passes no options; line 542 of `loop.ts` passes `ev.opts`, built at lines 282 to 296
from the run's tool arguments plus `groundingBase` (request and clock). All four dev traces show the guard's span at
`{"ok":true,"offending":[]}` with 0 repairs. Every flagged figure is the person's own words ("Oct 1 to 15", "Oct 27",
"$1,500.00"), the clock's month, or the bounds of "next week" from a Monday clock (November 2 to 8). Risk: once G5
uses the guard's evidence, G5 is no longer an independent check, and a guard that accepts too much would go unseen.
Echoes are not the soft spot (they only make the check stricter: a result string equal to a tool argument stops
counting as evidence, `check.ts` line 24). The soft spot is the clock: window bounds are derived from relative phrases
in the request and in the answer itself (`clockDates(opts.now, [request, text])`, `check.ts` line 123), so an answer
that names its own window ("within 30 days, by November 25") grounds that bound with no source. Only bounds are
derived, never days inside a window, which limits the exposure. So rank 1 reports, per trial, the figures grounded
only by the request or the clock, and FG4 decides, with a test either way, whether a phrase in the answer (not the
request) may derive a bound.

**RC2, the recall excerpt (R2). Holds, and it is not enough on its own.** The MM-03 LLM input shows the recall line
verbatim, with only the heading. `store.ts` lines 368 to 377 build every hit from one line's snippet. Two refinements
from the trace. First, the round 1 report says the run "never opened the note with memory.read or memory.search"; the
run was never offered either tool (its LLM spans list `notices__draft_response`, `notices__escalate`, `notices__get`,
`notices__send_response`, `tax__file_return`, `tax__prepare_filing`), so that was not a model choice. Second, the
body alone cannot pass MM-03, because of RC3.

**RC3, no citation channel (R3). Holds.** `routineSummary` (`loop.ts` lines 587 to 594) joins result summaries and
proposal titles, as harness 4.3 requires, and the `notices.escalate` summary names no procedure. A run that escalates
correctly would still fail `mustMention: notice-escalation`. Two ways out were weighed: weaken MM-03 to drop the
citation, or give the harness a structured citation. The citation is the behavior the reference asks for and a person
reading the inbox benefits from it, so rank 3 adds the validated field rather than changing the task. The field is
validated by the executor, so a run cannot cite a note that does not exist or is tainted.

**RC4, CQ-02 (R4). Partly holds.** Tool selection is the first failure, but "one k = 1 trial, may be variance" is
not the whole story. The round 1 trajectory spends a call of its first batch on `memory.search "payroll Q3"`, which
is what the new memory rule ("Why and habit questions use memory") says to do with any "why" question, and the
baseline, without that rule, spent those calls on hires and headcount. Refuted in part: the task is not simply
"tightened too far". `seed@v4` has no Q3 increase to explain, and the best answer refutes the premise and rules out
the drivers ("headcount flat at 45, 0 hires"), which the current check already accepts. So the check stays, the rule
narrows, and the report shape makes the drivers arrive with the cost read. Confirm at k = 3.

**RC5, empty reads (R5). Holds.** `benefits.list_findings` reads stored rows only, and only `benefits.reconcile`
writes them; chat cannot run it. The carrier simulator plants its billing errors on every month's invoice, so "no overbilling" is wrong for October. The
seed has no sync item rows, and the Workday answer "in sync" rests on an empty list, while health and last sync live
in `integrations.status`. One sub-claim narrowed: IN-02's answer ("no Workday sync conflict for her ... please
provide the conflict details") is cautious and asks for what it needs, so IN-02 is weak, not wrong. After rank 1,
BN-02 will pass while still wrong, until rank 5 and rank 8 land.

Also checked and kept: R7 (the `listOthers` expression ignores `flaggedOnly` whenever `detailed` is set; the 44 rows
match the run's "44 ready" count exactly) and R8 (the CP-04 guard span lists exactly "27" and "25", the second day of
each range).

## 4. Fix groups

Four groups with disjoint owned paths, for parallel fixers. A group edits only its owned paths; anything else is a
request to the owning group. No group edits `evals/suite/tasks/test/`, `evals/suite/reference/test/`, `.data`,
`apps/web/next-env.d.ts` or Phoenix data, or reads held-out traces. No dev literals go into prompts, tool descriptions,
prechecks or recall code (the anti-leak scan applies).

### FG1: Eval suite, dev split only

Owns: `evals/suite/graders/`, `evals/suite/judges/`, `evals/suite/tasks/dev/`, `evals/suite/reference/dev/`,
`evals/suite/worlds/`, `evals/suite/runner.ts`, `evals/suite/drivers.ts`, `evals/suite/evidence.ts`,
`evals/suite/phoenix.ts`, `evals/suite/report.ts`, `tests/evals-suite.test.ts`.

1. G5 grades with the guard's evidence: the task request, the world clock and the main run's tool arguments (minus
   `comms.post_update`), through FG4's shared helper (R1). Until that helper lands, build the same three inputs
   locally and switch over after.
2. An agreement test: for fixtures shaped like the four round 1 mismatches, G5 and the loop's guard return the same
   verdict; G5's detail and the report carry the count of figures grounded only by the request or the clock.
3. Re-grade the saved round 1 dev evidence with the fixed G5 offline at $0, so the next comparison separates the
   grader change from harness changes.
4. New dev tasks from the parity spec, never from held-out failures: at least 2 compliance, 1 portal, 1 mentions,
   and one notice task each for the penalty, informational and unknown-kind plans; pin their digests in a reviewed
   commit (R9).
5. BN-02 and IN-01 gain content checks after FG3 item 4 lands (the answer reflects the reconciliation or sync state);
   CT-02's reference is corrected and a mutator adds a scheduled contractor payout so the question has an answer
   (R5, R6).
6. `firstFailure` labels a trial whose recall held the needed note but whose context never showed the rule as
   context, not tool selection (R2).

### FG2: Memory recall and routine citations

Owns: `packages/executor/src/memory/`, `packages/executor/test/memory*.test.ts`, `packages/routines/` (src and test),
`packages/agent/src/runtime.ts`, `packages/core/src/commands/parity.ts`, `packages/core/src/parity/escalation.ts`,
`packages/core/test/parity*.test.ts`, `research/harness.md`.

1. A recall hit whose file is under `knowledge/procedures/` or `knowledge/decisions/` contributes the note's body
   excerpt (`excerptOf`, capped as a dossier is), with its id and path, ranked above timeline hits; `trustedOnly`
   routine filtering is unchanged (R2).
2. `notices.escalate` gains an optional `procedure_ref`: the executor checks it names an existing, untainted
   `knowledge/procedures/*.md` note, and the result data and summary name it (R3).
3. When a routine's run-start recall holds a procedure, the engine adds its path to the derived `notices.escalate`
   arguments and lists recalled procedure paths in the routine context (R2, R3).
4. A harness 4.3 amendment line: a routine summary may cite a memory note only through a validated structured field.
5. Tests: a procedure hit renders its steps, a tainted procedure is never cited, an unknown `procedure_ref` is
   refused, and GP1, GP16 and the notice golden paths still pass.

### FG3: Chat prompt, chat routing and read tool shapes

Owns: `packages/agent/src/prompts/`, `packages/agent/test/prompts.test.ts`, `packages/core/src/commands/benefits.ts`,
`packages/core/src/commands/contractors.ts`, `packages/core/src/integrations/commands.ts`,
`packages/core/src/reports/`, `packages/core/src/commands/reports.ts`, `packages/core/src/payroll/views.ts`,
`packages/core/test/` (except `parity*.test.ts`), `packages/contracts/src/wave3.ts`,
`apps/api/src/agent/chat-allowlist.ts`, `apps/api/test/chat-allowlist*.test.ts`.

1. Narrow the memory rule to decisions, policies and habits, and replace (not extend) prompt text with a short change
   rule: compare with the prior period, read the drivers in the same batch, say plainly when the data shows no change.
   Keep the system prompt at or under its round 1 length; bump the prompt version (R4).
2. `payroll_cost_by_month` rows carry `workers_paid`, `hires` and `departures` for the period (R4).
3. `payroll.get_run` honors `flagged_only` in detailed mode, with a test (R7).
4. `benefits.list_findings` returns `reconciled` and `last_reconciled_at` and, for a month never reconciled, a
   read-only preview labeled as such (through a non-storing carrier read, since `invoice(month)` stores on first call; otherwise only `reconciled: false`); `integrations.list_sync_items` returns the vendor's `last_sync_at`; each empty
   result's summary says what it covers (R5).
5. Routing: the integrations route swaps in `integrations.status`; a contractors route (owe, contractor, payout words)
   swaps in `contractors.list_payouts`; both stay read-only, inside the 16-tool cap, with tests (R5, R6).

### FG4: Grounding and the shared evidence helper

Owns: `packages/grounding/` (src and test), `packages/agent/src/loop.ts`, `packages/agent/test/loop.test.ts`.

1. Export one helper that builds the check options from a run's steps (request, clock, echoed arguments, excluding
   `comms.post_update`); the loop uses it, and FG1's G5 imports it (R1).
2. Read "Month D1 to D2" day ranges (with "to", a hyphen or an en dash, with or without a year) as two dates, with
   regression tests for each form and a test that a bare number after a month range is still checked (R8).
3. Decide whether a relative phrase in the answer, not only in the request, may derive a window bound, and pin the
   decision with a test (today `check.ts` line 123 reads both), so FG1's agreement test has a fixed reference point
   (RC1 risk). Record the decision in the grounding package's header comment.

### Cross-group contracts

- FG4 exports the evidence helper; FG1 consumes it. Either can land first (FG1 builds the same inputs locally until
  then).
- FG2 adds `procedure_ref` to `notices.escalate`; FG1 keeps MM-03 unchanged and expects the citation through it.
- FG3's item 4 lands before FG1 adds the BN-02 and IN-01 content checks; FG3's contractors route lands before FG1's
  CT-02 world change.
- FG1's new dev tasks must be solvable with the tools FG2 and FG3 offer (the solvability lint enforces it).

### Measurement after the fixes

Run the dev suite scripted first ($0), then live at k = 1 (about $0.07 at round 1 cost), then k = 3 on MM-03 and
CQ-02 (about $0.01), each stage under its own cap and checked against `~/Developer/projects/weft-notes/wave4-spend.json`
before spending. Report three rows side by side: round 1 as graded, round 1 re-graded with the fixed G5, and round 2,
so the grader change is not read as a harness gain. Confirm on held-out at most once more this wave, and report the
compliance group separately.
