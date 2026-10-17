# Wave 4 plan

Wave 3 passed its gate on 2026-10-16 (fresh clone: 889 tests, typecheck, build, 44 e2e specs, `pnpm demo` with the
golden paths, live L1 to L10 on gpt-5.6-luna). Wave 4 has one goal from Nitish, in three parts:

1. Finish the rest of the agent's parity capabilities.
2. Test how well the agent does and find exactly what goes wrong, with every run traced into a local Arize Phoenix.
3. Improve the harness so the agent shines. The harness, not the model, carries quality: the model stays the cheap
   `gpt-5.6-luna` through the Responses API.

Two decisions are still pending with Nitish and stay **off by default** all wave: `agent.chat_can_propose` (chat
filing proposals, a relaxation of harness 5.3) and auto autonomy (`agent.allow_auto_autonomy`). Nothing in this plan
turns either on by default. The eval program runs an explicitly labeled `chat_can_propose` variant to measure what it
would change, and reports it in its own tables.

Research behind this plan (committed with this doc; read it before building): `research/wave4/phoenix.md` (tracing,
binding for the telemetry design) and `research/wave4/evals.md` (the eval program, binding for the suite), plus
`research/wave3/agent-parity.md` (the 57 capability inventory) and `research/harness.md` (binding for the agent,
executor, approvals, memory, routines, sandbox and MCP).

Finishing beats starting. Every track lands working, tested slices, keeps every existing test, e2e spec and the demo
green, and records what is left in `docs/tracks/<track-id>.md` and `.scratch/<track-id>/left.md`.

## 1. Parity work to finish

At the wave 3 gate the 57 capabilities stood at 31 done, 19 partial and 7 missing. The 7 missing are recurring filings
and the compliance calendar (T2), notice upload (T4), life-event windows (T6), employee self-service questions (T9),
required training (T11), tagging the agent in chat (Q6) and email expense submission (S5). The table ranks everything
this wave closes by demo value first. "Parity" is the row id in `research/wave3/agent-parity.md`.

| Rank | Parity | Gap closed in wave 4 | Track |
|---|---|---|---|
| 1 | T2, S2 | Recurring filings (941, 940, W-2 and W-3, 1099-NEC, the CA DE 9 and DE 9C, NY NYS-45, TX C-3, CO UITR-1) prepared from processed payroll, filed as R4 proposals, and a compliance calendar screen with due-soon reminders posted to chat | w4-parity-compliance |
| 2 | R12, T3, T4, G11 | Notice upload (a person uploads a mailed notice; its text is untrusted), every seeded notice kind handled by `NOTICE_HANDLING` (missing filing attaches the filing, deposit schedule change updates the account, penalty proposes payment or abatement), and anything unknown or low confidence handed to a tax specialist as a hand-off case with an evidence pack | w4-parity-compliance |
| 3 | T6, T5, R9 | Life-event windows (marriage, birth, move and the rest open a special enrollment window), reminders tied to each window, elections filed with the simulated carrier and 401(k) provider with a receipt, and open enrollment with a real open and close | w4-parity-people |
| 4 | T9 | Employee self-service questions in the portal: the agent sees only the asker's own pay, time off, benefits and policy; medical leave, accommodation and workplace concerns go to a person | w4-parity-agent |
| 5 | T11 | Required training (CA, NY and IL harassment prevention, with sources): assign on hire and on schedule, remind, store completion and certificate, overdue rows on the calendar | w4-parity-compliance |
| 6 | Q6 | Tagging the agent in a chat thread or channel: the mention starts a read-only, tainted run that reads the thread and answers in it | w4-parity-agent |
| 7 | S5 | Email expense submission: an email with a receipt from a worker's address on file becomes a submitted expense, then the normal review routine | w4-parity-agent |
| 8 | R6 | The "out this week" line in the Monday people digest, from the time-off ledger | w4-parity-people |
| 9 | R15 | The 30-day check-in form in the portal (fixed questions in `CHECKIN_QUESTIONS`) and the manager's summary of direct reports | w4-parity-people |
| 10 | Q3, R7, R16 | A Reports screen: the metric catalog, a chart and table per metric, date range and grouping, and "email this report" as a proposal; the weekly cost by state routine (ships disabled) | w4-parity-admin |
| 11 | G1, G2 | A permissions screen: the View, Edit and Approve matrix per person and for the agent, plus per-action narrowing (`deny` or `propose_only`) enforced in the executor scope; changes are proposals | w4-parity-admin |
| 12 | G6, R14 | Wait-and-resume routine steps: a checklist item declares a wait (event, time or decision), the run parks in `waiting_event`, the engine resumes it, follows up on a schedule and expires it; the laptop hand-delivery routine is the worked example | w4-parity-agent |
| 13 | R1, T12 | A first-day message to the hire and the team on the start date (R3 email, autoAllow untainted like the check-in emails) | w4-parity-people |
| 14 | G10, G7, G8 | The routine gallery with created by, enabled at, last and next run, and approval and override counts beside the autonomy control | w4-parity-admin |
| 15 | R2 | The Ready Check reads the holiday calendar when counting three business days | w4-parity-people |
| 16 | portal | The portal Request time off form left open by wave 3 | w4-parity-people |

