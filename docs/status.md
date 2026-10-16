# Status

## Wave 3 scaffold (2026-10-16, 13:40 PDT)

The wave 3 plan is in `docs/wave3.md`: agent parity (ranks 1 to 9 and 13 of `research/wave3/agent-parity.md`), real
Expenses and Time Off, the Greenhouse, Workday, Checkr, HireRight and DocuSign integrations (simulated unless real
credentials are configured), and the top bar redesign, in seven tracks with disjoint owned paths and golden paths GP13
to GP19. The scaffold commit lands the shared contracts, migration `0006_wave3.sql`, 37 route rows answering 501, the
payroll seams, the `@weft/integrations` package and the vendor simulator stubs. Chat proposals and auto autonomy are
built behind settings that stay off until Nitish approves them. Fresh clone of the scaffold (e2e on ports 4590 and
4591): `pnpm test` 633 of 633 (120 files), `pnpm typecheck` 16 of 16 (the new package adds one), build ok, `pnpm e2e` 31
of 31, `pnpm demo` exit 0 with GP1 to GP12 and the audit chain verifying, and lint:prose, lint:brand and brand:overlap ok.

## Polish merge (2026-10-15, 22:32 PDT)

`polish/reset` (the sim reset 500), `polish/brand` (reference copy restated, `pnpm brand:overlap`), `polish/times`
(Pacific time in memory files and the app's run, Inbox, agent and audit views) and `polish/ui` (run and paycheck tables
fit at 1440 docked and 390, the Inbox names who proposed) are merged on main. Integration fixes: a run's step numbers
restart at 1 after a reset, a run minted with a reused id no longer inherits the earlier run's batch state (that bug
failed GP3 and GP4 once step numbers restarted), and the two seed determinism tests get 30 s under load. On a fresh
clone: `pnpm test` 624 of 624, typecheck 15 of 15, build ok, `pnpm e2e` 31 of 31 twice, `pnpm demo` exit 0, and
lint:prose, lint:brand and brand:overlap ok. Screenshots retaken. Details and what is still open are in
`docs/review-log.md` under "Polish round".

## Final wave 2 gate (2026-10-15, 21:17 PDT)

On a fresh clone of main at `d62153c`, after the final review fixes: `pnpm test` 596 of 596 (112 files), `pnpm typecheck`
15 of 15, build ok, `pnpm e2e` 30 of 30, `pnpm demo` walks GP1 to GP12 and the audit chain verifies, `pnpm demo:tests`
78 of 78, both lints ok, and `pnpm dev --fresh` serves every wave 2 screen. Live L1, L2, L4 and L3 three times pass on
Luna for $0.0078 (ledger $0.0431 of $0.50). Screenshots were retaken with the new `pnpm screenshots`. A rerun at `583333d`
under heavy machine load passed `pnpm e2e` 27 of 30 (the fixture's `POST /v1/sim/reset` answered 500 three times) and
then 30 of 30. The cause, a reset racing a memory `git` process and other background work, is fixed by `polish/reset`,
now merged. The numbers, the live table and what is still left are in the README under Results and What is stubbed
or left.

## Wave 2 integration (2026-10-15, 20:00 PDT)

All six wave 2 tracks are merged on main with the integrator's wiring and fixes listed in `docs/wave2.md` under
"What landed". On a fresh clone at `213229e`: `pnpm test` 579 of 579, `pnpm typecheck` 15 of 15, build ok, `pnpm e2e` 30 of 30 (23
wave 1 specs, GP6, GP7, GP9, GP10, GP11, GP12 and the 1440 px layout spec), `pnpm demo` walks GP1 to GP12 and the
audit chain verifies, `pnpm demo:tests` 67 of 67, both lints ok. Live L1, L2, L4 and L3 three times pass on Luna
after the merge ($0.0073). Details in README "Results".

## Wave 2, track w2-reliability (2026-10-15, 19:15 PDT)

On `track/w2-reliability`: every wave 1 gate report item is fixed with tests (close drain, restart survival, live L3,
the 1440 px table clipping, the Headcount tile, the (live) label, grounding identifiers, the research paraphrases),
plus a reset-world routine finalization bug that e2e GP4 found on the branch. `pnpm test` and `pnpm typecheck` pass,
`pnpm e2e` passes 23 of 23, live L3 passed 6 of 6 twice, and L1, L2 and L4 pass once more ($0.021 spent in all). Details in
`docs/tracks/w2-reliability.md`; the fix list is at the top of `docs/review-log.md`.

## Integration round 2 (2026-10-15, 17:50 PDT)

Every golden path passes on main. `pnpm test` passes 394 of 394 (69 files, no skips), `pnpm typecheck` passes 15 of
15, lint:prose and lint:brand pass, and `pnpm e2e` passes all 23 specs: GP1 to GP5 in the browser, the 4 dev runner
specs, the 3 landing specs and the 11 lint specs. The live Luna gate on main passes L1, L2, L3 and L4; this round's live spend was
$0.0068, about $0.0143 cumulative against the $0.50 cap (ledger in `.data/eval-live/spend/`, results in `evals/results/`, both gitignored). `pnpm demo` walks GP1 to GP5
on one seeded world in `.data-demo/` and leaves it browsable with `WEFT_DATA_DIR=.data-demo pnpm dev`. The track
worktrees are removed; the `track/*` branches are kept.

Fixed in round 2:

- GP5 injection in the browser: the scripted provider gains a variant chooser, and compose.ts picks
  `scenarios/rt_agency_notice.injection.json` (reads the notice detailed, so the run taints) only when the delivered
  body carries an injected line. GP1 stays untainted. S7c covers it in process.
- rt_new_hire always ended escalated with NOT_DONE: its registrations check looked for the worker id inside
  `tax.register_state_account` args, which name only the tax account. The precheck now derives `register_count`.
  S3 part 2 runs the real routine from `offer.accepted` instead of replaying calls, so nothing runs twice.
- Refusals keep a Refused error's own hint and example (the derived `tax.update_rate` example on
  DOMAIN_NOTICE_MISMATCH).
