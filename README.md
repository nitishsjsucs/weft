# Weft

Weft is an open-source, self-hostable, AI-native payroll and HR platform: HRIS and onboarding, US payroll with multi-state tax, benefits, IT provisioning, global contractors, and the Weft agent, which does the admin work and asks a person before it acts. It also ships routines, an MCP server and a public API.

It runs on one fictional company and in-repo simulators, and it is meant to work end to end on a laptop.

## Quickstart

Requires Node 25.9.0 and pnpm 12.3.4. Nothing else: no Docker, no database server, no API key.

```sh
pnpm install
pnpm dev
```

`pnpm dev` checks that ports 4070 and 3070 are free, seeds `.data/` the first time (Larkspur Robotics (demo)), and starts the API on http://127.0.0.1:4070 and the web app on http://127.0.0.1:3070, each in its own process group. Open http://127.0.0.1:3070 for the landing page and http://127.0.0.1:3070/app for the demo. Ctrl+C stops both.

Useful flags: `pnpm dev --fresh` (reseed first), `pnpm dev --api-port 4075 --web-port 3075`, `pnpm dev --api-only`.

Things to try in the demo:

1. **Simulators**: deliver the "CA EDD DE 2088" notice. The agent drafts a SUI rate change and a reply to the agency; both wait in the **Inbox** for you.
2. **Payroll**: open the Oct 16 to 31 draft and click "Run review now". Four paychecks need review; the agent explains each one and proposes the submit.
3. **People**: mark Noor Castellanos (demo)'s offer accepted. New hire readiness creates accounts, posts a welcome, and proposes the Colorado registrations and a laptop.
4. **Routines**: advance the simulated clock 30 minutes and watch the weekly people digest run on schedule.
5. **Audit log**: every action is in a hash-chained log; reversible ones have Undo.

The "Viewing as" switcher in the header is a demo control for acting as Dana, Theo or Sam.

To see the golden paths run without a browser, `pnpm demo` seeds one world in `.data-demo/` and walks GP1 to GP5 in
about 3 seconds through the same HTTP routes the UI uses, with the scripted provider (it never spends money, whatever
`WEFT_LLM` says): the DE 2088 notice to an approved 1.5% rate, the grounded NY raise answer and the refused
approve-all, the pre-payroll review to an approved and then processed payroll, the 09:00 digest, the new hire's
Colorado registrations activating two business days later, and an injected notice that leaves only tainted
proposals. It ends by verifying the audit chain. Then browse that same world with
`WEFT_DATA_DIR=.data-demo pnpm dev`. `pnpm demo:tests` runs the golden path scenario tests instead, each on a fresh
world.

## Architecture

One API process (`apps/api`, Hono on 127.0.0.1:4070) hosts the REST API, the tool endpoint, SSE, the scheduler, agent
runs and every simulator. `apps/api/src/compose.ts` (`createWeft()`) is the only place that wires them together. The
web app (`apps/web`, Next 16) reaches it through an `/api` rewrite that adds the proxy secret, and the MCP server
(`apps/mcp`, stdio) is a thin client of `/v1/tools`.

- **Brain** (`packages/agent`, `packages/routines`): the model loop, providers (scripted, OpenAI Responses), budgets,
  the spend ledger and the routines engine. It holds only an opaque run handle and never imports domain code.
- **Hands** (`packages/executor`): every state change, from the agent, a person or a system principal, goes through
  one pipeline: strict schemas, risk tiers, taint, approvals as proposals, the hash-chained action log, rollback, the
  vault and redaction, and the git-backed memory repo.
- **Domain** (`packages/core`, `packages/payroll-tax`): commands, services and event handlers; the pure tax engine
  with versioned 2026 rate data.
- **World** (`packages/sim`, `packages/seed`): agencies, bank ACH, identity provider, devices and chat simulators, and
  the deterministic seed for Larkspur Robotics (demo).
- **Storage**: SQLite through libsql in `.data/weft.db`. Every write, autocommit or transaction, serializes through
  one in-process write mutex (`withWriteLock` in `packages/db`).

More in [docs/architecture.md](docs/architecture.md).

## What works

Verified on main on 2026-10-15 with the scripted provider (`pnpm test`: 394 passed, 0 failed; `pnpm e2e`: 23 passed),
and live on `gpt-5.6-luna` (L1 to L4 pass for $0.0068 in total):

| Golden path | Scenario test (`pnpm demo:tests`) | Browser test (`pnpm e2e`) | Live Luna (`pnpm eval:live`) |
|---|---|---|---|
| GP1 tax notice to rate change, approvals, undo | passes | passes | L1 passes (2 steps) |
| GP2 pre-payroll review, submit, processed | passes, plus STALE_SUBJECT and bank return variants | passes | L2 passes (5 steps) |
| GP3 new hire in a new state, through the real rt_new_hire run | passes | passes | |
| GP4 routine on schedule, run key dedupe, draft parser | passes | passes | |
| GP5 grounded chat, approve-all refused, injected notice tainted | passes | passes | L3 passes (2 steps); L4 passes |
| S7, S7b, S7c injection and taint carry | passes | | |
| S8 MCP stdio and REST with scoped keys | passes | | |