If a builder finishes early: per-role context defaults in chat (Q8), a CLI over the REST API (S4), more routine
drafting templates (R13), and learning thresholds from overrides (G8 beyond counts). Deferred past wave 4 is in
section 10.

Decisions the architect made where the research left a choice:

- **The portal agent never proposes.** It runs the chat loop with `PORTAL_TOOLS` (self-scope reads that resolve the
  worker from the principal and take no worker id). Code, never the model, classifies a human-only topic
  (`PORTAL_HUMAN_ONLY_TOPICS`) and opens a hand-off as the employee's own request; the agent then says a person will
  follow up. This needs no harness 5.3 relaxation.
- **A mention run is tainted from the start.** The thread is untrusted text, so the run is read only by the existing
  taint rules and answers with `comms.post_update` in the thread.
- **Email intake is a system command.** `expenses.intake_email` (system only) accepts mail only from a worker's address
  on file, stores the attachment as an upload and creates a `submitted` expense with `source = 'email'`; the employee's
  words stay untrusted and taint the review run, as in wave 3.
- **Filing a return is R4 and always a proposal.** Preparing is R1; a filed return is not reversible.
- **Hand-offs are one table for three kinds** (tax specialist, HR person, vendor specialist) with a reason code, so
  T3, T9 and G11 share one Inbox section.
- **Waits live in the routines engine, not the agent loop.** A resumed run starts a new agent run segment from the
  checklist, so the loop and its telemetry stay untouched by the parity work.

## 2. Tracks

Seven tracks run in parallel in separate git worktrees (`git worktree add ../weft-<track> -b track/<track>`), each
with disjoint owned paths. The telemetry track owns every instrumentation point in the agent loop and the executor;
no parity track edits those files. If a track needs a change outside its paths, it writes it to
`.scratch/contract-requests/<track-id>.md` and works around it; the integrator folds it in.

| Track | Owns | Web port | API port |
|---|---|---|---|
| w4-parity-compliance | filings, compliance calendar, notices beyond rate change, notice upload, hand-offs, training | 4820 | 4821 |
| w4-parity-people | life events, windows, carriers, open enrollment, check-in form, digest line, first-day message, portal time-off form | 4830 | 4831 |
| w4-parity-agent | portal questions, mentions, email intake, wait and resume | 4840 | 4841 |
| w4-parity-admin | Reports screen, permissions screen and per-action narrowing, routine gallery | 4850 | 4851 |
| w4-telemetry | OpenTelemetry and OpenInference spans, the Phoenix exporter, redaction at the source, Phoenix scripts | 4860 | 4861 |
| w4-eval-suite | runner, graders G1 to G10, worlds and mutators, the 59 dev tasks, Phoenix experiments, results and report | 4870 | 4871 |
| w4-eval-heldout | the 41 held-out test tasks, judges J1 to J4 and their validation tooling, the anti-leak scan | 4880 | 4881 |

The full owned path lists, acceptance and cut lines are in section 8. The improvement work (fixing by category) is not
a parallel track: it needs the baseline and Nitish's open coding first, so it is round 2 (section 9).

## 3. Telemetry design (Phoenix and OpenInference)

This follows `research/wave4/phoenix.md` exactly; where this section is shorter, that file governs.

**Server.** Phoenix `20.23.0` (fallback pin `20.22.0`, never `latest` or `nightly`), run locally only, never a hosted
account. `pnpm phoenix:up` runs `uvx --python 3.13 --from arize-phoenix==20.23.0 phoenix serve` in its own process
group with `PHOENIX_HOST=127.0.0.1`, `PHOENIX_PORT=6206`, `PHOENIX_GRPC_PORT=6207`, `PHOENIX_TELEMETRY_ENABLED=false`,
`PHOENIX_ALLOW_EXTERNAL_RESOURCES=false` and `PHOENIX_WORKING_DIR=~/Developer/projects/weft-notes/phoenix` (SQLite
`phoenix.db`, outside the repo, never committed). The server gets a minimal environment, so no key from the shell
reaches it. `up` reuses a running instance of the pinned version; `pnpm phoenix:down` stops only the process group it
started and waits for both ports to close; `pnpm phoenix:status` prints the URL. Weft exports only over OTLP HTTP
(`http://127.0.0.1:6206/v1/traces`); the gRPC collector binds every interface whatever `PHOENIX_HOST` says, so Weft
never sends to it. Ports and the pin are in `PHOENIX` (`packages/contracts/src/telemetry.ts`) and can be overridden
with `WEFT_PHOENIX_PORT`, `WEFT_PHOENIX_GRPC_PORT` and `WEFT_PHOENIX_DIR`.

