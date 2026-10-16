# Wave 2 plan

Wave 1 passed its gate on 2026-10-15 (fresh clone at 56d0054: 403 tests, typecheck 15 of 15, build, 23 e2e specs, demo, GP1 to GP5 and the MCP and API test on the scripted provider; live L1, L2 and L4 pass, L3 flaky). Wave 2 adds the HRIS lifecycle (self-service onboarding, offboarding with access revocation, off-cycle pay), benefits reconciliation and contractor payouts, harness memory, the remaining providers and the code.run sandbox, and the reliability items from the gate report.

Hard deadline: everything merged, reviewed, fixed and gated by 22:00 PDT on 2026-10-15. Finishing beats starting. Every track lands working, tested slices and records what is left in `.scratch/<track-id>/left.md`. Every existing test, e2e spec and the demo stays green after every merge.

## What landed (integration, 2026-10-15 evening)

All six tracks merged into main with no conflicts, in the planned order (`22ae51a` reliability, `4e17a78` providers and
sandbox, `a82824a` memory, `184c6d7` benefits and contractors, `4be5065` onboarding, `46b1c21` offboarding). The two
identical `contract:` commits for `parseEventBody` (onboarding `98c91b7`, cherry-picked by offboarding) collapsed into
one change in `packages/contracts/src/events.ts`; the offboarding `contract:` commit for `HumanExecutor.propose` and the
providers `contract:` commit for the sandbox refusal codes landed as they were. The track branches are kept; their
worktrees are removed.

Integrator changes on top of the merges, from the tracks' contract requests and left lists:

| Change | Where |
|---|---|
| `rt_onboarding_nudge`, `rt_open_enrollment` and `rt_memory_digest` join PREBUILT (disabled), with scripted scenarios for the first two; the two wave 1 prebuilt id assertions now list 7 routines | `packages/routines/src/wave2/*.ts`, `scenarios/rt_onboarding_nudge.json`, `scenarios/rt_open_enrollment.json` |
| The scheduler tick drives the payment rail (`syncContractorRail` after `sims.tick`), so payouts move sent to delivered with no read; the approval's scheduler kick sends them, so a booked payout reads `sent` right after approval | `apps/api/src/scheduler.ts` |
| Offers expire on the sim clock: `svc_scheduler` may run `documents.expire_offers` (R1), and the tick calls it only when a sent or viewed offer is past its expiry date | `packages/executor/src/system.ts`, `apps/api/src/scheduler.ts`, `tests/scenarios/gp6-offer-expiry.test.ts` |
| Prices per provider: Luna for `openai`, Opus 5.5 for `claude` ($4, $0.20, $20 per million), zero for local; `WEFT_PRICES_JSON` still overrides | `packages/agent/src/cost.ts`, `packages/agent/src/runtime.ts` |
| `createWeft()` passes the registry's compact tool descriptions to the local provider | `apps/api/src/compose.ts` |
| `IdpSim.clearGroups` and `DeviceSim.lock` folded into the frozen sim contract; `@weft/core` exports the offboarding read model as `offboarding` | `packages/contracts/src/sim.ts`, `packages/core/src/index.ts` |
| Route table row for `GET /v1/memory/history`; a Memory nav entry | `packages/contracts/src/api.ts`, `apps/web/src/components/app/nav.ts` |
| Viewing as lists new-hire personas (sent, viewed or accepted offers); choosing one opens `/portal?as=<id>` | `apps/web/src/components/app/shell/header.tsx` |
| `POST /v1/sim/reset` clears stored run handles, since run ids restart | `apps/api/src/routes/sim.ts` |
| Fix: the agent's later onboarding tasks no longer emit `worker.onboarding_completed` a second time after the portal did | `packages/core/src/onboarding/writes.ts` |
| Fix: an offloaded result pages its longest array, so `payroll.get_run` with `response_format: "detailed"` no longer reads "rows 1 to 0 of 0" (its empty `excluded_worker_ids` came first) | `packages/executor/src/workspace.ts` |
| `pnpm demo` walks GP6 to GP12 on the same world after GP1 to GP5 | `apps/api/src/demo.ts` |
| New e2e specs: GP12 memory browser, and the 1440 px layout checks with the agent panel docked; GP6 also checks the persona in Viewing as | `e2e/gp12-memory-browser.spec.ts`, `e2e/site-layout-1440.spec.ts` |
| Fix: reconciliation honors an enrollment ended by offboarding (effective end of month, as the COBRA notice says), so a GP9 leaver billed through October is not a `terminated_but_billed` finding; the three planted errors are unchanged | `packages/core/src/benefits/recon.ts`, `tests/scenarios/gp9-offboarding.test.ts` |
| Fix: a worker terminated after open enrollment was seeded drops out of the open enrollment list, so `rt_open_enrollment` never reminds a leaver | `packages/core/src/benefits/enrollment.ts` |
| Fix: the dev runner spec waited for the processes to stop but read the runner's output before it drained; it now waits for the pipes to close (a fresh-clone gate run caught it once) | `e2e/site-dev-runner.spec.ts` |

