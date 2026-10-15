# Status

Snapshot of the foundation build. The integrator updates this file at the end of integration; until then it reflects the t6-site branch after Round 1 (2026-10-15).

## Works today

- `pnpm dev`: API and web on 127.0.0.1 after lsof port checks, first-run seed, each service in its own process group with a guard, clean stop on Ctrl+C or when the runner is killed.
- `pnpm lint:prose` and `pnpm lint:brand` (name and domains, phrase denylist, byte-identical copies of reference files, reference font names).
- `pnpm e2e`: the harness starts `scripts/dev.ts --e2e`, waits for health through the web proxy, warms the pages, resets the world before every test, runs one worker, and stops both process groups. The landing page specs and the dev runner specs (Ctrl+C and a SIGKILLed runner both leave no listener and no process) pass.
- The landing page `/` with original copy and art (hero, simulators marquee, product grid, how it works, agent island, stats, CTA band, footer), stats from `GET /v1/stats` with a labeled seed fallback, the simulated clock from `GET /v1/health`, no horizontal scroll at 390 px.
- Docs: README quickstart, architecture, API, simulators, models (providers, spend caps, live gate, sandbox and Cloudflare Workers Free decision).

## Golden paths (E2E)

| Path | Spec | State after Round 1 | Waiting on |
|---|---|---|---|
| GP1 tax notice to rate change | `e2e/gp1-tax-notice.spec.ts` | red at reset | `POST /v1/sim/reset` and the governance seed (T2, T3), then the notice scenario, agency routine, inbox and audit screens |
| GP2 pre-payroll review and run | `e2e/gp2-payroll-run.spec.ts` | red at reset | payroll engine and lifecycle (T1), pre-payroll routine (T4), payroll screen (T5) |
| GP3 new hire in a new state | `e2e/gp3-new-hire.spec.ts` | red at reset | offer accept, registrations, IT simulators (T2), new hire routine (T4), people and compliance screens (T5) |
| GP4 routine on schedule | `e2e/gp4-routine-schedule.spec.ts` | red at reset | routines engine and draft parser (T4), Simulators and Routines screens (T5) |
| GP5 agent and guardrails | `e2e/gp5-agent-guardrails.spec.ts` | red at reset | agent runtime and scripted chat (T4), taint and proposals (T3), agent panel (T5) |

## Left (known)

- Drive GP1 to GP5 to green after merge 1 and merge 2; reconcile the spec assumptions listed in `docs/tracks/t6-site.md`.
- Integrator config: `agentRules: false` in `apps/web/next.config.ts` (next dev writes `apps/web/AGENTS.md`), decide which `next-env.d.ts` form to track, add a `typecheck:e2e` root script.
- Landing page cut items (P1): routine showcase with autoplay list, run log block, mega menu, `/agent` page.
- P1 items from `SPEC.md` 1.2: Claude and local providers, `code.run` on QuickJS-WASM, the hosted Cloudflare tier, MCP over Streamable HTTP, benefits reconciliation, offboarding, contractor payments, signed webhooks, quarterly filings.