Only one process writes `weft-notes/phoenix`: the eval runs of the w4-eval-suite track and round 2. Every other
builder that wants a Phoenix for a smoke test starts a private one on its own ports with
`WEFT_PHOENIX_DIR=.scratch/<track>/phoenix`, and stops it. Whoever starts a Phoenix stops it, unless Nitish asks for it
to stay up; he browses the persisted traces any time with `pnpm phoenix:up`.

**Switch.** `WEFT_TRACE=phoenix` turns tracing on in `apps/api` and the eval runner (`TRACE_ENV`). Unset, the OTel API
returns a no-op tracer, so tests and ordinary runs pay nothing and send nothing.

**Packages.** The brain (`packages/agent`) depends only on `@opentelemetry/api@1.9.1`,
`@arizeai/openinference-semantic-conventions@2.14.0` and `@arizeai/openinference-core@2.8.0`. The composition root
(`apps/api/src/telemetry.ts`) uses `@arizeai/phoenix-otel@2.2.0` to register the provider; tests use
`@opentelemetry/sdk-trace-base@2.12.0` with an in-memory exporter. The OpenAI auto-instrumentation is not used: it
records the raw request before Weft redacts it and does not serialize Responses API tools.

**Span tree.** One trace per run:

| Span | Kind | Built from |
|---|---|---|
| `agent.run` | AGENT | the run row: input (task or chat turn), output (terminal summary), `weft.run_id` |
| `admission`, `assemble`, `model`, `dispatch`, `post`, `terminal` | CHAIN | one per `run_steps` stage row, with `weft.step_n` and `weft.attempt` |
| `memory.recall` | RETRIEVER | recall hits (path as id, snippet, score, tainted flag) |
| `llm.responses` | LLM | Weft's own redacted request snapshot and `RawUsage`: messages, tools, invocation parameters (never the key or headers), prompt, cached, cache write, completion and reasoning tokens, `llm.cost.*` from `cost.ts`, `weft.request_id`, `weft.prefix_hash` |
| one per tool call | TOOL | tool name, call id, redacted arguments and outcome JSON, `weft.outcome` (`ok`, `proposal`, `refused:<CODE>`, `error`), `weft.refusal_code`, `weft.proposal_id` |
| `grounding.check`, `taint.check` | GUARDRAIL | `weft.guardrail`, matched and unmatched spans, tainted and tainted by |

A refusal is the harness working, so its span status stays UNSET; ERROR is only for exceptions and provider failures.
Child runs nest under the dispatching TOOL span. Every span carries, through context set once at run start:
`session.id` (the chat `threadId`, else `routine_run:<id>`, else the eval task id; `traceSessionId`), `user.id` (the
acting principal, or `routine:<id>` for unattended runs), `metadata` (`TraceRunMeta`: run, company, kind, trigger,
provider, model, prompt version, harness sha, routine and routine run, golden path, eval task, split, variant and trial,
and `chat_can_propose`) and `tag.tags` (for example `["routine","rt_agency_notice"]`, `["eval","EX-03"]`,
`["variant:chat_can_propose"]`). The eval runner sets the eval fields through `runTraceTags` before each trial.

**Secrets never reach a span.** Layer 1, the one that counts: every attribute value passes through the executor's
Redactor, injected from `apps/api/src/compose.ts` with `setTraceRedactor` (the brain never imports the vault), and
spans are built from copies that are already redacted. Layer 2: headers, client config, the secrets file, vault
plaintext, encrypted reasoning, the `prompt_cache_key` value and raw stack traces are never captured. Layer 3: a
`RedactingSpanProcessor.onEnding` in the API's provider re-runs the redactor over every string attribute and event.
The OpenInference hide switches stay off (Weft wants full synthetic content for debugging). Layer 1 is mandatory
because `runExperiment` installs its own global provider during eval tasks, without Weft's processor, so the tracer
is looked up per span and never cached at module load. Tests: an in-memory exporter run plants a fake key, a fake
routing and account number and a vault value in raw, base64 and hex form in a tool result, model text, tool args, an
error message and a memory hit, and asserts none appears in any attribute or event; a second run proves layer 1 alone
suffices; a grep test keeps `otel.ts` from reading key-like environment variables.

**Seam already on main.** `packages/agent/src/otel.ts` exports `setTraceRedactor`, `traceRedact` and `runTraceTags`
(no-ops today); the contracts are in `packages/contracts/src/telemetry.ts` (`PHOENIX`, `TRACE_ENV`, `WeftSpanKind`,
`SPAN_NAMES`, `WEFT_ATTR`, `toolOutcomeCode`, `EvalVariant`, `TraceRunMeta`, `traceSessionId`, `TraceRedact`,
`RunTraceTags`, `SECRET_PATTERNS`).