Golden paths after the merge, all on the scripted provider: GP1 to GP12 pass as scenario tests; GP1 to GP7 and GP9
to GP12 pass as Playwright specs (GP8 is scenario only, as planned); `pnpm demo` narrates GP1 to GP12 and the audit
chain verifies. Live on `gpt-5.6-luna` after the merge: L1, L2, L4 and L3 three times all pass ($0.0073).

Left after wave 2 (details in each track's `docs/tracks/w2-*.md` and the gitignored `.scratch/w2-*/left.md`):

- Onboarding: commands stay in the `documents.*` namespace; the seeded offer for Noor has no persona or documents; the
  portal refuses HSA elections; a state form's extra withholding is recorded but not used in payroll.
- Offboarding: no case cancel and no failed step state; no "propose again" for a stranded step; CA and NY supplemental
  rates and state final-pay deadlines are not modeled; PTO is a simulated accrual; `DeviceStatus` has no `locked`.
- GP10 "asked in chat" needs `payroll.propose_off_cycle` on the chat allowlist, which is frozen read-only (harness 5.3);
  people and MCP agents propose it today.
- Benefits and contractors: routine reminders do not count toward the screen's nudge counter; no dependents table; no
  retry for returned payouts; nothing consumes `benefits.invoice_received` yet.
- Memory: task agents (`openChildRun`), `memory.forget`, state dossier index rows, alias expansion for `at=<commit>`
  searches, bundle upload to object storage.
- Providers and sandbox: `code.run` values over 64 KiB, nested inner-call steps, a worker thread for QuickJS; no live
  Claude call (no key) and no `mlx_lm.server` smoke test.
- A scripted nudge run posts the first derived nudge only; each later run that day takes the next overdue hire.

## Schedule (PDT)

| Time | What |
|---|---|
| 18:34 to 19:00 | Architect lands the shared contracts on main (this doc, commit "wave 2 scaffold") |
| 19:00 to 21:00 | Six tracks build in parallel worktrees cut from that commit |
| 21:00 | Code freeze for features. Each track rebases on main, runs its acceptance list, commits, writes `left.md` |
| 21:00 to 21:30 | Integrator merges in the order below, running `pnpm test` and `pnpm typecheck` after each merge |
| 21:30 to 21:50 | Review pass and fixes |
| 21:50 to 22:00 | Gate: fresh clone, install, test, typecheck, build, e2e, demo, GP1 to GP11 |

Merge order (lowest conflict risk first): w2-reliability, w2-providers-sandbox, w2-memory, w2-benefits-contractors, w2-onboarding, w2-offboarding.

## Rules for wave 2 builders

All of AGENTS.md still applies (brand, prose, git identity with no Co-Authored-By trailer, ports and process groups, models and spend, money in integer cents, `date` often). In addition:

1. **Owned paths are disjoint.** Each track edits only the files listed under its name below. New files go in the new folders listed for the track. If you need a change in a file you do not own, write it to `.scratch/contract-requests/<track-id>.md` and work around it; the integrator folds it in.
2. **Contracts landed for wave 2 are frozen** like the wave 1 ones: `packages/contracts/src/wave2.ts`, the wave 2 rows in `packages/contracts/src/api.ts`, the new enum values, `packages/db/src/schema.ts` section 6.7 and `packages/db/drizzle/0003_wave2.sql`. Additive needs go in `packages/contracts/src/ext/<track-id>.ts` (export names prefixed with the track, for example `W2Onboarding...`) plus a note in `.scratch/contract-requests/<track-id>.md`. A track that needs a new column or table writes `packages/db/drizzle/0004_<track-id>.sql` and a matching block appended at the end of `packages/db/src/schema.ts` only after asking the integrator (one migration per track, numbered at merge time).
3. **Stubs answer 501.** Every wave 2 route is in the route table and answers 501 NotImplemented through `stubRoutes` until its track replaces it. Replace the stub by registering real handlers before the `stubRoutes(...)` call and adding the key to its `except` list (offers, benefits) or by passing the implemented keys as `except` (portal, documents, offboarding, contractors).
4. **Commands** go in the track's own `packages/core/src/commands/<namespace>.ts` array. New write commands follow the wave 1 pattern: zod input, `preview` for anything that proposes, `approval` and `risk` set honestly, `access: "human_only"` for anything only a person may do (signing, W-4, direct deposit, I-9). Consequential writes are proposals.
5. **Seed** additions go in the track's own seed step (`packages/seed/src/w2-*.ts`, already wired after `payroll`). Keep them deterministic; never change wave 1 seed counts (SPEC 5.2 numbers are asserted by tests).
6. **Routines** go in `packages/routines/src/wave2/<area>.ts` (`routines`, `prechecks`, `predicates`); they are already spread into PREBUILT, PRECHECKS and PREDICATES. New routines ship disabled unless the golden path needs them enabled, and their tools stay at 8 or fewer.
7. **Test ids** for new UI go in `packages/contracts/src/w2/testids-<area>.ts`.
8. **Live spend.** At most about $0.25 per track. Automated tests use the scripted provider only.
9. **No em or en dashes** anywhere (`pnpm lint:prose`), no reference-site names or copy (`pnpm lint:brand`), nothing from `research/design/reference/` committed.

## Shared additions landed on main (this commit)

| Area | What landed |
|---|---|
| Contracts | `packages/contracts/src/wave2.ts`: offer lifecycle and transitions, portal task kinds and order, state withholding forms per state, document kinds and statuses, `WorkerDocument`, `SignatureRecord`, `W4Submission`, `StateWithholdingSubmission`, `DirectDepositSubmission` with `abaChecksumOk`, `I9Submission`, `MaskedUpload`, `BenefitsSelection`, `PortalView`; termination kinds, offboarding step kinds, order and proposal steps, `OffboardingCase`, `OffCycleRequest`; recon finding kinds, `ReconFinding`, open enrollment status, `RailStatus`, `ContractorPayout`; `EmailSim`, `PaymentRailSim`, `BankVerifySim`; `RECALL_BUDGET`, `RecallItem`, `Dossier`, `CoarsenLevel`; `LocalProviderConfig`; `Wave2EventBody` and `WAVE2_EVENT_TYPES`; `WAVE2_ID_PREFIXES` |
| Enums | `OfferStatus` gains `viewed`; `OnboardingTaskKind` gains `sign_confidentiality`; `HumanRole` gains `employee` (the new hire persona); `Namespace` gains `documents`, `offboarding`, `contractors`; `TrackId` gains the six wave 2 ids; `ID_PREFIXES` gains `doc_ sig_ upl_ obs_ ofb_ ofs_ rcf_ oen_ eml_ simr_ simk_` |
| DB | migration `0003_wave2.sql` and schema section 6.7: offer lifecycle columns, contractor rail columns, `documents`, `signatures`, `onboarding_submissions`, `uploads`, `offboarding_cases`, `offboarding_steps`, `benefit_recon_findings`, `open_enrollment`, `fx_rates`, `sim_email_messages`, `sim_rail_transfers`, `sim_bank_verifications`, `memory_recalls`, `dossiers` |
| Routes | 25 new route table rows (offers lifecycle, portal, documents and the email simulator, offboarding and off-cycle, reconciliation and open enrollment, contractor payouts and FX); new route files `portal`, `documents`, `offboarding`, `contractors` mounted in `app.ts`, all 501 |
| Commands | empty arrays in `packages/core/src/commands/{documents,offboarding,contractors}.ts`, concatenated in `commands/index.ts` |
| Simulators | `Simulators` gains `email`, `rail`, `bankVerify`. The email simulator is real (an outbox over `sim_email_messages`, `*.example` only, fault target `email.send`) because onboarding and offboarding both send mail; `rail` and `bankVerify` are stubs in `packages/sim/src/{rail,bank-verify}.ts`; the carrier stub moved to `packages/sim/src/carrier.ts` |
| Seed | no-op steps `w2_onboarding`, `w2_offboarding`, `w2_benefits_contractors` after `payroll` |
| Routines | `packages/routines/src/wave2/{onboarding,benefits,memory}.ts` spread into the registries |
| Agent | `ChatContextSource.recall` hook; the runtime appends a non-empty recall block inside `<context>` for chat and routine runs; `apps/api/src/memory/recall.ts` returns "" until w2-memory lands |
| Web | nav entries Hiring (`/app/hiring`) and Offboarding (`/app/offboarding`) with placeholder pages; `/portal` placeholder outside the admin shell; a Documents tab and a header actions slot on the person view, rendered by `components/app/documents/document-library.tsx` and `components/app/offboarding/person-actions.tsx` |

## New golden paths

Each golden path has a scenario test under `tests/scenarios/` (scripted provider, `createTestWeft()`) and, where marked, a Playwright spec under `e2e/`.

**GP6. Offer to signed (w2-onboarding, e2e `gp6-offer-portal.spec.ts`).** Dana opens Hiring, builds an offer for a fictional candidate in CO (title, department, manager, base, start date), saves it as a draft, sends it. The email simulator holds an invite with a portal link. Signing in as the new hire persona marks the offer viewed. The new hire signs the offer and the confidentiality agreement by typing their name; each signature row and its action row carry the signer, the sim timestamp and the document sha256. The offer reads Accepted, the worker exists with status onboarding, and both documents show under Signed in the person's library.

**GP7. New-hire checklist unblocks payroll (w2-onboarding, e2e `gp7-new-hire-checklist.spec.ts`).** The portal shows the canonical checklist with a progress counter (for example 2 of 7). The new hire submits a 2020 or later W-4 (filing status, step 2, steps 3 and 4 in cents), the CO DR 0004 form, direct deposit (a routing number that fails the ABA checksum is refused inline; a valid one is verified by the bank simulator), the I-9 simulation with an ID image stored under the data dir and shown masked, and a benefits election from the seeded plans. The counter reaches 7 of 7, the worker turns active, and the next payroll draft includes the hire with the W-4 inputs in withholding, the elected deductions in pre-tax lines, and no MISSING_BANK_ACCOUNT flag.

**GP8. Straggler nudge (w2-onboarding).** A routine `rt_onboarding_nudge` runs on schedule, finds hires with open employee-owned tasks past their due date, posts one nudge per hire in the chat simulator (#new-hires) naming the open tasks, and stops nudging once the checklist is complete. Repeat runs inside the same day are skipped by the precheck.

**GP9. Termination with access revocation (w2-offboarding, e2e `gp9-offboarding.spec.ts`).** From a person's header, Dana terminates an active employee (kind, last day, note). One action opens an offboarding case with steps in order: final pay proposal (a dismissal payroll with unused PTO when asked), directory suspend, SSO deactivation, group and app removal, device lock, benefits termination and a COBRA notice through the email simulator. Final pay, directory suspend, SSO deactivation and device lock are proposals; approving them runs the simulator calls. Every step writes an action row; the case reads Complete when all steps are done or skipped.

**GP10. Off-cycle pay (w2-offboarding).** Asked in chat, the agent computes a missed payroll for one employee whose raise took effect mid-period, prorating the old and new rates by days, adds a bonus taxed at the federal supplemental rate, and proposes an `off_cycle` payroll. The proposal preview shows each earning line in cents; approval submits it to the bank simulator like a regular run.

**GP11. Benefits reconciliation and contractor payouts (w2-benefits-contractors).** The carrier simulator issues the October invoice with three planted errors (a terminated worker still billed, a family tier billed for a worker without a dependent on file, an ee tier billed for a family enrollment). Running reconciliation compares invoice lines to enrollments and paycheck deductions and lists exactly those three findings with billed, expected and deducted cents. Open enrollment lists who has not elected and the chase routine nudges them. Contractor payouts convert with the fixed FX table, go to the payment rail simulator, and move pending, sent, delivered on the sim clock.

**GP12. Memory recall and coarsening (w2-memory, scenario test).** After the seeded week, `rt_memory_digest` rolls `timeline/raw/` into hourly, daily and weekly summaries with back-references, refreshes the dossier of a person mentioned in new events and the company one-pager, and commits as the agent. A chat run about that person starts with a recall block within `RECALL_BUDGET` that includes the one-pager and the dossier path, logged in `memory_recalls`; running the digest twice for the same period changes nothing.

## Tracks

Each track works in its own git worktree from the wave 2 scaffold commit, on branch `w2/<track-id>`. Paths below are relative to the repo root. "Owns" lists new folders and files the track creates or fills, then the exact existing files it may edit. Nobody else edits them.

### w2-onboarding: offer builder, new-hire portal, e-signature, documents, nudge routine

Owns:
- New or stubbed: `apps/api/src/routes/portal.ts`, `apps/api/src/routes/documents.ts`, `packages/core/src/commands/documents.ts`, `packages/core/src/documents/**`, `packages/core/src/portal/**`, `packages/sim/src/email.ts`, `packages/sim/src/bank-verify.ts`, `packages/seed/src/w2-onboarding.ts`, `packages/routines/src/wave2/onboarding.ts`, `packages/contracts/src/w2/testids-onboarding.ts`, `packages/contracts/src/ext/w2-onboarding.ts`, `apps/web/src/app/(app)/app/hiring/**`, `apps/web/src/app/(portal)/**`, `apps/web/src/components/app/hiring/**`, `apps/web/src/components/app/documents/**`, `apps/web/src/components/portal/**`, `apps/api/test/portal.test.ts`, `apps/api/test/documents.test.ts`, `apps/api/test/offers-lifecycle.test.ts`, `packages/core/test/onboarding/**`, `packages/sim/test/email.test.ts`, `packages/sim/test/bank-verify.test.ts`, `tests/scenarios/gp6-*.test.ts`, `tests/scenarios/gp7-*.test.ts`, `tests/scenarios/gp8-*.test.ts`, `e2e/gp6-offer-portal.spec.ts`, `e2e/gp7-new-hire-checklist.spec.ts`
- Existing files: `apps/api/src/routes/offers.ts`, `packages/core/src/commands/onboarding.ts`, `packages/core/src/onboarding/handlers.ts`, `packages/core/src/onboarding/queries.ts`, `packages/core/src/onboarding/writes.ts`, `apps/web/src/components/app/people/people-view.tsx`, `apps/api/src/http/auth.ts` (new hire persona session only)

### w2-offboarding: termination, access revocation, COBRA, off-cycle pay

Owns:
- New or stubbed: `apps/api/src/routes/offboarding.ts`, `packages/core/src/commands/offboarding.ts`, `packages/core/src/offboarding/**`, `packages/core/src/payroll/offcycle.ts`, `packages/seed/src/w2-offboarding.ts`, `packages/contracts/src/w2/testids-offboarding.ts`, `packages/contracts/src/ext/w2-offboarding.ts`, `apps/web/src/app/(app)/app/offboarding/**`, `apps/web/src/components/app/offboarding/**`, `apps/api/test/offboarding.test.ts`, `packages/core/test/offboarding/**`, `tests/scenarios/gp9-*.test.ts`, `tests/scenarios/gp10-*.test.ts`, `e2e/gp9-offboarding.spec.ts`
- Existing files: `packages/core/src/commands/it.ts`, `packages/core/src/it/writes.ts`, `packages/sim/src/idp.ts`, `packages/sim/src/devices.ts`, `packages/core/src/payroll/lifecycle.ts` (off_cycle and dismissal subtypes only), `packages/core/src/commands/payroll.ts` (append off-cycle commands only), `packages/payroll-tax/src/**` (additive federal supplemental path only; the golden tests stay exact)

### w2-benefits-contractors: carrier reconciliation, open enrollment, contractor payouts

Owns:
- New or stubbed: `apps/api/src/routes/contractors.ts`, `packages/core/src/commands/contractors.ts`, `packages/core/src/contractors/**`, `packages/core/src/benefits/recon.ts`, `packages/core/src/benefits/enrollment.ts`, `packages/sim/src/carrier.ts`, `packages/sim/src/rail.ts`, `packages/seed/src/w2-benefits-contractors.ts`, `packages/routines/src/wave2/benefits.ts`, `packages/contracts/src/w2/testids-benefits.ts`, `packages/contracts/src/ext/w2-benefits-contractors.ts`, `apps/web/src/components/app/benefits/**`, `apps/web/src/components/app/contractors/**`, `apps/api/test/contractors.test.ts`, `apps/api/test/benefits-recon.test.ts`, `packages/core/test/benefits/**`, `packages/sim/test/carrier.test.ts`, `packages/sim/test/rail.test.ts`, `tests/scenarios/gp11-*.test.ts`
- Existing files: `apps/api/src/routes/benefits.ts`, `packages/core/src/commands/benefits.ts`, `packages/core/src/benefits/queries.ts`, `packages/sim/src/fx.ts`, `apps/web/src/components/app/products/products-view.tsx`, `apps/web/src/app/(app)/app/benefits/page.tsx`, `apps/web/src/app/(app)/app/contractors/page.tsx`

### w2-memory: complete the Instinct-style git memory (research/harness.md section 18)

Work in the section 18 priority order: timeline coarsening (`rt_memory_digest`, raw to hourly, daily, weekly, monthly with `path#L<n>` back-references, idempotent per period), wiki-links and backlinks, dossiers and `knowledge/company/one-pager.md`, recall at run start (at most 4 searches, 1,200 tokens, once per run, always the one-pager, tainted hits taint the run), learned preferences from decisions, `pnpm memory:bundle` and `pnpm memory:restore`, then the read-only memory browser if time. Search stays deterministic (`git grep`, aliases, wiki-link expansion); no embeddings.

Owns:
- New or stubbed: `apps/api/src/memory/**`, `packages/executor/src/memory/coarsen.ts`, `packages/executor/src/memory/links.ts`, `packages/executor/src/memory/dossiers.ts`, `packages/executor/src/memory/recall.ts`, `packages/executor/src/memory/preferences.ts`, `packages/executor/src/memory/bundle.ts`, `packages/routines/src/wave2/memory.ts`, `scripts/memory-bundle.ts`, `scripts/memory-restore.ts`, `apps/web/src/app/(app)/app/memory/**`, `apps/web/src/components/app/memory/**`, `packages/executor/test/memory/**`, `apps/api/test/memory-recall.test.ts`, `tests/scenarios/gp12-*.test.ts`
- Existing files: `packages/executor/src/memory/store.ts`, `packages/executor/src/memory/commands.ts`, `packages/executor/src/memory/seed-content.ts`, `packages/executor/src/timeline.ts`, `apps/api/src/routes/memory.ts`, `packages/agent/src/context.ts`, root `package.json` (the two memory scripts only)
- The `dossiers` and `memory_recalls` tables are an index and a recall log; dossier bodies live in the memory git repo.
- Task agents (`openChildRun`) only if items 1 to 4 are done and green.

### w2-providers-sandbox: local provider, Claude provider, code.run

Owns:
- New: `packages/agent/src/providers/chat-completions.ts`, `packages/agent/src/providers/claude.ts`, `packages/agent/test/providers/**` (with recorded request snapshots under `packages/agent/test/providers/__snapshots__/`), `packages/executor/src/sandbox/**`, `packages/executor/test/sandbox/**`
- Existing files: `packages/agent/src/providers/factory.ts`, `packages/agent/package.json`, `packages/executor/package.json`, `packages/executor/src/index.ts` (`createSandbox` only), `packages/executor/src/builtins.ts` (the `code.run` command only), `docs/models.md`, `pnpm-lock.yaml` (this track is the only one that adds dependencies; others ask through contract requests)
- Claude provider is written only from the bundled claude-api docs (model `claude-opus-5-5`, adaptive thinking, explicit effort, server-side fallbacks "default") and tested against recorded request snapshots; there is no Anthropic key. The local provider is tested with a fake HTTP server; a brief smoke test against the 1.7B GGUF on llama-server is allowed, the 27B model never.

### w2-reliability: gate report items

Owns:
- Existing files: `apps/api/src/compose.ts`, `apps/api/src/scheduler.ts`, `packages/agent/src/runtime.ts`, `packages/agent/src/loop.ts`, `packages/agent/src/store.ts`, `packages/agent/src/queue.ts`, `packages/agent/src/prompts/index.ts`, `packages/routines/src/engine.ts`, `packages/grounding/src/**`, `evals/**`, `apps/api/src/routes/stats.ts`, `apps/api/src/routes/agent.ts` (except `createChatContextSource`'s recall line), `apps/web/src/components/app/runs/**`, `apps/web/src/components/app/payroll/**`, `apps/web/src/components/app/home/**`, `apps/web/src/components/app/shell/**`, `apps/web/src/components/app/agent/**`, `research/product.md`, `research/agent.md`, `docs/review-log.md`, `docs/status.md`
- New: `apps/api/test/close.test.ts`, `packages/agent/test/restart.test.ts`, `packages/grounding/test/**`

## Track acceptance and cut lines

Every track also passes `pnpm test`, `pnpm typecheck`, `pnpm lint:prose` and `pnpm lint:brand` on its branch rebased onto main, plus the wave 1 e2e specs that touch its screens.

| Track | Acceptance | Cut line (finish this well if time runs short) |
|---|---|---|
| w2-onboarding | Offer create, send, view, accept, void, expire with illegal transitions refused; invite in the email simulator; portal as the new hire persona with the 7-item checklist and counter; click-to-sign with signer, timestamp and sha256 in `signatures` and the action row; W-4 writes `tax_profiles`; state form for CA, NY, CO and none for TX; ABA checksum refusal and bank simulator verification; I-9 upload stored under the data dir, masked in every API response; benefits election writes enrollments; checklist complete turns the worker active and the next draft pays them; document library tabs; `rt_onboarding_nudge`; GP6, GP7, GP8 scenario tests; e2e GP6 and GP7 | Offer lifecycle, sign offer and confidentiality, W-4, direct deposit and the payroll unblock (GP6 and GP7 without I-9 upload, benefits election or the nudge routine), recorded in `left.md` |
| w2-offboarding | `POST /v1/workers/:id/terminate` opens a case with the eight ordered steps; final pay, directory suspend, SSO deactivation and device lock are proposals, the rest run directly; every step audited; COBRA notice in the email simulator; case completes; off-cycle proposal with mid-period raise proration and a supplemental-rate bonus; GP9 and GP10 scenario tests; e2e GP9 | Termination case with the proposals and IDP suspend, plus the final pay proposal (no device lock, COBRA or off-cycle) |
| w2-benefits-contractors | Carrier simulator invoice for a month with planted errors; reconciliation finds terminated-but-billed, missing dependent and wrong tier with billed, expected and deducted cents; findings in the Benefits screen; open enrollment list and chase routine; contractor payouts through the fixed FX table and the rail simulator with pending, sent and delivered on the sim clock; GP11 scenario test | Reconciliation and its findings API with the three planted errors (no open enrollment chase, no rail UI) |
| w2-memory | research/harness.md section 18 tests: coarsening is idempotent per period, wiki-links resolve and backlinks are maintained, dossiers and the one-pager refresh from sources, recall stays within `RECALL_BUDGET` and is logged in `memory_recalls`, tainted content never enters a dossier and tainted hits taint the run, preferences update from decisions, a bundle round-trips; search expands aliases and wiki-links beyond fixed strings; GP12 scenario test | Coarsening, wiki-links and recall at run start (items 1, 2 and 4), with dossiers, preferences, bundles and the browser in `left.md` |
| w2-providers-sandbox | `WEFT_LLM=mlx` and `llama` through an OpenAI-compatible chat-completions provider (tools, reasoning off, strict JSON args) tested against a fake server; Claude provider from the bundled docs with recorded request snapshots; `code.run` on quickjs-emscripten behind `SandboxEngine` with the default limits and the `weft.call` RPC through the executor, read-only commands only, tainted results propagated | Chat-completions provider plus the Claude snapshot tests (sandbox stays a stub) |
| w2-reliability | `weft.close()` drains in-flight routine finalization and catches background write rejections (no unhandled CLIENT_CLOSED); waiting routine runs keep trigger and handle across an API restart; live L3 logs tool calls and new action rows, no stray write on a read-only question, steps within the cap (at most about $0.25 live); run steps and paycheck tables do not clip at 1440 px with the agent panel docked; Headcount tile counts active employees and labels onboarding separately; scripted runs never read (live); grounding no longer treats short strings with spaces as identifiers; the quoted reference marketing lines in research/product.md and research/agent.md paraphrased | close() drain and the restart survival, plus the three UI label and layout fixes |

## Deferred past wave 2

Expenses, Time Off and Settings screens; WA, IL, FL payroll, NY Method III, CA supplemental beyond the federal supplemental bonus path, bank holidays, multiple rates per period beyond the off-cycle proration, failed-run retry; `GET /v1/agent/runs/:id/artifacts/:ref`; the microVM and Worker Loader sandbox engines; task agents if w2-memory runs short.
