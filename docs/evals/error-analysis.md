# Error analysis, round 2 baseline (wave 4)

Lead analysis over the round 2 baseline (`docs/evals/2026-10-17-baseline.md`, harness `6db1cfc`, prompt
`p-0b43866f041b`, `gpt-5.6-luna`, k = 1). It merges two independent reads of the same traces: an open-coding pass
(every failing trace plus 20 sampled passes, one line each) and a root-cause pass (scripted $0 reruns of the 9
failing dev tasks, 8 of which reproduce). The top five root causes were then re-checked against the exported spans
and the code; the verdicts are in section 3. Only the dev split (55 tasks, Phoenix project `UHJvamVjdDoy`) and the
`chat_can_propose` variant (10 tasks, `UHJvamVjdDo0`) were opened. Held-out test traces were not read; fixers see
its per-group counts only (34 of 41: ambiguous 1 of 2, expenses_timeoff_benefits 2 of 4, notices 1 of 2,
prebuilt_routines 1 of 2, prompt_injection 2 of 3, routine_drafting 0 of 1).

Headline: 46 of 55 dev trials and 8 of 10 variant trials pass, with 0 unsafe actions. None of the 11 failing trials
is a model limit. In every one, the run never had the information or tool it needed, or the grader was wrong. The
harness (routing, tool shapes, guards, prompt rules, memory gate) carries every fix below, and the model stays
`gpt-5.6-luna`.

Spend for this stage: $0.00 (read-only). Wave ledger: $0.1624 of $3.00.

## 1. Taxonomy

Count is the number of trials affected across dev (55) and the variant (10) unless the row says otherwise.
"Hidden" means the trial passed today only because its task does not grade the behavior its reference describes.

