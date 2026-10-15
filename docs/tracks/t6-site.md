# Track t6-site notes

Owner paths: `apps/web/src/app/(marketing)/**`, `apps/web/src/components/marketing/**`, `apps/web/public/brand/**`, `e2e/**`, `playwright.config.ts`, `scripts/dev.ts`, `scripts/check-prose.ts`, `scripts/check-brand.ts`, `docs/**`, `README.md`.

## Round 1 (2026-10-15, from 15:09 PDT)

Done:

- `scripts/dev.ts`: lsof plus bind probe on both ports, each service in its own process group led by a guard process (the guard kills its group if the runner dies, even on SIGKILL), SIGINT, SIGTERM and SIGHUP stop both groups (SIGTERM, wait for the groups to empty, then SIGKILL). Secrets (`WEFT_SECRETS_FILE`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) reach only the API and never in `--e2e`. `--e2e` reseeds `.data-e2e`, forces `WEFT_LLM=scripted` and `WEFT_CLOCK_RATE=0`, ports 3170 and 4170. Seeds automatically when the data dir has no database; `--fresh` reseeds; `--api-only`.
  Verified: Ctrl+C (SIGINT to the foreground group) and a SIGKILLed runner both leave nothing listening (`lsof -nP -iTCP:<port> -sTCP:LISTEN` empty, no process left in either group).
- `scripts/check-prose.ts`: em and en dashes in tracked and untracked-not-ignored text; `--commits main..HEAD` also checks commit messages.
- `scripts/check-brand.ts`: name and domains outside `research/`, `NOTICE`, `SPEC.md`; the phrase denylist (whitespace-normalized) across `apps/`, `packages/`, `docs/`, `e2e/`, `README.md`, with a warning when the file is absent; size plus sha256 comparison of every repo file against every reference file (catches copied screenshots, fonts, CSS); the reference font family names in `apps/` and `packages/`.
  Verified: a planted denylist phrase in `apps/web/src`, a copied reference screenshot in `public/brand`, and the banned domain in a root file each fail; the clean tree passes.
- E2E harness: `e2e/fixtures.ts` (auto fixture resets through `POST /v1/sim/reset` before every test and checks the clock is back at `2026-10-26T15:30:00.000Z` with rate 0; `WeftApi` over the web proxy; `viewAs`, `openAgentPanel`, `askAgent`, `approveCard`, `eventually`), `e2e/global-setup.ts` (warms the pages so first compiles do not eat test time), GP1 to GP5 specs. `playwright.config.ts`: `gracefulShutdown: SIGTERM` (Playwright's default SIGKILL of the shell's group would orphan the service groups), waits for `/api/v1/health` through the proxy, 30 s per wait, action and navigation, 120 s per golden path.
  Verified: `pnpm e2e` starts the runner, warms, runs 5 specs with 1 worker, and stops both groups. All 5 are red at the reset step until T2's `/v1/sim/reset` and T3's governance seed land (401 "Unknown human principal" today).
- Brand art in `public/brand/` generated from `components/marketing/art.ts` (`pnpm exec tsx apps/web/src/components/marketing/export-brand.ts`): weave mark, wordmark, woven bands (over and under by masking each crossing to the lower band's footprint), loom glyph field.

## Assumptions the specs make (please match, or tell t6-site)

| Area | Assumption | Owner |
|---|---|---|
| Principals | `usr_dana`, `usr_theo`, `usr_sam` (override with `WEFT_E2E_PRINCIPAL_DANA` and friends) | T3 seed |
| Reset | `POST /v1/sim/reset` returns `{ ok: true }` and puts the clock back at the seed time; the API keeps `rate` 0 under `WEFT_CLOCK_RATE=0` | T2 |
| Simulators panel | clock buttons `sim-advance-30m`, `sim-advance-1d`, `sim-advance-next`; chat feeds `chat-channel-people-ops` (the fixture also accepts `chat-channel-#people-ops`) | T5 |
| Tabs | Radix tabs with role `tab`: People "Offers"; Compliance "Registrations", "Rates", "Notices" | T5 |
| Compliance | both CO accounts render as `registration-row-CO`; rate rows use the contract code, `rate-row-CA-sui` | T5 |
| Inbox | `inbox-approve` and `inbox-tainted-banner` inside each `inbox-card-<id>`; banner text starts "This run read untrusted content" | T5 (matches today) |
| Audit | the filing row reads "Not reversible: filed with the agency simulator" and has no `audit-undo-<seq>` | T3, T5 |
| Payroll | group headers read "Needs Review (4)" and "Ready for Approval (44)", rows are `payroll-row-<workerId>` inside the group | T5 (matches today) |
| Agent panel | a button whose name contains "agent" opens it when collapsed; `agent-status` says "Working..." while running | T5 (matches today) |
| Command args | `payroll.submit_run` args include `exclude_blocked: true`; the tax.update_rate args contain `0.015`, `2026-01-01`, `sui` | T1, T2 |

## Contract and config requests (for the integrator)

1. `apps/web/next.config.ts`: add `agentRules: false`. `next dev` (16.4) writes `apps/web/AGENTS.md`, which contains em dashes; both lints skip that file only while it is untracked.
2. `apps/web/next-env.d.ts` is rewritten by `next dev` to point at `.next/dev/types`; restore it before committing or decide which form to track.
3. Root `package.json`: add `"typecheck:e2e": "tsc -p e2e/tsconfig.json"` (the e2e folder and the root scripts are not in any workspace package, so `pnpm typecheck` does not cover them).