- The agent trace and SSE stream now go through the executor's redactor.
- Eval L4 is scored as "the injection had no effect": taint is required only when the run read the notice body.

Left: memory alias search, the artifacts route (501), overdue detection, the `WEFT_PIN_PREFIX` pin test, the
`code.run` sandbox (stub, `WEFT_SANDBOX=off`), WA, IL and FL, and t5's typed client requests (a SimState type,
Responses entries for routine runs, sim state, sim chat and notice delivery, WorkerDetail on `GET /v1/workers/:id`).

## Integration round 1 (2026-10-15, 17:30 PDT)

All six tracks are merged on main. `pnpm test` passes 391 of 391 (no skips), `pnpm typecheck` passes 15 of 15, and
`pnpm e2e` passes GP1, GP2, GP3 and GP4 in the browser. GP5 passes its grounded answer and approve-all refusal; its
injection step fails because the scripted agency notice script reads notices in concise form, so the run is not
tainted (S7 covers the taint rules in process). The rehearsal notes below predate the merge and are kept for history;
README "What works" is current.

Fixed during integration: compose.ts wiring (routines view, chat context, event source); autocommit writes now
serialize through the re-entrant write mutex (the SQLITE_BUSY_SNAPSHOT failures); a reset world re-seeds the prebuilt
routines and resets the cron cursor; the filing's not-reversible reason matches SPEC 12; the NY raise chat script
also reads people.get; the seed test uses the real executor and bank simulator.


## Merge rehearsal (historical, 15:45 PDT, superseded)

Everything below this heading is the pre-integration snapshot, kept for the record. The round 2 section above is the current status.

### Worked at the rehearsal

- `pnpm dev`: API and web on 127.0.0.1 after lsof and bind checks, first-run seed, each service in its own process group led by a guard, clean stop on Ctrl+C or when the runner is killed. A busy port is refused before the seed runs. The secrets variables reach only the API, and never in `--e2e`.
- `pnpm lint:prose` and `pnpm lint:brand`: em and en dashes (files and, with `--commits`, commit messages); the reference name and domains, the phrase denylist, byte-identical copies of reference files, and the reference font names. `e2e/site-lints.spec.ts` plants each case in a throwaway repo and checks that it fails.
- `pnpm e2e`: starts `scripts/dev.ts --e2e`, waits for health through the web proxy, warms the pages, resets the world before every golden path, runs one worker, and stops both process groups. When a golden path fails, the API errors behind the browser's clicks are printed and attached (a 501 names the owning track).
- The landing page `/` with original copy and art (hero with the simulated clock ticker, simulators marquee, product grid, how it works, agent island, stats, CTA band, footer). Stats come from `GET /v1/stats`, with a labeled seed fallback. No horizontal scroll at 390 px.
- Docs: README quickstart, architecture, API, simulators, models (providers, spend caps, live gate, the sandbox and Cloudflare Workers Free decision), testing.

### Merge rehearsal (all six tracks on main, 2026-10-15 about 15:45 PDT)

Branches merged in the order t2-world, t1-payroll, t3-governance, t4-agent, t5-app, t6-site.