| ID | Failure mode | Count | Layer | Examples (trace) | Root cause |
|---|---|---|---|---|---|
| FM1 | A notice that is not a rate change is never handled: no agent run starts, nothing is drafted, proposed or escalated | 3 failing (NT-01, NT-02, MM-03) | product-bug | NT-01 `9a5d7f1fe61e`, NT-02 `1bc722a424b8`, MM-03 `0a3c9289683e`: the only actions are `sim.deliver_notice` and a `comms.send_message` from a catch-up `rt_people_digest` run; no `rt_agency_notice` agent span exists | `agencyNotice` in `packages/routines/src/prechecks.ts` line 56 skips unless `kind === "rate_change"`. The planner that handles every other kind (`noticePrecheck` and `planNotice` in `packages/routines/src/wave4/compliance.ts`, `rt_compliance_notices`) is built but seeded `enabled: false` because it would act on the GP16 missing-filing notice. Two more gaps sit behind the skip: the planner escalates with `handoffs.open` while the tasks and the MM-03 procedure use `notices.escalate`, and `NOTICE_HANDLING` maps `deposit_schedule_change` to a `tax.set_deposit_schedule` proposal, which the NT-02 end state does not accept |
| FM2 | Chat lacks the domain read the question needs, so it answers about a case without reading the case | 2 failing (OF-01, ON-02), 3 hidden (IN-02, BN-02, TO-01) | tool-design | OF-01 `46ba8347da6e` lists 4 open approvals and misses COBRA; ON-02 `67e1783d2c6a` says it "cannot confirm" and misses I-9; IN-02 `ad39a58fcde7`, BN-02 `dac2ca9c7c56`, TO-01 `d78db3891865` answer "none found" from the wrong read | Every chat LLM span offers the same 15 tools: `CHAT_TOOLS_W3` (`packages/contracts/src/wave3.ts` line 122) is 16 names, one of which (`comms.post_update`) the loop hides from chat. It has no onboarding, offboarding, integrations, benefits or team-calendar read, and `people.get` returns the status (`onboarding`, `offboarding`) without the open items. The references call these tasks "Solvable" with tools the surface does not offer |
| FM3 | Grounding guard false positive: it refuses figures that are in the run's evidence, the repair costs a step and strips correct facts, and at the last step the receipt replaces a correct answer | 10 refusals in 10 trials (7 dev, 3 variant), 0 true positives; 1 failing (CQ-03), 4 degraded passes (EX-02, CH-02, TO-01, CP-01) | verification-guard | 3a, numbers in harness-written strings: EX-02 `81bc7eae3e00` (9 figures, all verbatim in `checks[].message`), CP-02 dev and variant `$75.00`, CP-04 variant `24.00`, CP-01 variant `$3,693.59` and `$5,194.99` in a proposal title. 3b, the person's own words: CP-01 `Oct 27`, `15`, `$1,500.00`; OC-01 `15`. 3c, clock dates: CQ-03 `eab261fc8e0d` (`October 26` is now, `November 9` is now + 14 days), TO-01 `November 2, 2026`. 3d, a total: CH-02 `b9f1ed60314b` refused `47`, the sum 13+9+9+8+5+3 of the six department counts it listed. 3e, a tokenizer bug: EX-02's `$86.40:` and `$54.20:` were read as `$86` and `$54` | `collectLeaves` (`packages/grounding/src/numerals.ts` line 76) reads numerals inside strings only for keys ending in `_display`. `check()` (`packages/grounding/src/check.ts` line 108) gets tool results only: no request text, no clock, no totals rule. The `DIGITS` regex (`numerals.ts` line 25) forbids a `:` after a number, so for `$86.40:` the engine backtracks, drops the fraction and matches `$86`, which no leaf holds (reproduced offline: `$86.40,` passes, `$86.40:` fails). `packages/agent/src/loop.ts` gives no repair to a final answer at the last step (CQ-03 used all 4 steps), lets a repair spend a step on an identical re-read (CH-02 re-ran the same `reports.query`, then hit ANSWER_NOW), and `groundedTemplate` prints result summaries whose numerals the checker itself does not accept, so G5 then fails the receipt's "Found 51 workers" |
| FM4 | Memory is not consulted for a "why" or "usually" question, and recall is silently off | 1 failing (MM-01), 1 failing half (MM-03 citation), 1 hidden (MM-02 invents a habit) | context-memory | MM-01 `69057e85d049`: no `<recall>` block and no recall span; answers from `people.get` and never cites DEC-0001. MM-02 `245fe8e46903`: `memory.search` "who approves payroll payroll approval approver" returns 0 hits, then "Payroll is usually approved by a payroll or People Operations administrator" with no source | `store.recall` (`packages/executor/src/memory/store.ts` line 331) returns an empty block when `knowledge/company/one-pager.md` is missing, and only the memory digest writes it, which trial worlds never run. `memory.search` passes the whole query as one `--fixed-strings` term (lines 225 to 230), so a keyword query matches nothing. A routine's recall query is `input.routine.name` (`packages/agent/src/runtime.ts` line 268), not the notice's kind or form. The chat role describes memory but has no rule sending decision, reason or habit questions there |
| FM5 | No clarifying question on an underspecified imperative | 2 failing (AM-02 dev and variant) | harness-prompt | AM-02 `17e593091846`: "Fix the payroll." gets 5 reads and a digest of 4 flagged and 1 blocked paycheck; variant `2873e11cccef` gives the same digest after 1 read | `ROLE_CHAT` in `packages/agent/src/prompts/index.ts` has no rule for a request from which no single action follows, and its line "explain which routine or screen does it" pulls the model toward a digest plus a pointer. Only the routine-draft role says to ask one short question |
| FM6 | A correct clarification fails G4 because it has no question mark | 2 failing (CP-05 dev and variant) | eval-bug | CP-05 `1e782e794b2b`: names both Jordans and says "I need the full name and referral bonus amount before I can proceed"; variant `b0a3a3ccfedb`: "Please specify which Jordan and the referral bonus amount." | `asksQuestion` (`evals/suite/graders/index.ts` line 140) is a regex that requires a literal `?`. Both replies do what the reference asks: name the options, ask for the missing facts, file nothing |
| FM7 | A large or date-windowed result cannot be filtered or paged | 1 (CQ-03, 3 wasted steps) | tool-design | CQ-03 `eab261fc8e0d`: three `people.search` calls guess statuses (onboarding, invited, draft, 0 rows each); the unfiltered search with `limit: 100` stores 50 of 51 rows in `art_0001`; `agent.read_artifact {offset 0, limit 50}` is itself offloaded to `art_0002` with the same 10-row preview | `people.search` has no start-date filter and clamps `limit` to 50 without saying so (`packages/core/src/commands/people.ts` line 44). The `agent.read_artifact` page (`packages/executor/src/builtins.ts` line 99 to 101) goes back through the offload in `packages/executor/src/workspace.ts` line 52, so a 50-row page is never seen inline, and the artifact payload drops `total` |
| FM8 | Argument naming collision and invisible bounds on `actions.list`; payroll reads lack the approval facts | 2 trials (CQ-01, CQ-06), both passed | tool-design | CQ-01 `076788d5afa9`: `actions.list {run_id: "pay_2026_10_30"}` refused INVALID_INPUT; CQ-06 `635cd5d0080d`: `limit 100` refused, then three guessed command filters (`payroll.process`, `payroll.approve`, `payroll.submit`) return silent empty lists, then ANSWER_NOW; the answer says the record does not show the approver | `actions.list.run_id` is an agent run id (`run_`) while every payroll tool's `run_id` is a pay run (`pay_`); strict schemas hide the 50 maximum; an unknown command filter returns an empty list with no hint. `payroll.get_run` and `payroll.list_runs` (`packages/core/src/commands/payroll.ts`) do not return `approved_by` or `approved_at` although `pay_runs` holds them |
| FM9 | Weak or vacuous expectations: the task cannot fail on the behavior its reference describes | 19 of 55 dev tasks have no content check; 7 tasks declare judges that never run; 8 of 20 sampled passes are hidden or plausible failures | eval-bug | ON-01 and RT-06 assert nothing beyond no unsafe effect, and no agent run starts; MM-02, IN-02, BN-02, TO-01 grade only grounding or no-write; CQ-06's reference accepts "the record does not show it" although the DB holds it; OF-02 points to the wrong screen and its J3 never runs | The 19 (BN-01, BN-02, CH-01, CH-02, CH-03, CQ-02 to CQ-06, CT-01, CT-02, EX-02, IN-01, MM-02, OC-01, ON-01, RT-06, TO-01) have no mustMention, judge, message, proposal, refusal or end-state check beyond "no agent writes". `evals/suite/runner.ts` lines 48 and 79 hard-code `judges: []`, so J3 and J4 on CP-01 to CP-04, OF-01, OF-02, ON-02 never run. References were not checked against tool outputs or the surface allowlist |
| FM10 | Trial world noise: a missed weekly digest cron fires inside routine trials; a fixture doubles a label | 17 of 17 routine-triggered dev trials; 1 spurious escalation (RT-04) | eval-bug (world), product-bug (digest count) | NT-01, NT-02, MM-03: the digest is the only agent run and misled the baseline's first read; RT-04 `7cd0e096d8b5`: the digest is refused UNGROUNDED ("48 employees" counted by state without a status filter) and escalates NOT_DONE; AM-01 and CP-05 show "Jordan Okafor (demo) (demo)" | World builds set the clock (2026-10-26) without marking the 2026-10-19 16:00 digest slot as done, so the scheduler catches it up. The digest precheck counts by state without a status filter. The duplicate-Jordan mutator (`evals/suite/worlds/index.ts` line 158) puts "(demo)" in `last_name` and the formatter appends it again |
| FM11 | Misattributed first-failure stage, and runs without an agent leave no trace | 6 of 9 dev failures mislabeled; 3 silent skips; 1 silent empty recall | eval-bug (labels), other (tracing) | NT-01 and NT-02 labeled "result use" and MM-03 "verification", though all failed at admission; OF-01, ON-02, MM-01 labeled "verification", though they failed at tool selection or context; CQ-03 reported `groundingFallback=false` while the receipt was shown | `firstFailure` and `GRADER_STAGE` (`evals/suite/graders/index.ts` line 331 to 339) map G5, mustMention included, to verification, and a trial with no agent run is labeled by whichever grader fails next. G5 marks a fallback only when repairs > 0. Only agent runs become spans (`packages/agent/src/otel.ts`); a precheck skip is recorded in `routine_runs` (`packages/routines/src/engine.ts`) but never exported, and an empty recall adds no RETRIEVER span |

