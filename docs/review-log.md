# Review log

## Review fix group notices-and-proposals (2026-10-18)

An independent review of the five-failure fix round found that the shared notices failure was misread, and that the equivalent-proposal check outlived a rollback. Branch rf/notices-and-proposals, from 5babb58.

| Finding | Fix | Test |
|---|---|---|
| A CA DE 2088 that states the rate already in effect produced "Update CA SUI rate 3.4% to 3.4%". This, not a duplicate, is the shared notices failure; it still failed on retired-r1 after the fixes (40 of 41) | The `rt_agency_notice` precheck compares each stated rate with the rate in effect on the effective date (through `tax.rate_change_impact`); when none differs the plan is acknowledge-only, so the run is skipped with the acknowledgment as its reason and nothing is proposed. `tax.update_rate` refuses `DOMAIN_NO_CHANGE` in preview and run, and `notices.acknowledge` accepts a rate notice that only confirms the rates in effect | Precheck unit tests; API tests in `apps/api/test/tax.test.ts`; dev task NT-10 (mutator `employerRateInEffect`), which fails on 5babb58 with two proposals and passes now |
| `findEquivalentProposal` refused an approved or executed match for 24 hours regardless of subject state, so after a person rolled back an approved change the agent was told "It is already done" | An executed match whose action has a reversing row (`reverses_seq`) is skipped. The subject hash alone cannot tell this: the execution changes the subject, and a rollback can restore it exactly (the executor fixture does) | Propose, approve, rollback, propose again, on the fixture command and on the real `tax.update_rate` through the routes |
| docs/evals/model-comparison.md and report.md said the notices class was duplicate proposals and the held-out check was pending | Both now state the five shared failures accurately (four fixed and confirmed on retired-r1; the notices one is the no-op rate change, fixed here on dev) and record the round 2 held-out confirmation: heldout2-t1 36 of 41, heldout2-t2 34 of 41, retired-after-fix5 40 of 41, fix5-dev 63 of 65 | |

Verification in the worktree: `pnpm test` 1374 passed and 6 skipped (216 files); typecheck 16 of 16; lint:prose and lint:brand ok; 148 tasks valid and 66 of 66 dev digests reproduce; brand:overlap ok; the anti-leak test passes. Scripted replay of the notice tasks (NT-01, NT-02, NT-05 to NT-10, RT-01, AI-31): all pass; MM-03 fails on the scripted provider before and after the change (the scripted model cannot follow a recalled procedure). Live on gpt-5.6-luna at default effort with `WEFT_BACKGROUND_LLM=1` (no Phoenix): NT-10, RT-01, NT-08, NT-09 and AI-31 pass 5 of 5 for $0.0048; NT-10 makes no model call.

Not changed: the precheck still skips a later copy of a letter whose first copy is already proposed or resolved, even after the first copy's rate change was rolled back. Making the copy check follow rollbacks is a follow-up. The allowlist stays at 8 tools, so the routine records the acknowledgment as its skip reason instead of calling `notices.acknowledge` itself.

## Fix groups merged: the five shared failures and the G8 price scale (2026-10-18)

Four fix branches (fix/routine-grounding, fix/duplicate-proposal, fix/read-figures, fix/injection-and-g8) merged into main from 4f26ff3, in that order. The one conflict was `evals/suite/worlds/index.ts`, where two branches added a notice mutator at the same place; both are kept (`agencyNoticeScenario` for NT-08 and NT-09, `noticeSendInjection` for AI-31; each task uses one, so the shared notice id ntc_9502 never meets itself). `packages/contracts/src/ext/fx-duplicate-proposal.ts` stays where it is, as docs/wave4.md section 7 rule 2 asks for additive contracts. The dev split now has 65 tasks (RT-21, NT-08, NT-09, EX-11, TO-11 and AI-31 are new); the held-out split is unchanged.

Verification from a scratch clone (ports 5400 to 5419): `pnpm test` 1347 passed and 6 skipped (214 files); typecheck 16 of 16; build ok; `pnpm e2e` 52 passed and 1 skipped; `pnpm demo` exit 0 through GP24 with the audit chain verified; lint:prose, lint:brand and brand:overlap ok; 106 tasks valid and 65 of 65 dev digests reproduce. The scripted dev gate over both variants passed with 54 of 75 trials passing the content graders, against 48 of 69 on 4f26ff3: the six new tasks pass and no existing task changed.

Live dev split on gpt-5.6-luna at default effort, WEFT_BACKGROUND_LLM=1, Phoenix experiment fix5-dev (RXhwZXJpbWVudDozMA==): 63 of 65 (96.9%) for $0.0888, with 0 unsafe actions, 0 taint misses, 0 canary hits, 0 grounding repairs and proposal precision and recall 1.00. All six new tasks passed. The two failures, AI-02 and EX-01, are both the expense review routine filing all 8 correct proposals with one tool call per step, so they reach 17 model steps against a G8 budget of 14. That is model variance, not the merge: rerun at k = 2 they pass 4 of 4 on the merged code (3 or 10 steps, experiment fix5-dev-expense-steps-merged-r3) and 4 of 4 on 4f26ff3 (experiment fix5-dev-expense-steps-main), and round 2 passed EX-01 with the same 16 calls in 11 steps.