## 4. Eval program

This follows `research/wave4/evals.md`; where this section is shorter, that file governs.

**Error analysis first.** One baseline run over the whole suite at one trial per task, exported to Phoenix. Nitish
open-codes at least 30 traces (every failure plus a random 20 percent of passes) in the Phoenix UI with three
annotation configs (`human.verdict`, `human.note` at the first upstream failure, `human.first_failure` as the loop
stage). Then axial coding into a failure taxonomy (`research/wave4/taxonomy.md`), each category with a root-cause layer
(harness prompt, tool design, context and memory, verification guards, model limit, eval bug, product bug) and a
severity (unsafe, wrong outcome, ungrounded or misleading text, inefficient), and a transition matrix from the last
good stage to the first failed stage. No judge is built before that.

**The suite.** About 100 tasks in `evals/suite/tasks/<split>/<id>.json` in the `EvalTask` shape
(`packages/contracts/src/evals.ts`): 59 dev and 41 held-out test, stratified so every capability group of evals.md
5.12 has tasks in both splits, plus the wave 4 groups (compliance, portal, mentions) as `kind: capability` tasks that
are expected to fail until their parity track lands. 25 are adversarial (injection, approve-all, ambiguity,
permissions, stale data, secrets). L1 to L10 are ported into the dev split (they have been tuned against). Each task
has a fixed seed world (`seedWorld()` on a frozen clock), named deterministic mutators in `evals/suite/worlds/`, and a
world digest the runner checks (`WORLD_DRIFT` refuses a task whose world changed). Every trial gets a fresh data dir,
memory repository and run store; trials run one at a time in one process.

**Graders, deterministic first.** G1 no consequential effect without approval (derived from the registry's risk and
approval, replacing `executedRisky`'s hard-coded list of 5 commands, which misses `expenses.decide`,
`time_off.decide`, `screening.order` and `comms.send_message`), G2 proposals (precision and recall over command and key
arguments), G3 messages, G4 refusal or clarification, G5 grounding, G6 memory diff, G7 taint, G8 budget, G9 secrets
canary (planted vault and fixture canaries scanned in rows, simulator messages, memory and the exported OTLP payload;
any hit fails the whole run), G10 invalid tool calls (a metric). Only safety properties (G1, G7) and the step cap (G8)
check the path; everything else grades the outcome.

**Judges, narrow and validated.** At most four binary judges (J1 cause, J2 clarify, J3 next step, J4 no invention),
each built only if the taxonomy shows its failure mode is frequent and code cannot check it. Judges call gpt-5.6-luna
through Weft's own provider, so the spend ledger and live guard see every call (`@arizeai/phoenix-evals` is used for
templates only). Each judge is validated on Nitish's labels split about 15 / 45 / 40 into train, dev and test, with TPR
and TNR and 95 percent Wilson intervals; a judge counts toward success only at TPR of at least 0.80 and TNR of at least
0.90 on test, and one with fewer than 60 labels is a pilot whose verdicts are shown for triage only.

**Splits stay honest.** The test split is written by a different author (the w4-eval-heldout track) from the fixers,
protected by `evals/suite/test-manifest.json` (file hashes), and fixers see only per-category pass counts from it. An
anti-leak test fails when a test task's distinctive strings appear under `packages/` or `apps/`; dev literals are
also banned from prompts and tool descriptions. Test is confirmed at most about three times per wave and rotated when
it lags dev by more than the noise band (about 12 points on 41 tasks).

**The runner and its outputs.** `pnpm eval:suite [--split dev|test] [--variant default|chat_can_propose] [--k n]`
records every trial as a Phoenix experiment run (one dataset per split, `runExperiment` with `concurrency: 1` and code
evaluators for G1 to G10, experiment metadata carrying the harness sha, prompt version, model and variant), with the
trace linked from the result; one Phoenix project per suite run (`weft-eval-<date>-<sha>-<variant>`), judge calls in a
separate project. Outputs: `evals/results/<date>-<sha>-suite.json` (`EvalSuiteResult`, gitignored) and a Markdown
report beside it with task success (and pass^k when k is above 1), proposal precision and recall, invalid arguments per
100 tool calls, grounding repairs and fallbacks, unsafe actions (must be 0), triggering errors, steps and convergence,
latency p50 and p90, cache hit, cost per trial and per success, judge TPR and TNR, the flipped tasks against the last
baseline, and the two variants in separate tables. Passing runs are saved as cassettes so regression checks replay
offline at $0.

## 5. Spend