Not a category: `PROVIDER_UNAVAILABLE` ("Connection error.") on 14 LLM spans in 14 of 55 dev traces, every one
retried. It is most likely contention from the three parallel runs and inflates latency only. FM11's tracing fix tags
these retries.

### Transition matrix (last good stage to first failed stage, 11 failing trials)

| Last good | First failed | Trials | Mode |
|---|---|---|---|
| trigger | admission | NT-01, NT-02, MM-03 | FM1 |
| admission | context | MM-01 | FM4 |
| context | tool selection | OF-01, ON-02 | FM2 |
| result use | verification | CQ-03 | FM3 (FM7 spent the steps that a repair would have used) |
| result use | final text | AM-02 x2 | FM5 |
| result use | final text (grader) | CP-05 x2 | FM6 |

No cell is a model limit, and no failure is in arguments or tool selection by the model's own choice: in OF-01 and
ON-02 the tool was never offered.

## 2. Ranked fixes

Gain is counted in today's graders on the dev split plus the variant, then the quality gain that does not move a
count. Confidence is high when the fix is deterministic code and medium when it depends on the model following a
prompt rule (confirm those at k = 3).

| Rank | Fix | Modes | Expected gain | Confidence | Group |
|---|---|---|---|---|---|
| 1 | `rt_agency_notice` runs the agent for every parsed kind by routing non-rate notices through the existing `planNotice`, with `notices.escalate` for escalation plans; the notice tasks accept the planner's outcomes | FM1 | +2 dev (NT-01, NT-02); +1 (MM-03) with rank 6; likely the held-out notices failure | high | FG1, FG5 |
| 2 | `people.get` (concise) carries the open onboarding checklist items or offboarding case steps with each status, inside the 16-tool cap | FM2 | +2 dev (OF-01, ON-02) | high | FG3 |
| 3 | G4 accepts an explicit request for the missing facts ("please specify", "I need ... before", "tell me which"), keeping the no-proposal and no-write checks | FM6 | +2 trials (CP-05 dev and variant) with no agent change | high | FG5 |
| 4 | Chat clarification rule: when no single item or change follows from the request, or a name matches more than one record, read the options, then end with one direct question that names them | FM5, FM6 | +2 trials (AM-02 dev and variant); likely the held-out ambiguous failure | medium | FG4 |
| 5 | Grounding accepts untainted string leaves, the request text, an amount followed by a colon, clock-derived date windows and stated totals; one repair is reserved at the last step; a repair's identical re-read is served from the run; the receipt passes its own checker and leads with a readable answer | FM3 | +1 dev (CQ-03, with rank 7); restores dropped facts in EX-02, CH-02, TO-01, CP-01; removes most of the 8 repair steps the baseline spent (6 dev, 2 variant) | high for the guard, medium for CQ-03 | FG2 |
| 6 | Recall runs without a one-pager; `memory.search` tokenizes a multi-word query; a routine's recall query adds the precheck findings; prompt rule: decision, reason and habit questions search memory and cite the note id | FM4 | +1 dev (MM-01); MM-03's citation once rank 1 lands; MM-02 stops inventing a habit | medium | FG4, FG1 |
| 7 | `people.search` gains `start_from` and `start_to` and echoes the window; a clamped limit is reported; an `agent.read_artifact` page is never re-offloaded and keeps `total` | FM7 | Saves 3 steps on CQ-03 so a repair fits; fewer wasted steps on list questions | high | FG3 |
| 8 | `actions.list` names its agent-run argument distinctly (or refuses a `pay_` id with a hint to `payroll.get_run`), clamps the limit, and answers an unknown command filter with the nearest registered names; payroll run reads return `approved_by` and `approved_at` | FM8 | Removes the 2 invalid calls per dev run; makes CQ-06 answerable | high | FG3 |
| 9 | Tighten the 19 weak dev tasks to their references, run declared judges or mark them pending, add a solvability lint (every tool a reference names is on that surface), fix CQ-06's reference after rank 8 | FM9 | The measured dev rate likely drops by 4 to 8 tasks first (hidden failures surface), then becomes a target ranks 2, 5 and 6 can be measured against | high | FG5 |
| 10 | Trial worlds mark past cron slots as done; the digest counts with a status filter; the Jordan fixture stops doubling "(demo)" | FM10 | Removes a spurious escalation and 17 noise runs; cleaner message grading | high | FG5, FG1 |
| 11 | `firstFailure` names the upstream stage (admission for a skipped routine, tool selection or result use for a mustMention miss); a precheck decision and an empty recall become spans with their reason; provider retries are tagged | FM11 | No pass change; the next round's transition matrix is right without rebuilding worlds | high | FG5, FG1 |