Found while rerunning, not fixed: the eval runner keeps one spend ledger under `.data/eval-suite/world/spend` for every trial, and every trial's first run is `run_0001`, so the per-run cap (`WEFT_RUN_USD_CAP`, $0.10) sums that id across all earlier trials in the checkout. After the full dev run `run_0001` had $0.088 committed, one reservation short of the cap; the next live trials in that clone were cut off as "Stopped by the run spend cap" and graded as missing proposals. A longer run (k = 2, or dev plus held-out in one checkout) would lose its last trials the same way. Until the ledger keys runs per trial, run each live confirmation from a fresh eval data dir.

## Wave 4 fixer round after round 2 (2026-10-17)

Three review lenses (correctness, security and tracing, product honesty) ran against main at e83fd89. Each finding was
re-checked in the code or the committed results before it was fixed or set aside.

### Fixed

| Lens | Finding | Fix | Commit subject |
|---|---|---|---|
| Security | Phoenix's OTLP gRPC collector listened on every interface (Phoenix 20.23.0 hard-codes `[::]`) | Started through `scripts/phoenix-loopback.py`, which binds gRPC to 127.0.0.1; `up` checks with lsof and refuses a non-loopback bind; checked live on 5140 and 5141 | phoenix: gRPC collector bound to loopback, eval paths refuse a remote Phoenix |
| Security | The redactor had no provider key shape, so an unregistered `sk-` key reached spans | Shapes derived from `SECRET_PATTERNS`, `hasSecret` flags them, canary plants three unregistered keys | redaction: provider key shapes from SECRET_PATTERNS, redaction memory evicts oldest |
| Security | The redaction memory stopped learning at 2,000 tokens | Evicts the oldest token instead; test past the cap | same commit |
| Security | The eval Task span output and harness error text were not redacted | `traceRedact` over the task callback's record and the harness error | phoenix: gRPC collector bound to loopback, eval paths refuse a remote Phoenix; evals: strict grounding beside G5, ... |
| Security | `WEFT_PHOENIX_URL` and the OTLP capture target skipped the loopback check | Both go through `assertLocal` | phoenix: gRPC collector bound to loopback, eval paths refuse a remote Phoenix |
| Correctness | G5 grounding cannot fail on its own: it uses the guard's evidence | A strict check against tool results only is recorded per trial and reported with the count G5 still passed; round 2 report labels the 4 grader-only flips and the 4 strict flags | evals: strict grounding beside G5, model-only headline, G4 refuse claim check |
| Correctness | 8 of 59 dev trials called no model but fed the headline | Each trial records model, template or no run; steps, latency and cache hit count model trials only; the others get their own table; round 2 report and summary state the basis | same commit |
| Correctness | G4 refuse passed any non-empty reply | A refuse reply that claims the action was done, or shows a key, fails G4; the four recorded refusals pass | same commit |
| Correctness | The routine summary dropped proposals past 8 parts | Proposals first, "and N more" when cut, unit test | routines: run summary lists proposals first and says how many it cut |
| Correctness | Tool description examples held dev task ids (CT-01's answer) | Examples use ids no task asks about; a test scans every command description and parameter schema | tools: no dev task ids in description examples, scan descriptions for literals |
| Honesty | README and docs/wave4.md had no wave 4 eval results; the README said the round had not started | README Results subsection, wave4.md section 13, the section 12 defect list marked fixed or open | docs commit of this round |
| Honesty | Stale dev task count, two p90 figures, a wrong `generated_from`, the demo GP list in status.md, the missing `agencyNoticeKind` mutator, the Phoenix project name, the mislabeled pre-`4c7eb1c` traces | Each corrected in place | docs commit of this round |
| Product | An inbound simulator chat post showed the raw principal id | The post uses the person's display name | simulators: an inbound chat post shows the person's display name |

### Set aside, with the reason

| Lens | Finding | Why not now |
|---|---|---|
| Correctness | Option 1 for G5 (make the strict check the pass criterion) | Request and clock figures are legitimate grounding for the answers that use them; failing them would grade the person's own words as invention. The strict check is reported beside G5 instead (option 2), and the round 2 report no longer presents 0 G5 failures as independent |
| Correctness | Template steps still record scripted usage in the run store | The report no longer counts them; zeroing usage in the loop for the template provider touches the cost and cache accounting other tests pin, so it waits for a round that reruns the live suite |
| Correctness | EX-01 finalText mention of the proposal count | Changing a dev task's expectation changes its dataset hash; add it with the next live round |
| Correctness | agent-parity.md per-row status pass | A status note now says the rows are from the scaffold, gives the wave 3 gate count and lists what is still open; the per-row pass over 57 rows needs each row's test and golden path checked and is left |
| Correctness | Round 2 edited the frozen `packages/contracts/src/wave3.ts` (CHAT_ROUTE_SPARE, route slots, contractor_payouts, CarrierInvoicePeek) | Recorded here as the integrator's contract decision: the additions are additive, every caller is in-repo, and moving them to an ext file would only re-export them. Later additive needs go in `packages/contracts/src/ext/` per docs/wave4.md section 7 rule 2 |
| Security | G9 canaries sit where no task reads them | A reachable canary changes the data a task's read returns after the world digest, so the live model sees a different world; plant it with the next re-pin of the worlds |
| Security | Phoenix auth off and no Host check (DNS rebinding) | Accepted risk, written down in docs/telemetry.md: the data is synthetic and holds no secrets |
| Security | Span annotations for the mislabeled pre-`4c7eb1c` traces | Documented in docs/telemetry.md and the baseline report; writing annotations would change Nitish's persisted Phoenix, which this round does not touch |
| Product | The retired "Agency notice follow-up (folded)" routine shows in the gallery | Needs a retired flag on RoutineDef or a filter in the gallery and routine list queries, with its own e2e check; next product round |

## Wave 3 fixer round (2026-10-16, 16:20 to 17:10 PDT)

Four review lenses (correctness, security, product design, honesty and brand) ran against main at 6241cde. Each
finding was re-checked in the code before it was fixed or set aside.

### Fixed

| Lens | Finding | Fix | Commit subject |
|---|---|---|---|
| Correctness | The public webhook route sent the wrong args to `screening.apply_vendor_event` and `documents.apply_esign_event`, answered 200 anyway and deduped the retry, so every real Checkr, HireRight and DocuSign delivery was lost | The route uses the simulators' ingest path; a failed apply keeps its row with the error and frees the dedupe key; route test with the signed Checkr and DocuSign vectors | fix(integrations): apply real Checkr, HireRight and DocuSign webhooks |
| Security | The webhook body was buffered whole before the 1 MB cap when Content-Length was missing | Capped stream reader | (same commit) |
| Correctness | A sick request filed inside the waiting period for a date after the unlock was blocked with 0 available | `availableOn(balance, start, unlock)`; T10b | fix(time-off): a request after the waiting period counts the locked accrual |
| Correctness | Two pending duplicate claims each flagged the other, so both were proposed for decline | A pending twin counts only when submitted first | fix(expenses): between two pending twins only the later one is a duplicate |
| Correctness | A reimbursement released from an excluded paycheck skipped a draft that was already open | `expenses.mark_paid` reattaches released items to the earliest open draft (no dedicated scenario test yet) | fix(expenses): released reimbursements ride the next open draft; no self-approval |
| Security | Admins could approve their own expense; deciders their own time off | `DOMAIN_SELF_APPROVAL` in `expenses.decide` and `time_off.decide`, with API tests | (same commit) and fix(time-off): no self-approval; a manager reopens only a direct report's request |
| Security | `expenses.explain` was a laundering channel from tainted runs | A tainted run saves the template only. The explanation is not wrapped as untrusted: with this rule an agent explanation only ever comes from an untainted run | fix(expenses): released reimbursements ride the next open draft; no self-approval |
| Security | Any manager could reopen any team's request | `time_off.reopen` applies the decide reach | fix(time-off): no self-approval; a manager reopens only a direct report's request |
| Security | Greenhouse and Workday text reached the model unwrapped and candidate text landed in trusted offer columns | Untrusted fields on `ats.list_jobs`, `ats.get_hire` (job name), `integrations.list_sync_items` and `hris.get_worker_external`; imported names and titles must be plain name or title text of a few words, otherwise the hire waits as a sync item. A per-row source flag that taints later reads of imported names is not built | fix(security): wrap vendor text, plain imported names, ui_only adverse steps |
| Security | An API key could run the screening review and adverse steps through `POST /v1/tools` | They join `UI_ONLY_COMMANDS`; `apps/api/test/ui-only.test.ts` | (same commit) |
| Security | The redactor never learned the vendor credentials; a missing DocuSign key file put its path in a refusal | `compose.ts` adds every contract-named integration secret and the PEM contents; the refusal names only the variable | fix(security): the redactor learns the vendor credentials |
| Security | `GET /v1/sync-items` showed base pay to people without compensation access | The `canSeeComp` rule masks pay values | fix(integrations): cards that fit any width and say what is real |
| Design (blocking) | Integration cards broke at 1440 docked, 1280 and 1024: HireRight's title shrank to one letter and badges spilled out | Container-sized grid, wrapping header, plain Simulated badge with the HireRight note in its free path; GP17 e2e follows | (same commit) |
| Design | No action hierarchy on the cards; the secrets paragraph repeated five times; secret names truncated alike | Connection controls both secondary, a labeled Simulator group, full secret names, the paragraph once in the page notice | (same commit) |
| Honesty | The page and Workday card promised credentials make a card real; the Greenhouse free board is not wired; Test connection on Checkr and DocuSign tests nothing; Checkr copy said never production | Copy says what runs; Workday shows "Real adapter not built yet"; the test result reads "Status (not tested)" for adapters without a test; a real adapter held back by its live flags reads "Real, disabled"; the setup line names the DocuSign and Checkr live flags | (same commit) |
| Honesty | HireRight label inconsistent in the portal; "(sim)" hardcoded | Portal badge reuses the label; "(sim)" follows the card mode | (same commit) |
| Design | The Time Off calendar drew no approved leave (`bg-accent-4` is never generated) | blue-9 approved, dashed blue-3 pending | fix(time-off): calendar draws approved leave; rows read like the rest of the app |
| Design | Raw lowercase status, mono hours, "No checks fired", tooltip-only reason for a disabled Approve; Workday rows looked real | Sentence-case labels, tabular Inter, "All checks passed", a visible reason linked by aria-describedby, "Managed in Workday (simulated)" | (same commit) |
| Honesty | A local model showed as "Scripted, no model calls" | Local is recognised before the live check; the fixture uses live: false like the real provider | fix(web): a local model reads Local in the top bar; charts drop the accent |
| Design | Chat charts used the brand accent for a series | Accent removed from the palette | (same commit) |
| Honesty | README overstated the HireRight simulator and the free Greenhouse board; docs/wave3.md claimed expense manager routing; the open item about `expense_auto_cents` pointed at the wrong fix; status.md and .env.example were stale | Corrected; status entry and commented integration switches added | docs: wave 3 fixer round |

### Deferred, with the reason

| Lens | Finding | Why it waits |
|---|---|---|
| Design | No way to request time off in the UI (portal section is a stub; no admin action) | A new form with live minutes preview and projected balance is feature work beyond this round; the API (`POST /v1/time-off/requests`) works and is tested. Top of the open list in docs/wave3.md |
| Design | Expenses and People tables hide Amount and Status at common docked widths | Needs container queries and a stacked row layout for both tables plus layout spec updates; recorded in docs/wave3.md |
| Design | The agent panel does not follow streaming content | Needs a ResizeObserver stick-to-bottom with a "Jump to latest" pill and an e2e check; recorded |
| Design | Raw ISO dates in check messages and proposal summaries | One shared formatter across core messages touches planner hash inputs and eval expectations; needs its own pass with the lint-style test the finding proposes |
| Correctness | Unpaid leave never docks salaried pay (spec 6.4) | Payroll math change with its own hand-computed cases; recorded as an open item |
| Honesty | Real connection tests for Checkr and DocuSign | Needs adapter calls tested on a fake fetch; the card now labels the result "Status (not tested)" instead of claiming a test |
| Honesty | Reading a public Greenhouse board without the Harvest credentials | The copy now says what happens today; wiring `fetchBoardJobs` into `/v1/ats/jobs` is open |
| Design (minor) | The expense drawer's unlabeled decline reason and the Return note hint; the chat card's repeated worker id and "below" copy | Small UI follow-ups, recorded |

## Polish round: four polish branches merged (2026-10-15, 22:07 to 22:32 PDT)

`polish/reset`, `polish/brand`, `polish/times` and `polish/ui` were cut from main at 42e618f and merged in that order.
Two conflicts, both resolved by keeping both sides: `packages/executor/src/index.ts` (the `serialGit` export and the
time helpers) and `apps/web/src/components/app/inbox/proposal-card.tsx` (the proposer's note label with the note text
in Pacific time).

| Branch | Finding | Fix | Commit subject |
|---|---|---|---|
| polish/reset | `POST /v1/sim/reset` answered 500 under load: it dropped every table, then `rmSync` of `<dataDir>/companies` hit ENOTEMPTY from an in-flight memory `git` process, leaving no tables; concurrent resets and work started before a reset also corrupted the rebuilt world | Resets run one at a time on the scheduler's tick chain after agent runs and routine finalizations settle, remove the repos on the git queue first and seed under the write lock; a 500's stack goes to `<dataDir>/run/errors.log` under tests | fix(sim): settle background work and serialize POST /v1/sim/reset; fix(api): log a 500's stack to <dataDir>/run/errors.log under tests |
| polish/brand | `research/` and `SPEC.md` still shared runs of 8 to 23 words with the saved reference pages (14 hits) | Restated in Weft's own words; new `pnpm brand:overlap` fails on any 8-word run shared with the saved pages, with an empty allowlist that needs a reason per entry; in CI it skips | docs(research): restate the remaining reference-site copy in our own words; scripts: add pnpm brand:overlap, a shared-run check against the reference pages |
| polish/times | The one-pager printed the approve-by time as a raw UTC timestamp; dossiers, summaries, preferences and the Inbox, run view, agent panel and audit log showed raw ISO instants | Human-facing times read in Pacific time (`packages/executor/src/memory/time.ts`, `humanTimes()` in the web format module); stored text, keys and frontmatter stay ISO | fix(memory): human-facing times in memory files read in Pacific time; fix(web): inbox, run view and audit log show server times in Pacific time |
| polish/ui | The run view's Outcome column was cut off at 1440 px with the panel docked, and the paycheck table needed a 640 px minimum | Step titles wrap and optional columns step aside by card width; the 1440 and 390 px layout spec now checks the scroll wrapper too | fix(web): run Steps and paycheck columns stay in view at 1440 docked and 390 |
| polish/ui | The Inbox card called every note the agent's, even on Dana's own off-cycle proposal | The card reads who proposed (routine run, agent, or person) for the note label and a Proposed by field | fix(web): label Inbox notes and sources by who proposed the change |
| Integration | Run step numbers kept counting after a reset (#88 on a fresh run), found on polish/ui: the run store cached each run id's next step number and run ids restart at run_0001 | `createRun` drops the cached counter for its id; `packages/agent/test/store.test.ts` | fix(agent): a run's steps count from 1 after POST /v1/sim/reset reuses its id |
| Integration | With step numbers restarting, `pnpm e2e` failed GP3 and GP4 twice: the executor keeps each run's batch state in memory by run id and `step:<n>`, so GP4's digest (run_0001 again) inherited GP3's pending batch and its post became a proposal | The RunAuthority clears the batch state for every id it mints; `packages/executor/test/pipeline.test.ts` | fix(executor): a run minted with a reused id starts with a fresh batch |
| Integration | The two seed determinism tests timed out at 5 s under a load average of 14 to 28 on polish/brand and polish/times | 30 s timeout for those two tests | test: the two seed determinism tests get 30 s under machine load |

On a fresh scratch clone of the merged main (22:23 to 22:30 PDT, load average 4 to 11): install ok, `pnpm test` 624
of 624 (118 files), `pnpm typecheck` 15 of 15, build ok, `pnpm e2e` 31 of 31 twice (ports 4560, 4561 and 4564),
`pnpm demo` exit 0 (GP1 to GP12, audit chain verifies), `lint:prose --commits 42e618f..HEAD`, `lint:brand` and `brand:overlap`
against the main checkout's reference folder all ok. Before the executor fix, both e2e runs failed GP3 and GP4 the
same way. `pnpm screenshots` retook the run view, Inbox, audit, off-cycle, offboarding, memory and landing captures.

Still open, recorded in the README's left list: the chat approval card is always posted as the Weft agent; routine
trigger refs, hourly summary titles and server-side text stay ISO or UTC; `brand:overlap` covers only the 4 saved
reference pages; and git history still holds the earlier verbatim research lines, which only a history rewrite
removes (Nitish's call).

## Wave 2: final review of main at 5e30a37 (2026-10-15, 20:30 to 21:45 PDT)

Three lenses (correctness and security, harness, product and brand) reviewed main at 5e30a37. Every finding below was
checked against the code before it was fixed or set aside; each fix landed on main with a test where one applies.

Gate after the fixes, on a fresh clone of main at c716c93 (21:04 to 21:07 PDT): install ok, `pnpm test` 596 of 596,
typecheck 15 of 15, build ok, `pnpm demo` exit 0 (GP1 to GP12, audit chain verifies), `pnpm e2e` 30 of 30,
`lint:prose --commits` and `lint:brand` ok. No live model calls were made in this round.

### Fixed

| Lens | Finding | Commit subject |
|---|---|---|
| Correctness (blocking) | Off-cycle missed_payroll or correction paid a period a processed regular run already paid; GP10 paid wrk_0042's Oct 1 to 15 twice; the run dropped benefit deductions | fix(payroll): off-cycle pay never pays a period a regular run already paid |
| Harness (blocking) | Recall at run start tainted the prebuilt routines once a digest had run and any decision note existed, so the weekly digest became a proposal | fix(memory): recall never taints a routine run |
| Product (blocking) | Offer builder fields lost focus after the first keystroke (label component declared inside the form) | fix(web): offer builder fields keep focus while typing; Void asks before it ends the offer |
| Correctness | `onboarding.complete_task` let an agent mark the hire's own portal tasks done, locking the hire out of the form | fix(onboarding): complete_task refuses the new hire's own portal tasks |
| Correctness | A skipped, refused or expired final pay stranded group, app, COBRA and benefits steps, so access was never revoked | fix(offboarding): a skipped final pay no longer strands access removal |
| Security | `it.create_account` (autoAllow untainted) provisioned a leaver again after offboarding | fix(it): a leaver gets no new account or device |
| Security | The redactor knew only the whole direct-deposit JSON blob, not the bare account number | fix(executor): the redactor learns a bare account number from the direct-deposit vault value |
| Security | Signed documents and signatures could be edited and still verified | fix(executor): signed documents are append-only and verify checks them |
| Correctness | The state certificate's extra withholding was signed but never withheld; the exempt flag likewise | fix(payroll): the state certificate's extra withholding reaches payroll; exempt is refused |
| Correctness | A payout proposal for contractor B superseded a pending one for contractor A on the same date | fix(contractors): a payout proposal for one contractor no longer supersedes another's |
| Harness | Untrusted `preferred_name` went into untainted dossier aliases | fix(memory): person dossiers take aliases from the legal name only |
| Harness | No Claude run could pass admission (Luna-sized cap, reservation at 8,000 tokens while 16,000 are sent); cache writes priced at 1x | fix(agent): a Claude run fits its budget; spend reserves the real max_tokens and prices cache writes |
| Harness | Runs still queued at shutdown stayed queued forever after a restart; close() left provider calls running | fix(agent): runs still queued at shutdown fail visibly at the next boot; drain aborts past its bound |
| Harness | The loop's step timer read as a non-retryable cancel and cut the local 180 s step to 120 s | fix(agent): the loop's step timer reports a retryable timeout, and a local model gets its 180 s step |
| Harness | A tool-call preamble at chat's answer-by step was returned as the answer; harness.md did not record the 4-step cap and 13 chat tools | fix(agent): a tool-call preamble at chat's answer-by step is never the answer |
| Correctness, minor | Claude cache writes billed at the input rate | fix(agent): a Claude run fits its budget; spend reserves the real max_tokens and prices cache writes |
| Product | Final pay and off-cycle runs looked like the regular run; "1 paychecks" | fix(web): final pay and off-cycle runs read as such in the Payroll list and on Home |
| Product | Raw lowercase enum badges on offboarding, reconciliation, open enrollment and People offers | fix(web): wave 2 badges show words, not raw enum values |
| Product | UTC timestamps and ISO dates on wave 2 screens | fix(web): wave 2 screens use the shared Pacific Time date formats |
| Product | Wave 2 tables hid their key columns at 390 px | fix(web): reconciliation, offboarding steps and payouts fit a 390 px phone |
| Product | Void fired on one click | fix(web): offer builder fields keep focus while typing; Void asks before it ends the offer |
| Product | The direct deposit error read "routing: routing number fails the ABA checksum" | fix(web): the direct deposit error reads as a sentence, not a field path |
| Product | Open enrollment reminder named every non-elector in #general | fix(benefits): open enrollment reminders never name people in #general |
| Product | Offboarding copy used real product names without (sim) and showed internal ids | fix(offboarding): step details name the simulated systems with (sim) and drop internal ids |
| Product, minor | Reconciliation copy used tier codes and ids; off-cycle notes showed unformatted money | fix(benefits): reconciliation copy uses words, not tier codes and ids; fix(payroll): off-cycle pay never pays a period a regular run already paid |
| Product, minor | Hash prefix squeezed document titles at 390 px | fix(web): document titles get the room on a phone; the hash prefix shows from tablet width |
| Product, minor | Disabled Run remaining steps explained only by a tooltip | fix(offboarding): a skipped final pay no longer strands access removal (visible hint line) |
| Product, minor | README claims (screenshot caption, Viewing as list, offer builder gaps); stale saved note with an offer id; unstyled I-9 file input; People Offers badge | docs: README claims match the app; small portal and People polish |
| Correctness | A cli or admin API key ran R4 money movers (off-cycle, final pay, contractor payouts) with no proposal | fix(executor): a cli or admin API key's money movers become proposals |
| Harness | The template fallback skipped local providers, so a routine failed outright with the local server down | fix(agent): a routine on a local model whose server is down finishes on the templates |
| Harness, minor | The Claude provider dispatched and replayed the declined partial's blocks after a mid-stream fallback | fix(agent): the Claude provider follows the bundled fallback echo rules |
| Product, minor | Off-cycle diff labels lacked the (demo) suffix | fix(payroll): off-cycle proposal lines name the worker with the (demo) suffix |
| Product, minor | The admin checklist listed the confidentiality agreement before the offer | fix(web): the admin onboarding checklist follows the portal's task order |
| Product, minor | Hiring showed the offer status as blue text beside the buttons | fix(web): Hiring shows an offer's status as a badge, not blue text beside the buttons |
| Product, minor | The Proposal and action links from the case view landed on the page, not the item | fix(web): case view links land on the proposal card and the audit row |

### Set aside, with the reason

| Lens | Finding | Why not now |
|---|---|---|
| Correctness | A person's UI session POST /v1/tools call executes R4 money movers directly | Rejected for UI sessions: SPEC 10 has a person's own call execute (the Submit button on a payroll run relies on it), and the UI's off-cycle and offboarding routes already propose. The API-key half is fixed above, and the descriptions now say an agent's call needs approval and a person's runs it |
| Harness, minor | The 16,000-token incomplete retry is a no-op under the local 768-token cap and identical on Claude's 16,000 floor | Deferred: bounded by the two-incomplete rule (MODEL_INCOMPLETE); skipping the retry when `outputTokensFor` gives the same cap is the next step |
| Harness, minor | The Claude provider caches only the system block and prices fallback turns at Opus 5.5 rates | Deferred: no Anthropic key here to confirm cache hits; the fallback echo rules are fixed above |
| Harness, minor | `code.run` holds the write lock and a transaction for the whole script | Deferred: the sandbox is opt-in (`WEFT_SANDBOX=quickjs`) and on no prebuilt allowlist; the worker-thread move is in the README's left list |
| Harness, minor | Recall lines lack the nonce-tagged untrusted wrapper, sit outside the pack budget, and every hit carries HEAD's date | Deferred: routine runs now recall trusted text only, so the wrapper matters only for read-only chat; budget accounting and per-file dates need a recall rewrite |
| Harness, minor | rt_memory_digest writes from inside a precheck through a global hook | Deferred: needs a `memory.digest` executor command on a svc_digest allowlist; the routine ships disabled |
| Product, minor | No way back to admin from the portal | Deferred: the portal persona is a separate principal, so a back link needs the Viewing as switch inside the portal |
| Product, minor | Offer builder lacks Manager and Workplace; People Offers and Hiring render offers differently | Deferred and recorded in the README's left list; the People badge now says how many are to act on and Hiring uses a badge |
| Product, minor | The direct deposit error is not attached to its input with aria-invalid | Deferred: the form needs to take the error state; the error copy itself is fixed |
| Security | Document library shows verified from its own state, not the new signature pass | Deferred: verify now fails on a tampered signature and the database refuses edits; surfacing the pass per document is a UI follow-up |

## Wave 2: integration review (2026-10-15, 19:35 to 20:00 PDT)

Found while merging the six wave 2 tracks and wiring their contract requests; each fixed on main with a test.

| Finding | Fix | Commit subject |
|---|---|---|
| After the portal turned a hire active, the agent finishing its own tasks emitted `worker.onboarding_completed` a second time | `onboarding.complete_task` emits it only when no earlier one exists for the worker | fix(onboarding): the agent's later tasks do not emit worker.onboarding_completed a second time after the portal did |
| `payroll.get_run` with `response_format: "detailed"` offloaded to an artifact whose first page read "rows 1 to 0 of 0" (live L2 hit it) | An offloaded result pages its longest array field, not its first (`excluded_worker_ids` is often empty) | fix(executor): an offloaded result pages its longest array, so payroll.get_run detailed no longer reads as 0 rows |
| Contractor payouts only moved along the rail when someone read `GET /v1/contractors/payouts` | The scheduler tick syncs the rail after `sims.tick` | integrate: the scheduler tick drives the payment rail, so payouts move sent to delivered without a read |
| Sent offers never expired unless the hire opened the portal or someone ran the sweep | `svc_scheduler` runs `documents.expire_offers` when one is due | integrate: offers expire on the sim clock (svc_scheduler runs documents.expire_offers only when one is due) |
| Claude runs were priced with the Luna table, about 20 times too low | Prices per provider | integrate: prices per provider (Claude Opus 5.5 at $4, $0.20 and $20 per million) and compact tool descriptions for the local providers |
| `POST /v1/sim/reset` left stored run handles behind while run ids restart | The reset clears `<dataDir>/run/handles` | integrate: POST /v1/sim/reset clears stored run handles, since run ids restart |
| `e2e/site-dev-runner.spec.ts` "Ctrl+C stops every process group" failed once on a fresh clone: the processes were gone but "dev: stopped" was still in the pipe | The spec waits for the runner's `close` event (bounded at 5 s) before reading the output | fix(e2e): the dev runner spec waits for the runner's output to drain before reading "dev: stopped" |
| Cross-track: offboarding ends benefits at the end of the month, but reconciliation expected a leaver's coverage only through the last full pay period, so every GP9 leaver became a `terminated_but_billed` finding | Reconciliation honors an explicit `effective_to` on the enrollment; the end-date rule still applies to enrollments never ended (the planted Owen Mercer error) | fix(benefits): reconciliation honors an enrollment ended by offboarding, so a leaver billed through the end of the month is not a finding |
| Cross-track: open enrollment rows are seeded once, so a GP9 leaver stayed on the 2027 list and the chase routine would remind them in #general | The list keeps only active or onboarding workers with no end date | fix(benefits): a leaver drops out of the open enrollment list, so the chase routine never reminds them |
| Checked and fine: the new-hire persona's `PORTAL_ONLY` confinement holds against `..`, `%2e%2e` and mixed-case encodings of a path outside `/v1/portal/` | No change | |

## Wave 2: gate report fixes (track w2-reliability, 2026-10-15, 18:50 to 19:15 PDT)

Each item of the wave 1 gate report, fixed on `track/w2-reliability` with a test. Notes in `docs/tracks/w2-reliability.md`.

| Gate report item | Fix | Commit subject |
|---|---|---|
| `weft.close()` did not drain in-flight routine finalization; CLIENT_CLOSED went unhandled | Tracked finalizations and bounded drains in the routines engine and the agent queue, awaited by `close()` before the database closes; background reads and writes are caught | fix(api): weft.close() drains in-flight runs and routine finalizations before the database closes |
| A waiting routine run lost its trigger and handle across an API restart | Trigger in the context step; handles in a 0600 file per open run under the data dir, never in run_steps; waiting runs rehydrated at boot; the routines engine watches again on the first decision | fix(agent): a waiting routine run keeps its trigger and handle across an API restart |
| Live L3 flaky (a write on a read-only question; 5 and 8 steps) | Chat is not offered `comms__post_update`; chat answers by its fourth model step; the chat role asks for concise reads and folds a retry into the next batch; the eval logs every tool call and new action row. Live L3 6 of 6 twice for $0.010 | fix(agent): chat stays read-only and answers by its fourth model step; fix(agent): chat reads concise results and leaves unasked filters null; feat(evals): live cases log every tool call and every new action row |
| Run Steps and paycheck tables clipped at 1440 px with the agent panel docked | Container queries hide the columns the drawer or metrics repeat below the card width; tables scroll inside their card below that | fix(web): the paycheck table reflows inside its card; fix(web): the run view says (live) only for a live model; Steps reflow beside the docked panel |
| Headcount tile counted 51 people including contractors | Active employees, onboarding shown apart, matching `/v1/stats` | fix(web): the Headcount tile counts active employees and shows onboarding apart |
| The run view said (live) on scripted runs | Scripted, no model and Template, no model; (live) only for a real model; the feed mode reads streaming | fix(web): the run view says (live) only for a live model |
| Grounding treated short strings with spaces as identifiers | `isIdentifier()` admits spaced strings only as short capitals-and-digits codes; whole-token cuts | fix(grounding): short strings with spaces are not identifiers |
| research/product.md and research/agent.md quoted reference marketing lines | Paraphrased with source keys kept; no denylist phrase left | docs(research): paraphrase the quoted reference marketing lines |
| Found on the branch by e2e GP4: a reset world never finalized routine runs | The routines engine keys its watches by routine run and agent run, since agent run ids restart after a reset | fix(routines): watch each routine run and agent run pair |

Round 2 review of main at e8bd7b8 (correctness, security, harness, product design and brand honesty lenses), fixed
on 2026-10-15 between 17:58 and 18:30 PDT. Each finding was checked against the code before it was fixed or set aside.

## Fixed

| Lens | Finding | Commit subject |
|---|---|---|
| Design (blocking) | cn() dropped type scale sizes next to text colors | fix(ui): register the text-0 to text-12 type scale with tailwind-merge |
| Security, correctness | routines.enable and routines.disable always failed (events missing from the union) | fix(routines): add routine.enabled and routine.disabled events |
| Security, harness | the per-run tool allowlist was never enforced | fix(executor): freeze the run allowlist on exec_runs and refuse anything else |
| Correctness | proposal expiry never woke or finalized the proposing runs | fix(executor): proposal expiry wakes the proposing run and finalizes its routine run |
| Correctness | submit_run paid a stale draft after an approved rate change | fix(payroll): a rate change or revert recomputes open drafts in the same transaction |
| Security | DNS rebinding through the web proxy; MCP keys could trigger routines and cancel runs; API keys could run ui-only commands through /v1/tools | fix(auth): close the DNS-rebinding path through the web proxy |
| Security, harness | the redactor never learned a key loaded from WEFT_SECRETS_FILE | fix(api): the redactor learns provider keys loaded from WEFT_SECRETS_FILE |
| Correctness, design | next-env.d.ts dirtied the tree; a second next dev failed late; the Next dev badge covered Settings | chore(dev): refuse a second next dev in the checkout, restore next-env.d.ts on stop, hide the Next dev badge |
| Correctness | golden path scenarios skipped themselves on a stub | test: golden path scenarios fail on a stubbed part instead of skipping |
| Harness | two nonces per run; chat answers could ground themselves on comms.post_update | fix(agent): one nonce per run and no self-grounding through the run feed |
| Brand | taint overclaim, "four states", "0.1", live spend "in total", stale status sections, lint:brand and NOTICE scope | docs: honest landing and README copy; mark the stale status sections historical |
| Design | GP1 next-run diff row read $0.00 to a negative number; ISO date in the title | fix(tax): the GP1 next-run diff row shows employer SUI before and after |
| Design | repeated "Content to be sent" label, repeated evidence refs, raw rule ids in the flag popover, home widgets padded to 180px, lowercase badges | fix(web): drop repeated labels and raw rule ids from proposal cards and flag popovers |
| Correctness | routine decisions lived only in memory, so a restart re-listed decided proposals | fix(routines): read proposal decisions through the ReadOnlyExecutor |
| Correctness | addBusinessDays shifted the wall time across the DST change | fix(sim): addBusinessDays steps PT calendar dates |
| Harness | routine run summaries were the model's prose | fix(agent): routine run summaries come from results and proposals, never the model's prose (no separate agent note yet) |
| Design | all Deliver buttons disabled while polling; no word when no routine picks a notice up | fix(web): Deliver disables only the clicked notice row (the staged run feed reveal is still to do) |
| Design | audit Summary squeezed; header search hidden at 1440 with the panel docked | fix(web): audit Summary column gets room; header search shows from a 720px header (routine names for run ids still to do) |
| Design | the payroll page did not show the agent's pending submit proposal | fix(web): the payroll page shows a pending submit_run proposal and makes the human Submit secondary |
| Correctness, harness | SPEC 12 L4 row did not match the relaxed live criterion | SPEC 12 L4 row now states the L4a criterion and names L4b as left (this commit) |

Notes on the allowlist fix: a chat handle opened without an `allowlist` (only executor and scenario tests do this)
is unrestricted; every route in apps/api passes CHAT_TOOLS or DRAFT_TOOLS, and routine runs always freeze the
routine's own tools from its row. The ui-only check covers routines.enable, routines.disable and the two rollback
commands; other human_only commands (people.accept_offer, people.update_profile, sim.deliver_notice) stay open to
admin and cli keys on purpose, because their routes accept API keys.

## Set aside, with the reason

| Lens | Finding | Why not now |
|---|---|---|
| Harness | waiting routine runs lose their trigger and handle on restart (runtime.ts in-memory triggers, handles) | Fixed in wave 2 (w2-reliability, see above). Was: needs the trigger stored in the context step and a DB-backed wake path in the runtime; larger than this round's budget. The routines half (decisions from memory) is fixed. Next step: read the trigger from the context step's RunSetup and pending proposals through actions.get_run |
| Harness | no Active Memory recall at task start, no dossier refresh, no timeline coarsening | A P1 feature (harness 9.5, 7.2), not a defect fix; it needs its own track |
| Harness | live L4 cannot fail on injection behavior | L4b costs a live call; the SPEC row now says so plainly. Add the forced-read chat case in the next live round under the $0.50 cap |
| Harness | grounding check treats short strings with spaces as identifiers | Fixed in wave 2 (w2-reliability). Was: the rule exists for identifiers like "DE 2088" that carry a space; tightening it needs a corpus check. The self-grounding path it enabled (post_update echo) is closed |
| Harness | spend ledger per-run cap keyed by reused run ids | Only bites after many live reruns on the same data dir; the loop already enforces the per-run budget. Key by a unique run key in the next live round |
| Harness | sandbox gate missing | No code.run exists yet; add the SANDBOX_NOT_ALLOWED policy branch with code.run |
| Harness | no cross-run prefix pin test | Worth adding with WEFT_PIN_PREFIX=1; not a defect today |
| Design | paycheck table too wide with the agent panel docked; audit Actor shows a run id, not the routine name; no row flash after a review | The paycheck table is fixed in wave 2 (w2-reliability); the rest stands. Layout work that needs screenshots across breakpoints; the cn() fix already restores the 11px chips and 14px table text that caused much of the width |
| Design | simulators: no staged run feed reveal when a run finishes before first paint; approve gives no result strip | Interaction work across three components; next design round |
| Design | landing: no mobile menu, missing agent showcase and run log sections, hero mock reflows at 390, dark island density, stat tile spacing | New sections and responsive work; next design round. The heading line height and the API path in the Numbers heading are fixed |
| Design | Bank batches raw headers, empty states without a next step, humanized enums and run id crumbs everywhere | Small but spread over many files; next design round |
| Brand | research/ quotes reference marketing lines verbatim and they are in git history | The working files are paraphrased (w2-reliability, then polish/brand) and pass `pnpm brand:overlap`, which fails on any 8-word run shared with the saved reference pages. The history still holds the old lines. The repo is local only and never pushed. Before any publish, rewrite history |
