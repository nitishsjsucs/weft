# Testing

Three layers, from fastest to slowest. None of them calls a live model: the provider factory refuses unless `WEFT_LIVE_OPENAI=1`, and the live gate is a separate command (see `docs/models.md`).

| Command | What runs | Typical time |
|---|---|---|
| `pnpm test` | Vitest projects under `packages/*`, `apps/*` and `tests/` (unit, contract and scenario tests on in-memory SQLite) | seconds |
| `pnpm typecheck` | `tsc --noEmit` in every workspace package through turbo | seconds |
| `pnpm lint:prose`, `pnpm lint:brand` | No em or en dashes; no reference-site name, domains, denylisted phrases, copied files or font names | about a second each |
| `pnpm brand:overlap` | No run of 8 or more consecutive words shared with the saved reference pages' visible text (`scripts/brand-overlap.ts`; allowlist `scripts/brand-overlap.allow.txt`, kept empty); skipped when the reference folder is absent. `pnpm brand:overlap -- --words 6` lowers the run length for a one-off look at near-verbatim fragments | about a second |
| `pnpm e2e` | Playwright: the golden paths GP1 to GP5 plus the site specs, against `scripts/dev.ts --e2e` | a few minutes |

`e2e/` is not a workspace package, so `pnpm typecheck` does not cover it. Check it with `pnpm exec tsc -p e2e/tsconfig.json`, which also covers `playwright.config.ts` and the root scripts.

## The E2E run

`pnpm e2e` starts `scripts/dev.ts --e2e`: a fresh seed in `.data-e2e/`, the scripted provider, a frozen clock (rate 0) at the seed time, web on 3170 and API on 4170, both on 127.0.0.1 after lsof port checks. Playwright waits for `/api/v1/health` through the web proxy, `e2e/global-setup.ts` warms every app page (so first compiles do not eat test time), then the specs run one at a time with one worker. On teardown Playwright sends SIGTERM to the runner, which stops both process groups. One checkout runs one web dev server: Next 16 allows a single `next dev` per app directory, so the runner refuses to start (before seeding) when another `next dev` is running in `apps/web`; run a second suite from a separate clone. On stop the runner restores `apps/web/next-env.d.ts`, which `next dev` rewrites.

Before every golden path test the `freshWorld` fixture calls `POST /v1/sim/reset` and checks the clock is back at `2026-10-26T15:30:00.000Z` with rate 0. Specs drive the browser for every action a person takes and use the API (through the same proxy) only to read exact values back.

| Spec | Covers |
|---|---|
| `gp1-tax-notice.spec.ts` | GP1: DE 2088 notice, two proposals, approve both, rate history, preview, audit chain, Undo |
| `gp2-payroll-run.spec.ts` | GP2: pre-payroll explanations, the blocked line, submit proposal approved by Theo, run processed |
| `gp3-new-hire.spec.ts` | GP3: Noor's offer accepted, accounts and device, CO registration, first payroll unblocks |
| `gp4-routine-schedule.spec.ts` | GP4: the digest fires once at 09:00, a drafted routine stays disabled |
| `gp5-agent-guardrails.spec.ts` | GP5: grounded answer, refused approve-all, injected notice stays a proposal |
| `site-landing.spec.ts` | `/`: original copy, stats with a source, license footer, no horizontal scroll at 390 px |
| `site-dev-runner.spec.ts` | Ctrl+C and a SIGKILLed runner leave no listener and no process |
| `site-lints.spec.ts` | Each lint rule fails on a planted case in a throwaway repo; both lints pass on the real repo |

Useful variations:

```sh
pnpm e2e e2e/gp3-new-hire.spec.ts                          # one spec
WEFT_E2E_WEB_PORT=4210 WEFT_E2E_API_PORT=4211 pnpm e2e     # other ports (check them with lsof first)
WEFT_E2E_RUNNER_PORT=4216 pnpm e2e e2e/site-dev-runner.spec.ts
WEFT_E2E_PRINCIPAL_DANA=usr_x pnpm e2e                     # if the governance seed renames a principal
```

## Reading a failure

- A golden path that waits on a result fails as a 30 second timeout. The `apiErrors` fixture records every 4xx and 5xx `/api` response the browser saw; when a test fails it prints them under the failure and attaches `api-errors.txt`. A 501 names the track that still owns the stub, for example `POST /v1/offers/offr_0001/accept -> 501: ... (t2-world)`.
- Reads through the `weft` client throw with the method, path, status and the first 300 characters of the body.
- Every failure keeps a trace: `pnpm exec playwright show-trace test-results/<test>/trace.zip`. `error-context.md` next to it has the page snapshot at the moment of failure.

## Rehearsing a merge

To see how far the golden paths get before the real merge, rehearse it in a throwaway clone, never in a track worktree:

```sh
git clone -q ~/Developer/projects/weft /path/to/scratch/integ && cd /path/to/scratch/integ
for b in t1-payroll t2-world t3-governance t4-agent t5-app t6-site; do git fetch -q origin "track/${b}:track/${b}"; done
git checkout -q -b rehearsal main
for b in t2-world t1-payroll t3-governance t4-agent t5-app t6-site; do git merge --no-edit -q "track/${b}" || break; done
pnpm install --frozen-lockfile && pnpm typecheck
WEFT_E2E_WEB_PORT=4210 WEFT_E2E_API_PORT=4211 pnpm exec playwright test
```

Write `${b}` with braces: in zsh `$b:t` is a path modifier, so `"$b:track"` silently becomes something else. The results of the last rehearsal are in `docs/status.md`.