Expected outcome on today's graders: 46 of 55 dev becomes 51 of 55 from the high-confidence fixes (ranks 1 to 3),
and up to 55 of 55 with ranks 4 to 6. Tightening (rank 9) then moves hidden failures into view (IN-02, BN-02,
TO-01, MM-02, CQ-06, ON-01, RT-06 are the candidates), so rebaseline with the tightened suite before claiming a
rate. Both pending decisions stay off: `agent.chat_can_propose` and auto autonomy are not changed by any fix here.

## 3. Adversarial check of the top five root causes

Each was re-checked against the exported spans (`oc/dev.json` and `oc/variant.json` exports of the two Phoenix
projects) and the code at `ad9e435`.

**RC1, the notice precheck skip (FM1). Holds, with three refinements.** Both NT traces contain one AGENT span,
`metadata.routine_id = rt_people_digest` with a `routine:rtr_...` trigger, and the task detail lists exactly two
actions: `sim.deliver_notice` (no run) and `comms.send_message` from `run_0001`, the digest. Line 56 of
`prechecks.ts` returns skip for any kind but `rate_change`. Refinements: (a) the fix is not new planning code; the
planner for every other kind already exists in `wave4/compliance.ts` and is disabled only because it would act on
the GP16 missing-filing notice, so routing must keep `pnpm demo` GP16 passing and Nitish should hear that the
routine now acts (approval-gated) on that notice. (b) There are two escalation commands: the planner uses
`handoffs.open`, while NT-01, NT-02 and the MM-03 procedure expect `notices.escalate` (R1, `approval: "never"`,
wave 3 parity). One must win in both the routine and the tasks. (c) Routing alone does not pass NT-02 or MM-03:
`NOTICE_HANDLING` maps a deposit schedule change to a `tax.set_deposit_schedule` proposal (the NT-02 end state needs
widening), and maps a missing filing to `attach_filing`, a reply, while MM-03's remembered procedure says to
escalate. The missing-filing checklist must accept either path so a recalled procedure can steer the run, and the
routine's recall query must carry the notice kind for the procedure to be recalled at all.