On L4 the live model worked from the parser's structured fields and never read the injected body, so its run is
untainted and nothing it did came from the injection; the scripted GP5 path plays a model that does read the body,
and that run is tainted with every write left as a proposal.

The payroll engine matches its golden cases to the cent; `pnpm db:reset && pnpm db:seed` gives the same digest every
time; the action chain verifies at the end of every scenario.

## What is stubbed or left

- `GET /v1/agent/runs/:id/artifacts/:ref` answers 501. Expenses, Time Off and Settings are labeled stubs; contractor
  payouts, charts and the landing page's routine showcase are P1.
- `code.run` is not on any allowlist and `WEFT_SANDBOX=off`: only the sandbox contract and the `createSandbox()` stub
  ship today.
- Not modeled in payroll: the stretch states WA, IL and FL, NY Method III, CA supplemental rates, bank holidays, more
  than one pay rate inside a period, retrying a failed run.
- Memory search is a plain fixed-string search (no alias expansion); recall at run start is P1.
- Track notes with the full lists live in `docs/tracks/`.

## Sandboxes and a free hosted option

Weft serves one fictional company, so it does not need a sandbox fleet. Locally the plan is QuickJS (MIT, through
`quickjs-emscripten`) inside the executor for `code.run`, with Anthropic's `sandbox-runtime` and `microsandbox` (both
Apache-2.0) as opt-in wrappers. Hosted, the design targets Cloudflare Workers Free: one SQLite-backed Durable Object
per company, Durable Object alarms for routines and the sandbox off. Cloudflare's Sandbox SDK, Containers and Dynamic
Workers need the paid plan; Dynamic Workers are the upgrade path. Details and the unverified limits are in SPEC 9.9 and
[docs/models.md](docs/models.md).

## Real models

The default provider is scripted and deterministic, so everything works offline. For real agent runs Weft uses OpenAI `gpt-5.6-luna` through the Responses API. Keep the key in a file outside the repo:

```sh
# $HOME/Developer/projects/.weft.secrets.env (outside the repo, never committed)
OPENAI_API_KEY=...

WEFT_LLM=openai WEFT_SECRETS_FILE=$HOME/Developer/projects/.weft.secrets.env pnpm dev
```

Spend is capped per run, per day and in total. See [docs/models.md](docs/models.md) for the provider matrix, the caps, the live gate and the sandbox and Cloudflare free-tier decision.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | API and web on 127.0.0.1 after port checks; Ctrl+C stops both process groups |
| `pnpm demo` | Narrated GP1 to GP5 on one seeded world in `.data-demo/`, scripted provider; browse it after with `WEFT_DATA_DIR=.data-demo pnpm dev` |
| `pnpm demo:tests` | The golden path scenario tests (GP1 to GP5, S7, S8) in process on fresh seeded worlds |
| `pnpm test` | All vitest projects (scripted provider only) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm e2e` | Playwright golden paths GP1 to GP5 and the site specs against a fresh seed on ports 3170 and 4170, one worker, reset before each test ([docs/testing.md](docs/testing.md)) |
| `pnpm lint:prose` | No em or en dashes in tracked text (`pnpm lint:prose --commits main..HEAD` also checks commit messages) |
| `pnpm lint:brand` | No reference-site names, domains, denylisted phrases or copied reference files |
| `pnpm db:reset && pnpm db:seed && pnpm db:digest` | Rebuild the world and print its digest (stable across runs) |
| `pnpm eval:live` | Live Luna gate, opt-in (see docs/models.md) |

## Synthetic data only

Weft runs on one fictional company, Larkspur Robotics (demo), with 48 synthetic employees and 3 contractors. Every government agency, bank, benefits carrier and SaaS integration is a simulator inside this repo ([docs/simulators.md](docs/simulators.md)); no real agency, bank or carrier is ever contacted and no real money moves. Names of record end with `(demo)` and every domain is `*.example`.

## Docs

- [docs/architecture.md](docs/architecture.md): processes, packages, the brain and hands split, the simulated clock
- [docs/api.md](docs/api.md): the `/v1` API, auth, paging and errors
- [docs/simulators.md](docs/simulators.md): what each simulator does and how to drive it
- [docs/models.md](docs/models.md): providers, spend caps, the live gate, sandboxes
- [docs/testing.md](docs/testing.md): unit, lint and E2E layers, reading a failed golden path, rehearsing a merge
- [docs/status.md](docs/status.md): what works today and what is left
- `SPEC.md`: the foundation spec; `AGENTS.md`: rules for anyone building here

## Brand

Weft mirrors the layout conventions of a commercial payroll product's public site with its own name, original copy, original SVG art (generated from `apps/web/src/components/marketing/art.ts`), the madder accent (`#d6264b`) and the open-licensed Inter and JetBrains Mono fonts. It uses no third-party logos, testimonials or marketing copy.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. Weft contributors.
