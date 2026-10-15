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