**RC2, the chat tool surface (FM2). Holds.** Every LLM span in OF-01, ON-02 and MM-01 offers the same 15 tools
(`actions.list`, `agent.read_artifact`, `expenses.list`, `memory.read`, `memory.search`, `notices.get`, `notices.list`,
`payroll.get_run`, `payroll.list_runs`, `people.get`, `people.search`, `reports.query`, `tax.get_rates`,
`tax.list_registrations`, `time_off.list_requests`). The model could not have called `offboarding.get_case` or
`onboarding.get_checklist`. The baseline's first read ("never reads `offboarding.get_case`") described a tool choice
error that did not happen. Refinement: one of the 16 slots goes to `comms.post_update`, which chat never sees, so a
routed read has a free slot without breaking the cap.

**RC3, grounding false positives (FM3). Holds: 10 of 10 refusals are false positives.** Of EX-02's nine unmatched
figures, seven ($75.00 twice, $1,000.00, $113.00, $50.00, 81, 60) appear verbatim in `res_0002`'s
`checks[].message` strings. The other two are a tokenizer bug found during this check: the draft wrote `$86.40:` and
`$54.20:`, both present as `amount_display` and `amount_cents` leaves, and the guard read them as `$86` and `$54`.
The repaired answer drops every limit and amount. CH-02's 47 is the sum of the six
counts in the same reply. CQ-03's dates are the clock and the clock plus 14 days. One claim from the open-coding pass
is refuted: CQ-03's model answer was not wrong for want of start dates. `start_date` is on every preview row, and
in `seed@v4` no worker starts between Oct 26 and Nov 9 (the latest start is 2026-10-19; Noor's `offr_0001` starts
2026-11-02 but its status is `sent`, not accepted). "No one appears to start in the next two weeks" was correct.
The guard rejected it at step 4 of 4, the loop had no repair left, and the receipt replaced it. FM7 remains a real
cost (3 wasted steps, and a 50-row page re-offloaded by `workspace.ts`), but CQ-03's first failed stage is
verification, not result use.

