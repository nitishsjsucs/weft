# Review log

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