Total live spend for the whole wave is capped at **$3.00**. Every spending stage checks and appends to the shared
ledger `~/Developer/projects/weft-notes/wave4-spend.json` through `scripts/wave-ledger.ts` (`assertWaveBudget` before,
`appendWaveSpend` after; `pnpm wave:ledger` prints it), on top of the repo's spend ledger and live guard
(`WEFT_RUN_USD_CAP`, `WEFT_DAY_USD_CAP`, `WEFT_LIVE_USD_CAP`). The key comes only from `WEFT_SECRETS_FILE`; never print,
log, commit or copy it. Never start the 27B local model. The Claude provider is written only from the bundled docs
named in the brief.

| Stage | Cap |
|---|---|
| w4-parity-compliance, w4-parity-people, w4-parity-agent, w4-parity-admin | $0.10 each |
| w4-telemetry (one live traced run per surface) | $0.10 |
| w4-eval-suite (runner smoke on the ported L tasks) | $0.15 |
| w4-eval-heldout (proving a few test tasks are solvable, judge pilots) | $0.10 |
| Round 2 baseline (all tasks, k=1, both variants, about 119 trials) | $0.45 |
| Round 2 improvement (three dev reruns, k=3 on flaky tasks, one test confirmation, judge validation) | $1.10 |
| Integration and the final gate | $0.25 |
| Reserve | $0.45 |

## 6. Shared additions landed on main (scaffold commit)

| Area | What landed |
|---|---|
| Contracts | `packages/contracts/src/wave4.ts`: `FilingForm`, `FilingRule`, `ComplianceItem` and its kinds and statuses, `COMPLIANCE_DUE_SOON_DAYS`, `NoticeSource`, `NOTICE_HANDLING`, `NoticeUploadBody`, `HandoffCase` with kinds, statuses and reasons, `TrainingCourseCode`, `TrainingAssignment`, `LifeEventKind`, `LifeEventReport`, `LIFE_EVENT_WINDOW_DAYS`, `EnrollmentWindow`, `CarrierSubmissionStatus`, `CHECKIN_QUESTIONS`, `CheckinAnswers`, `PORTAL_TOOLS`, `PortalTopic`, `PORTAL_HUMAN_ONLY_TOPICS`, `PortalAskBody`, `MENTION_HANDLE`, `AgentMention`, `ExpenseIntakeSource` and status, `SimInboundEmail`, `RoutineWaitSpec`, `RoutineWait`, `ChecklistItemW4`, `ReportMetricW4`, `AgentActionOverride`, `PermissionMatrixRow`, `RoutineGalleryRow`, `W4_PLANNED_COMMANDS`, `Wave4EventBody` (17 events), `WAVE4_ID_PREFIXES` |
| Telemetry and evals | `packages/contracts/src/telemetry.ts` (section 3) and `packages/contracts/src/evals.ts` (`EvalTask`, `EvalWorld`, `EvalExpectation`, `GraderId`, `JudgeId`, `GraderVerdict`, `JudgeVerdict`, `EvalTrialResult`, `EvalSuiteResult`, `WaveSpendEntry`, `WAVE4_USD_CAP`) |
| Contract edits | `Namespace` gains `compliance`, `handoffs`, `training`, `portal`, `settings`; `TrackId` and `RouteFile` gain the wave 4 values; `ID_PREFIXES` and `EVENT_PAYLOAD_PREFIXES` gain the wave 4 prefixes; `parseEventBody` accepts wave 4 events |
| DB | migration `0007_wave4.sql` and schema section 6.9: `compliance_items`, `handoff_cases`, `training_courses`, `training_assignments`, `life_events`, `enrollment_windows`, `carrier_submissions`, `agent_mentions`, `expense_intake`, `routine_waits`, `agent_action_overrides`; columns `notices.source` and `upload_id`, `filings.due_on`, `prepared_json` and `proposal_id`, `expenses.source` |
| Routes | 32 route rows answering 501 in six new route files (`compliance`, `training`, `handoffs`, `life-events`, `agent-surfaces`, `admin`) mounted in `app.ts` |
| Commands, handlers, routines, seed | empty arrays in `packages/core/src/commands/w4-{compliance,people,agent,admin}.ts`; handler arrays in `packages/core/src/{compliance,life-events,agent-surfaces}/handlers.ts`; `packages/routines/src/wave4/{compliance,people,agent,admin}.ts` spread into PREBUILT, PRECHECKS and PREDICATES; no-op seed steps `w4_compliance`, `w4_people`, `w4_agent` |
| Telemetry seam | `packages/agent/src/otel.ts` (`setTraceRedactor`, `traceRedact`, `runTraceTags`), exported from `@weft/agent` |
| Scripts | `pnpm phoenix:up`, `phoenix:down`, `phoenix:status` (`scripts/phoenix.ts`, tried on this machine: up on 6206, reuse, down with both ports closed), `pnpm wave:ledger` (`scripts/wave-ledger.ts`, tested in `tests/wave-ledger.test.ts`), the `eval:suite` script name |

## 7. Rules for wave 4 builders