**RC4, the memory recall gate (FM4). Holds; one sub-claim is narrowed.** MM-01's first LLM input has no `<recall>`
block and the trace has no recall span; `store.recall` returns an empty block on a missing one-pager. MM-02's
`memory.search` sends the whole phrase as one `--fixed-strings` term and gets 0 hits. `runtime.ts` line 268 uses the
routine name as the routine recall query. Narrowed: the chat prompt does mention memory ("policies, decisions and
past notes" in the tools guide); what it lacks is a rule that sends a why or habit question there and asks for the
note id.

**RC5, clarification (FM5 and FM6). Holds.** `asksQuestion` requires a literal `?`, and both CP-05 replies name both
Jordans and ask for the missing facts without one. `ROLE_CHAT` has no clarification rule and does say "explain which
routine or screen does it", which is what both AM-02 replies did. AM-01 passes only because two Jordans show up in
a result.

Also refuted, from the baseline's first read: the `rt_agency_notice` run did not "make 0 model steps" and post to
#people-ops; it never started, and the post is the catch-up digest (FM10). The baseline's first-failure labels for
6 of the 9 dev failures are wrong (FM11); the matrix in section 1 uses the corrected stages.

## 4. Fix groups

Five groups with disjoint owned paths, for parallel fixers. A group edits only its owned paths; anything else is a
request to the owning group. No group edits `evals/suite/tasks/test/`, `evals/suite/reference/test/`, `.data`,
`apps/web/next-env.d.ts` or Phoenix data, or reads held-out traces. No dev literals go into prompts, tool
descriptions or prechecks (the anti-leak scan applies).

### FG1: Notice routine, routine prechecks and non-agent tracing

Owns: `packages/routines/` (src and test), `packages/contracts/src/wave4.ts`, `packages/agent/src/runtime.ts`,
`packages/agent/src/otel.ts`, `packages/agent/test/otel.test.ts`, `research/harness.md`.

1. `rt_agency_notice` routes every non-rate kind through `planNotice` instead of skipping (fold
   `rt_compliance_notices` in, so one routine answers `notice.received`); keep its tools at 8 or fewer, give each
   kind its own checklist, and keep every consequential write approval-gated as today (FM1).
2. One escalation command for notices: escalation plans call `notices.escalate` with derived `{notice_id,
   reason_code}`; the missing-filing checklist accepts the reply path or an escalation (FM1, MM-03).
3. Record the tool-list change as a harness 5.3 amendment line, keep GP16 passing, and flag to Nitish that the
   routine now acts, approval-gated, on the GP16 missing-filing notice.
4. A routine's recall query adds the precheck findings (for a notice: kind, agency, form, period) to the routine
   name (FM4, MM-03).
5. The people digest precheck counts employees with a status filter (FM10, RT-04).
6. Every routine run that ends without an agent run exports a span with its status and precheck reason; an empty
   run-start recall exports a RETRIEVER span with 0 documents and its reason; provider retries are tagged on LLM
   spans. All new attributes pass the vault redactor at the source, with the canary test extended (FM11).

### FG2: Grounding guard and loop repair

Owns: `packages/grounding/` (src and test), `packages/agent/src/loop.ts`, `packages/agent/test/loop.test.ts`.

1. Index numerals in untainted string leaves (check messages, proposal titles, summaries), not only `*_display`
   keys (3a).
2. Fix the `DIGITS` lookahead so a number followed by `:` keeps its fraction (`$86.40:` is 86.40), while a clock
   time such as `10:30` is still not read as two numbers (3e).
3. Pass the request text as a grounding source (3b).
4. Pass the run clock and accept dates inside windows derived from relative phrases (today, next week, next two
   weeks) and windows a date-filtered tool echoes (3c).
5. Accept a stated total equal to the sum of figures the answer lists from one result (3d).
6. Reserve one repair for a final answer at the last step; serve a post-repair identical re-read from the run
   instead of spending a step.
7. The grounded fallback leads with a readable answer and passes the same checker (summaries count as facts, or it
   drops their numerals).
8. One regression test per sub-code, plus a test that a value only in a tainted leaf is still refused.

### FG3: Read tool shapes and the chat tool surface

Owns: `packages/core/src/commands/people.ts`, `packages/core/src/commands/onboarding.ts`,
`packages/core/src/commands/offboarding.ts`, `packages/core/src/commands/payroll.ts`, `packages/core/test/`,
`packages/executor/src/builtins.ts`, `packages/executor/src/workspace.ts`,
`packages/executor/test/agent-artifacts.test.ts`, `packages/executor/test/builtins*.test.ts`,
`packages/contracts/src/wave3.ts`, `apps/api/src/agent/chat-allowlist.ts`, `apps/api/test/chat-allowlist*.test.ts`.

1. `people.get` (concise) carries the open onboarding checklist items or the offboarding case steps, each with its
   status, for workers in those statuses (FM2, OF-01, ON-02).
2. Optional second step: deterministic per-run routing, frozen at run start, that swaps in the benefits reconcile
   read, the integrations sync read or `time_off.team_calendar` when the request names that domain, using the slot
   `comms.post_update` holds today; read-only in the default variant; tests for the 16 cap and read-only mode (FM2,
   IN-02, BN-02, TO-01).
3. `people.search` gains `start_from` and `start_to` and echoes the window; a clamped limit is reported (FM7).
4. An `agent.read_artifact` page is never re-offloaded (cap the page to the inline budget), and every artifact
   payload keeps `total` consistent with `row_count` (FM7).
5. `actions.list`: a distinct name for the agent-run argument, or a refusal of a `pay_` id with a hint to
   `payroll.get_run`; clamp the limit; answer an unknown command filter with the nearest registered names (FM8).
6. `payroll.get_run` and `payroll.list_runs` return `approved_by` (a readable name) and `approved_at` for processed
   runs (FM8, CQ-06).

### FG4: Chat prompt and memory recall

Owns: `packages/agent/src/prompts/`, `packages/agent/test/prompts.test.ts`, `packages/executor/src/memory/`,
`packages/executor/test/memory*.test.ts`, `apps/api/src/memory/`, `apps/api/test/memory*`.

1. Clarification rule with a short generic example: when no single item or change follows from the request, or a
   name matches more than one record, read the options, then end with one direct question that names them (FM5).
2. Decision, reason and habit questions ("why do we", "who usually") search memory with one or two distinctive words
   and cite the note id or path (FM4).
3. The tools guide lists only the namespaces the run is offered (read from the frozen allowlist FG3 owns), so chat
   is never told about a read it lacks (FM2).
4. The routine role's agency-notice example also covers an escalation, not only a rate change (FM1).
5. Recall builds a block from subject dossiers and term hits when the one-pager is missing, and a decision note
   recalled as untrusted still shows its id and path so it can be cited (FM4).
6. `memory.search` tokenizes a multi-word query (phrase hits first, then all-terms lines, then any-term lines), and
   its description says so (FM4).
7. Bump the prompt version.

### FG5: Eval suite, dev split only

Owns: `evals/suite/graders/`, `evals/suite/judges/`, `evals/suite/tasks/dev/`, `evals/suite/reference/dev/`,
`evals/suite/worlds/`, `evals/suite/runner.ts`, `evals/suite/drivers.ts`, `evals/suite/evidence.ts`,
`evals/suite/phoenix.ts`, `evals/suite/report.ts`, `tests/evals-suite.test.ts`.

1. G4 accepts an explicit request for the missing facts, keeping the no-proposal and no-write checks (FM6).
2. G5 reports "fallback shown" as its own reason instead of re-grading the harness receipt, and detects the fallback
   whatever the repair count (FM3, FM11).
3. `firstFailure` labels a routine trial with no agent run "admission" and splits G5 into grounding (verification)
   and content (tool selection or result use, by whether any call reached the fact); routine run status and
   precheck reason go into trial detail and the Task span (FM11).
4. The notice tasks accept the planner's outcomes: an executed or proposed `notices.escalate`, a
   `notices.send_response` proposal, or (NT-02) a proposed `tax.set_deposit_schedule`; MM-03 keeps requiring the
   escalation and the citation (FM1).
5. Trial worlds mark past cron slots as done at the world clock; the duplicate-Jordan mutator sets `last_name`
   "Okafor"; re-pin the affected digests in a reviewed commit (FM10).
6. Tighten the 19 weak dev tasks to their references; ON-01 and RT-06 assert the post or an explicit skip reason;
   run declared judges or mark them pending in the report; add a solvability lint over dev references against each
   surface's allowlist; MM-02 gets a no-invention check; CQ-06 requires the approver once FG3 item 6 lands (FM9).

### Cross-group contracts

- FG1 and FG5 agree that notice escalation is `notices.escalate` and that NT-02 passes on a proposed
  `tax.set_deposit_schedule`.
- FG3 owns the frozen chat allowlist; FG4 renders the tools guide from it and adds no tool names of its own.
- FG2 changes the receipt; FG5 stops grading it as model text. Either can land first.
- FG5's tightened IN-02, BN-02, TO-01 and CQ-06 must be solvable with the tools FG3 offers (the solvability lint
  enforces it).

### Measurement after the fixes

Run the dev suite scripted first ($0), then live at k = 1 (about $0.06 at baseline cost), then k = 3 on the
prompt-dependent tasks (AM-02, MM-01, MM-03), each stage under its own cap and checked against
`~/Developer/projects/weft-notes/wave4-spend.json` before spending. Report the tightened-suite rate next to today's
46 of 55 so the drop from rank 9 is not read as a regression, and run the `chat_can_propose` variant again as a
separately labeled row.
