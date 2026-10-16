# Review log

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
| Brand | research/ quotes reference marketing lines verbatim and they are in git history | The working files are paraphrased in wave 2 (w2-reliability); the history still holds the old lines. The repo is local only and never pushed. Before any publish, paraphrase research/product.md and research/agent.md or move them out of the tracked tree and rewrite history |
