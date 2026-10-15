# Status

Snapshot of the foundation build on 2026-10-15. The integrator updates this file at the end of integration. Until then it reflects the t6-site branch after Round 2, plus a merge rehearsal of all six track branches done in a throwaway clone (see `docs/testing.md`, "Rehearsing a merge").

## Works today

- `pnpm dev`: API and web on 127.0.0.1 after lsof and bind checks, first-run seed, each service in its own process group led by a guard, clean stop on Ctrl+C or when the runner is killed. A busy port is refused before the seed runs. The secrets variables reach only the API, and never in `--e2e`.
- `pnpm lint:prose` and `pnpm lint:brand`: em and en dashes (files and, with `--commits`, commit messages); the reference name and domains, the phrase denylist, byte-identical copies of reference files, and the reference font names. `e2e/site-lints.spec.ts` plants each case in a throwaway repo and checks that it fails.
- `pnpm e2e`: starts `scripts/dev.ts --e2e`, waits for health through the web proxy, warms the pages, resets the world before every golden path, runs one worker, and stops both process groups. When a golden path fails, the API errors behind the browser's clicks are printed and attached (a 501 names the owning track).
- The landing page `/` with original copy and art (hero with the simulated clock ticker, simulators marquee, product grid, how it works, agent island, stats, CTA band, footer). Stats come from `GET /v1/stats`, with a labeled seed fallback. No horizontal scroll at 390 px.
- Docs: README quickstart, architecture, API, simulators, models (providers, spend caps, live gate, the sandbox and Cloudflare Workers Free decision), testing.

## Merge rehearsal (all six tracks on main, 2026-10-15 about 15:45 PDT)

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

## Golden paths (E2E)

| Path | Spec | Where it stops on the rehearsal | Waiting on |
|---|---|---|---|
| GP1 tax notice to rate change | `e2e/gp1-tax-notice.spec.ts` | The notice is delivered (`ntc_0002`) but no proposals appear within 30 s; `GET /v1/agent/runs` is 501 | T4: agent routes, and the `notice.received` trigger into the agency notice routine with its scripted run |
| GP2 pre-payroll review and run | `e2e/gp2-payroll-run.spec.ts` | `POST /v1/routines/rt_pre_payroll/trigger` is 501, so no explanations | T4: routines routes |
| GP3 new hire in a new state | `e2e/gp3-new-hire.spec.ts` | `POST /v1/offers/offr_0001/accept` is 501 | T2: the offers accept route (the command exists in `packages/core/src/people/writes.ts`) |
| GP4 routine on schedule | `e2e/gp4-routine-schedule.spec.ts` | `GET /v1/routines/rt_people_digest/runs` is 501 | T4: routines routes |
| GP5 agent and guardrails | `e2e/gp5-agent-guardrails.spec.ts` | `POST /v1/agent/runs` is 501, so the panel never shows an answer | T4: agent routes |

The steps before each stop pass on the merged tree: reset and the frozen clock, "Viewing as", the Simulators panel deliver button, the People Offers tab, the agent panel toggle and composer. Steps after each stop are written against SPEC 12 and the SPEC 11.4 test ids but not yet exercised.

## Left (known)

- T4: replace the 501 stubs in `apps/api/src/routes/agent.ts` and `apps/api/src/routes/routines.ts`; check that delivering the DE 2088 notice starts the agency notice routine. T2: wire `POST /v1/offers/:id/accept`. T1: send the vault credential ref in bank batch entries. Then run `pnpm e2e` and fix what the later steps find.
- Spec assumptions checked in the merged code, to confirm at runtime once the routes answer: `tax.update_rate` takes `rate: "0.015"`, `effective_from: "2026-01-01"`, `code: "sui"` and its diff has a "YTD employer sui" row (T2); `payroll.submit_run` takes `exclude_blocked: true` (T1's API test expects it); the filing's reason is "Not reversible: filed with the agency simulator" (T2's notice writes) and the audit view prints it as is (T5).
- Integrator config: `agentRules: false` in `apps/web/next.config.ts` (`next dev` writes `apps/web/AGENTS.md`, which has em dashes); decide which `next-env.d.ts` form to track; add a root `typecheck:e2e` script (`tsc -p e2e/tsconfig.json`).
- Landing page cut items (P1): routine showcase with autoplay list, run log block, mega menu, `/agent` page.
- P1 items from `SPEC.md` 1.2: Claude and local providers, `code.run` on QuickJS-WASM, the hosted Cloudflare tier, MCP over Streamable HTTP, benefits reconciliation, offboarding, contractor payments, signed webhooks, quarterly filings.