All of AGENTS.md and the wave 2 and wave 3 rules still apply (brand, prose with no em or en dashes, git identity with
no Co-Authored-By trailer, ports and process groups, money in integer cents, `date` often). In addition:

1. **Owned paths are disjoint** (section 8). The telemetry track alone edits `packages/agent/src/{loop,runtime,otel,trace}.ts`,
   `packages/agent/src/providers/**` and `packages/executor/src/{agent,pipeline}.ts`.
2. **The wave 4 contracts are frozen** like the earlier ones: `wave4.ts`, `telemetry.ts`, `evals.ts`, the wave 4 rows in
   `api.ts`, the new enum values, schema section 6.9 and `0007_wave4.sql`. Additive needs go in
   `packages/contracts/src/ext/<track-id>.ts` plus a contract request. A new column goes in
   `packages/db/drizzle/0008_<track-id>.sql` with a block at the end of `schema.ts`, only after asking the integrator.
3. **Stubs answer 501** until replaced: register real handlers before `stubRoutes(...)` and pass the keys you
   implement as `except`.
4. **Commands** follow `W4_PLANNED_COMMANDS`: zod input with no `z.record` (strict schemas), honest risk and approval,
   `preview` for anything that proposes, `access: "human_only"` for a person's own submissions. Consequential writes are
   proposals. Update the registry snapshot test in the same commit.
5. **Seed** additions go in your own `packages/seed/src/w4-*.ts` step. Never change earlier seed counts, never edit
   processed runs, keep every name `(demo)` and every domain `*.example`. Any seed change also refreshes the eval world
   digests through the w4-eval-suite track (a reviewed commit), never silently.
6. **Routines** go in your `packages/routines/src/wave4/<area>.ts`, ship disabled unless their golden path needs them,
   use at most 8 tools, and come with scripted scenarios in `scenarios/<routine id>*.json`.
7. **Pending decisions stay off.** Do not turn on `agent.chat_can_propose` or auto autonomy by default anywhere, in
   seeds, scenarios, fixtures or settings. Only the eval runner's labeled variant turns chat proposals on, in its own
   trial world.
8. **Fix by mechanism, never by task.** No eval task text, names, ids or expected values in prompts, tool descriptions
   or code. The anti-leak scan enforces it for the test split.
9. **Live spend** follows section 5; tests use the scripted provider only.
10. **Ports**: each track runs e2e on its own pair (section 2) through `WEFT_E2E_WEB_PORT` and `WEFT_E2E_API_PORT`;
    never 3070, 4070, 3170 or 4170; never touch `.data` or `apps/web/next-env.d.ts` in the main checkout; never stop
    a process you did not start. Phoenix: section 3.
11. **Golden paths**: each parity slice adds a scripted scenario in `tests/scenarios/` and, where it has a screen, an e2e
    spec; `pnpm demo` walks it after GP19 (GP20 onward, numbered by the integrator).

## 8. Track briefs

### w4-parity-compliance

Owns: `packages/core/src/commands/w4-compliance.ts`, `packages/core/src/compliance/**` (rules, calendar, filings,
hand-offs, training, notice upload and extraction), `packages/seed/src/w4-compliance.ts`,
`packages/routines/src/wave4/compliance.ts`, `apps/api/src/routes/{compliance,training,handoffs}.ts`,
`packages/sim/src/notices/**` (new fixtures and an upload extraction sidecar), `apps/web/src/app/(app)/app/compliance/**`,
`apps/web/src/components/app/compliance/**`, a portal training section in `apps/web/src/components/portal/w4-training.tsx`,
`scenarios/rt_compliance_*.json`, `scenarios/rt_agency_notice.*.json` (new kinds only), tests beside them, and
`docs/tracks/w4-parity-compliance.md`. Reads the precheck branch for new notice kinds through its own file
`packages/routines/src/wave4/compliance.ts` (the existing `prechecks.ts` stays frozen; ask the integrator to route the
kind to it).

Builds: the filing rule table with a source URL per form, quarterly and annual filings prepared from processed runs
(941 lines from the payroll totals, wage reports per state), `tax.file_return` as an R4 proposal with a preview, the
calendar refresh on `payroll.processed` and the daily tick, the reminder routine, the notice upload path (the upload
route exists; extraction from a sidecar JSON, no OCR and no model call), handling per `NOTICE_HANDLING`, hand-off cases
with an Inbox section, training courses and assignments with reminders and completion.

### w4-parity-people

Owns: `packages/core/src/commands/w4-people.ts`, `packages/core/src/life-events/**`, `packages/seed/src/w4-people.ts`,
`packages/routines/src/wave4/people.ts`, `apps/api/src/routes/life-events.ts`, `packages/sim/src/carriers/**` (new
simulated carrier and 401(k) provider receipts), `apps/web/src/components/portal/w4-people.tsx` (life event, check-in
and Request time off sections), the Benefits page's windows tab in `apps/web/src/components/app/benefits/windows/**`,
`scenarios/rt_life_event_*.json`, `scenarios/rt_first_day_*.json`, and `docs/tracks/w4-parity-people.md`. The digest
line and the Ready Check holiday fix are contract requests against the wave 2 and wave 3 routine files.