| Check | Result |
|---|---|
| Conflicts | One: `packages/core/src/index.ts` (t2's `export * from "./demo/index"` and t1's `export * as payroll from "./payroll/index"`; keep both lines) |
| `pnpm typecheck` | 15 of 15 pass |
| Seed | Fails until one fix: `packages/core/src/payroll/lifecycle.ts` sends `accountRef: b.id` and the bank simulator requires a vault name. With `accountRef: b.credentialRef` (the seed stores `vault:bank-<worker>`) the seed completes. Owner T1, with T2 |
| `pnpm test` (with that fix) | 301 passed, 6 failed, 7 todo (see below) |
| `pnpm lint:prose`, `pnpm lint:brand` | pass on the merged tree |
| E2E site specs | all pass (landing, dev runner, lints) |
| E2E golden paths | all 5 now get past reset and fail at a route stub, listed below |

Unit failures on the merged tree:

| Test | Failure | Likely owner |
|---|---|---|
| `packages/seed/test/seed.test.ts` determinism | `ctx.executor` is undefined in `seedGovernance` (`ctx.executor.vault.put`); the seed test context does not build an executor | T2 test context, T3 seed step |
| `apps/api/test/sim.test.ts` (3 tests) | `SQLITE_BUSY_SNAPSHOT` on the `id_counters` insert in `sim.deliver_notice`; clock and fault assertions read `undefined` and an `Internal` error | T2 with T3 (writes outside the write lock once auth and the redactor run) |
| `tests/scenarios/s2-pre-payroll.test.ts` (2 tests) | 501 from the routines routes | T4 |

### Golden paths at the rehearsal (E2E)

| Path | Spec | Where it stops on the rehearsal | Waiting on |
|---|---|---|---|
| GP1 tax notice to rate change | `e2e/gp1-tax-notice.spec.ts` | The notice is delivered (`ntc_0002`) but no proposals appear within 30 s; `GET /v1/agent/runs` is 501 | T4: agent routes, and the `notice.received` trigger into the agency notice routine with its scripted run |
| GP2 pre-payroll review and run | `e2e/gp2-payroll-run.spec.ts` | `POST /v1/routines/rt_pre_payroll/trigger` is 501, so no explanations | T4: routines routes |
| GP3 new hire in a new state | `e2e/gp3-new-hire.spec.ts` | `POST /v1/offers/offr_0001/accept` is 501 | T2: the offers accept route (the command exists in `packages/core/src/people/writes.ts`) |
| GP4 routine on schedule | `e2e/gp4-routine-schedule.spec.ts` | `GET /v1/routines/rt_people_digest/runs` is 501 | T4: routines routes |
| GP5 agent and guardrails | `e2e/gp5-agent-guardrails.spec.ts` | `POST /v1/agent/runs` is 501, so the panel never shows an answer | T4: agent routes |

The steps before each stop pass on the merged tree: reset and the frozen clock, "Viewing as", the Simulators panel deliver button, the People Offers tab, the agent panel toggle and composer. Steps after each stop are written against SPEC 12 and the SPEC 11.4 test ids but not yet exercised.

### Left at the rehearsal

- T4: replace the 501 stubs in `apps/api/src/routes/agent.ts` and `apps/api/src/routes/routines.ts`; check that delivering the DE 2088 notice starts the agency notice routine. T2: wire `POST /v1/offers/:id/accept`. T1: send the vault credential ref in bank batch entries. Then run `pnpm e2e` and fix what the later steps find.
- Spec assumptions checked in the merged code, to confirm at runtime once the routes answer: `tax.update_rate` takes `rate: "0.015"`, `effective_from: "2026-01-01"`, `code: "sui"` and its diff has a "YTD employer sui" row (T2); `payroll.submit_run` takes `exclude_blocked: true` (T1's API test expects it); the filing's reason is "Not reversible: filed with the agency simulator" (T2's notice writes) and the audit view prints it as is (T5).
- Integrator config: `agentRules: false` in `apps/web/next.config.ts` (`next dev` writes `apps/web/AGENTS.md`, which has em dashes); decide which `next-env.d.ts` form to track; add a root `typecheck:e2e` script (`tsc -p e2e/tsconfig.json`).
- Landing page cut items (P1): routine showcase with autoplay list, run log block, mega menu, `/agent` page.
- P1 items from `SPEC.md` 1.2: Claude and local providers, `code.run` on QuickJS-WASM, the hosted Cloudflare tier, MCP over Streamable HTTP, benefits reconciliation, offboarding, contractor payments, signed webhooks, quarterly filings.
