# Weft

Weft is an open-source, self-hostable, AI-native payroll and HR platform: HRIS and onboarding, US payroll with multi-state tax, benefits, IT provisioning, global contractors, and the Weft agent, which does the admin work and asks a person before it acts. It also ships routines, an MCP server and a public API.

## Status

Foundation build in progress (2026-10-15). The monorepo, shared contracts, database schema and migrations, test harness and app shells exist; the domain, payroll engine, executor, agent and screens are being built in parallel tracks. `GET /v1/health` lists the parts that still answer `NotImplemented`. See `SPEC.md` for scope and `docs/status.md` (written at the end of the build) for what is left.

## Quickstart

Requires Node 25.9.0 and pnpm 12.3.4.

```sh
pnpm install
pnpm db:reset && pnpm db:seed
pnpm dev            # API on http://127.0.0.1:4070, web on http://127.0.0.1:3070
pnpm test && pnpm typecheck
```

## Synthetic data only

Weft runs on one fictional company, Larkspur Robotics (demo), with 48 synthetic employees and 3 contractors. Every government agency, bank, benefits carrier and SaaS integration is a simulator inside this repo; no real agency, bank or carrier is ever contacted and no real money moves. Names of record end with `(demo)` and every domain is `*.example`.

## Models

The default is a deterministic scripted provider, so everything works offline and in tests. For real agent runs Weft uses OpenAI `gpt-5.6-luna` through the Responses API (`WEFT_LLM=openai`). Keep the key outside the repo:

```sh
# ~/Developer/projects/.weft.secrets.env (outside the repo, never committed)
OPENAI_API_KEY=...

WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LLM=openai pnpm dev
```

`scripts/dev.ts` passes `WEFT_SECRETS_FILE` only to the API process. Spend is capped per run, per day and in total (`WEFT_RUN_USD_CAP`, `WEFT_DAY_USD_CAP`, `WEFT_LIVE_USD_CAP`).

## Brand

Weft mirrors the layout conventions of a commercial payroll product's public site, with its own name, original copy, original SVG art, the madder accent (`#d6264b`) and the open-licensed Inter and JetBrains Mono fonts. It uses no third-party logos, testimonials or marketing copy.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