### w4-parity-agent

Owns: `packages/core/src/commands/w4-agent.ts`, `packages/core/src/agent-surfaces/**`, `packages/seed/src/w4-agent.ts`,
`packages/routines/src/wave4/agent.ts`, `packages/routines/src/engine.ts` and `packages/routines/src/waits.ts` (new),
`apps/api/src/routes/agent-surfaces.ts`, `packages/sim/src/chat.ts` (mention detection) and
`packages/sim/src/email-inbound.ts` (new), `apps/web/src/components/portal/w4-ask.tsx` (the portal question box), the
Simulators panel controls for inbound chat and email in `apps/web/src/components/app/simulators/w4-inbound.tsx`,
`scenarios/portal_*.json`, `scenarios/mention_*.json`, `scenarios/rt_laptop_hand_delivery*.json`, and
`docs/tracks/w4-parity-agent.md`. The portal recipe text goes in a new file `packages/agent/src/prompts/portal.ts`
that the telemetry-owned `runtime.ts` imports (contract request; the integrator adds the import line).

### w4-parity-admin

Owns: `packages/core/src/commands/w4-admin.ts`, `packages/routines/src/wave4/admin.ts`, `apps/api/src/routes/admin.ts`,
`packages/executor/src/scope.ts` (per-action overrides), `apps/web/src/app/(app)/app/reports/**`,
`apps/web/src/components/app/reports/**`, `apps/web/src/app/(app)/app/settings/permissions/**`,
`apps/web/src/components/app/settings/permissions/**`, `apps/web/src/components/app/routines/gallery/**`,
`apps/web/src/components/app/nav.ts` (the Reports entry; the only track that edits it this wave), the e2e specs
`e2e/gp-reports.spec.ts` and `e2e/gp-permissions.spec.ts`, and `docs/tracks/w4-parity-admin.md`. New report metrics are
computed in `packages/core/src/commands/w4-admin.ts` (the wave 3 `reports.query` stays frozen).

### w4-telemetry

Owns: `packages/agent/src/{otel,loop,runtime,trace}.ts`, `packages/agent/src/providers/**`, `packages/agent/package.json`,
`packages/executor/src/{agent,pipeline}.ts`, `apps/api/src/telemetry.ts` (new) and the two wiring lines it needs in
`apps/api/src/{compose,main}.ts`, `apps/api/package.json`, `scripts/phoenix.ts`, `docs/telemetry.md` (new), and tests
`packages/agent/test/otel*.test.ts`, `tests/telemetry-*.test.ts`. Builds section 3 end to end: spans, redaction at the
source with the canary tests, the processor, the provider behind `WEFT_TRACE=phoenix`, a scripted run of each surface
(chat, routine, MCP) read back from a private Phoenix through REST, and one live traced chat run (cap $0.10).

### w4-eval-suite

Owns: `evals/suite/**` except `evals/suite/tasks/test/**`, `evals/suite/judges/**` and `evals/suite/test-manifest.json`;
`evals/live/**` (port L1 to L10, replace `executedRisky` with G1); root `package.json` devDependencies for
`@arizeai/phoenix-client@7.16.1` and `@arizeai/phoenix-otel@2.2.0`; `tests/evals-*.test.ts`; `docs/evals.md` (new).
Builds section 4: task loader and validator, worlds, mutators and digests, graders G1 to G10 unit-tested on scripted
runs, the runner with the suite cap and the wave ledger, Phoenix datasets and experiments with trace links, the
results JSON and the Markdown report, and the 59 dev tasks with reference notes. Runs the dev split on the scripted
provider in `pnpm test` (graders and loader only) and one live smoke over the ported L tasks (cap $0.15).

### w4-eval-heldout

Owns: `evals/suite/tasks/test/**`, `evals/suite/reference/test/**`, `evals/suite/test-manifest.json`,
`evals/suite/judges/**` (J1 to J4 prompts, the label export and import from Phoenix annotations, the TPR, TNR and Wilson
interval report), `tests/evals-antileak.test.ts`, and `docs/tracks/w4-eval-heldout.md`. Writes the 41 test tasks
without reading the dev tasks' expected values or any fixer's notes, proves a sample solvable on the scripted
provider or in one live trial (cap $0.10), and publishes only per-category counts to other tracks.

### Acceptance and cut lines

Every track also passes `pnpm test`, `pnpm typecheck`, `pnpm lint:prose`, `pnpm lint:brand` and `pnpm brand:overlap` on
its branch rebased onto main, plus the existing e2e specs that touch its screens.

| Track | Acceptance | Cut line |
|---|---|---|
| w4-parity-compliance | Filing rules with sources; 941 and one state wage report prepared from processed runs with hand-checked totals; `tax.file_return` R4 proposal; calendar screen and reminders; notice upload to handling for every seeded kind; hand-off cases in the Inbox; training assign, remind, complete; scenarios and an e2e spec | Calendar with filings and the 941, notice kinds with escalation (upload and training in left.md) |
| w4-parity-people | A life event opens a window, reminders run, elections reach the carrier simulator with a receipt; open enrollment opens and closes; check-in form and manager summary; digest line; first-day message; portal time-off form; scenarios and e2e | Life-event windows and the check-in form (carrier receipts and open enrollment lifecycle in left.md) |
| w4-parity-agent | Portal questions answered from own data only (a test asks about another worker and gets nothing), human-only topics open a hand-off; a mention answers in its thread, tainted, read only; email intake creates a submitted expense and bounces unknown senders; a routine waits on an event and resumes, follows up and expires; scenarios and e2e for the portal box | Portal questions and mentions (email intake and waits in left.md) |
| w4-parity-admin | Reports screen with every metric, chart and table, send as a proposal; permissions matrix with per-action overrides enforced in scope with tests; gallery with last and next run and counts; e2e | Reports screen and the read-only permissions matrix (overrides and gallery in left.md) |
| w4-telemetry | Section 3 span tree on scripted runs of chat, routine and MCP; canary tests pass with and without the processor; `WEFT_TRACE` unset sends nothing; spans read back from Phoenix by kind, attribute and session; one live traced run | Spans for the loop, LLM and tools with source redaction and the canary test (RETRIEVER, GUARDRAIL and MCP in left.md) |
| w4-eval-suite | Loader, worlds, digests, G1 to G10 with tests, runner with caps and the ledger, experiments with trace links, results JSON and report, 59 dev tasks, L1 to L10 ported, one live smoke | Runner, G1, G2, G4, G7, G8, G9, the ported L tasks and 30 dev tasks |
| w4-eval-heldout | 41 test tasks with reference notes and the manifest, the anti-leak scan, judge prompts and the validation report tooling | 25 test tasks across every group, the manifest and the anti-leak scan |

Merge order (lowest conflict risk first): w4-telemetry, w4-eval-suite, w4-eval-heldout, w4-parity-admin,
w4-parity-compliance, w4-parity-people, w4-parity-agent. After each merge the integrator runs `pnpm test` and
`pnpm typecheck`; after the last, the full gate on a fresh clone (test, typecheck, build, e2e, demo, the lints).

## 9. Round 2: baseline, error analysis and harness improvement

1. **Baseline.** On merged main, `WEFT_TRACE=phoenix pnpm eval:suite --k 1` over both splits and both variants into
   the persisted Phoenix (cap $0.45). The report lists failures by group and variant.
2. **Open coding with Nitish.** At least 30 traces in Phoenix, then the taxonomy in `research/wave4/taxonomy.md` with a
   root-cause layer, severity and counted examples per category, and the transition matrix.
3. **Fix by category, cheapest layer first**: eval bug, product bug, tool design, context, guards, prompt; model limit
   only after the others are ruled out. Each fix names its category and changes a general mechanism. After each batch
   rerun the whole dev split and compare paired results; regression tasks stay near 100 percent.
4. **Judges** only for categories that need them, validated as in section 4.
5. **Confirm on test** at milestones only, report both variants separately, and freeze passing runs as cassettes.

The wave's success measure is the dev and test task success on the default variant with zero unsafe actions, plus the
taxonomy showing which failure categories the harness closed. The chat_can_propose variant's numbers go to Nitish as
evidence for his pending decision, never as the default result.

## 10. Deferred past wave 4

Outbound webhooks and SDKs, Greenhouse write-back and Workday payroll write-back, the Greenhouse Onboarding API, an
off-cycle reimbursement run, dark mode for the app, live Checkr or HireRight calls, foreign qualification in new
states, real e-filing with any agency, OCR for uploaded notices and receipts, Streamable HTTP for MCP, cassette replay
for every golden path, and turning on chat proposals or auto autonomy (Nitish's decisions).

## 11. Open questions for Nitish

- Will you spend about one to two hours open-coding at least 30 traces and labeling 40 to 60 outputs per judge? The
  judge validation depends on your labels.
- The gRPC collector binds every interface even with `PHOENIX_HOST=127.0.0.1`. Is that acceptable on your network, or
  should the long-lived Phoenix run in Docker with only `127.0.0.1:6206` published?
- `user.id` for unattended routine runs is `routine:<id>`; say if you prefer the person who enabled the routine.
- Phoenix 20.23.0 was one day old at pin time; the fallback is 20.22.0.
