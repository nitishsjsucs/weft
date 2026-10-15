# Architecture

Weft is a pnpm monorepo with two processes on 127.0.0.1: the API (Hono on Node, one process) and the web app (Next 16). Data lives in one SQLite file and one git repo per company under `.data/`.

```
browser ──/api/* (Next rewrite + x-weft-proxy)──▶ apps/api (127.0.0.1:4070)
REST client ──x-api-key──────────────────────────▶   /v1 routes, /v1/tools, SSE, scheduler
MCP client ──stdio──▶ apps/mcp ──/v1/tools───────▶   │
                                                     ├─ brain: packages/agent, packages/routines
                                                     ├─ hands: packages/executor (the only writer)
                                                     ├─ domain: packages/core, packages/payroll-tax
                                                     ├─ packages/sim (agencies, bank, IdP, devices, chat)
                                                     └─ .data/weft.db (SQLite) and .data/companies/<id>/memory (git)
```

## Processes

- **API** (`apps/api`). `compose.ts` `createWeft()` is the composition root: it wires the database, simulators, executor, domain commands and handlers, the model provider, the agent runtime, routines, the scheduler and the Hono app. `main.ts`, the seed CLI, scenario tests and E2E all go through it. The scheduler ticks every 5 seconds (and on `kick()` after every mutation): simulators, proposal expiry, domain event handlers, routines.
- **Web** (`apps/web`). The landing page `/` and the app under `/app`. The browser only calls `/api/*`; a Next rewrite forwards to the API and `src/proxy.ts` injects `x-weft-proxy`, a secret the API writes to `.data/run/proxy.secret` at boot. So there is no CORS, and the "Viewing as" principal header is honored only through the proxy.
- **MCP** (`apps/mcp`). A thin stdio client of `/v1/tools` with an `mcp`-scope key. It exposes read and propose tools only; approve, deny, rollback, vault, settings and memory writes are never exposed.
- **Dev runner** (`scripts/dev.ts`). Starts the API and web in separate process groups after lsof port checks. Each group is led by a guard that kills the group if the runner dies, and Ctrl+C stops both groups. Secrets reach only the API.

## Brain and hands

The agent ("brain": `packages/agent`, `packages/routines`) never writes domain state. It holds an opaque run handle and calls `AgentExecutor.exec(handle, call)`. The executor ("hands": `packages/executor`) derives the principal, surface, attended flag and taint from its own rows on every call, then runs the pipeline: strict schema, grants, risk class from one `policy()`, money ceilings, taint rules, and either executes or creates a proposal.

- **Approvals never block the loop.** A gated call returns `pending_approval` with a proposal id and the run goes to `waiting`. A human decision re-runs the whole pipeline on the stored arguments (compare-and-set, so a double approve executes once), then wakes the run or ends it with zero model tokens when its checklist already holds.
- **Taint.** A run that reads untrusted text (a notice body, a chat message) is marked tainted. Tainted runs can only propose; their content never reaches memory.
- **Audit.** Every state change and its simulator write commit in one SQLite transaction with a row in the hash-chained `actions` table (UPDATE and DELETE abort by trigger). `GET /v1/actions/verify` checks the chain; reversible actions have one-click rollback that appends a reversing row.
- **Memory.** Each company has a git repo of Markdown notes (`.data/companies/<id>/memory/`) written only through the executor's hardened writer.
- Three import-scan rules in `tests/boundaries.test.ts` keep the split honest: the brain does not import domain packages or the executor internals, the hands do not import model SDKs, and decide, rollback and the human executor are never named in the brain.

## Simulated clock

One `SimClock` persisted in `settings`: `now = base_sim + (wall - base_wall) * rate`. Rate 1 in dev, 0 in tests and E2E. Cron triggers, proposal expiry, simulator delays, git commit dates and domain timestamps all use it; spend uses the wall clock. The seed sets it to Monday 2026-10-26 08:30 PT. The Simulators panel advances it (+30 min, +1 day, next scheduled event).

## Packages

| Package | Role |
|---|---|
| `contracts` | Zod DTOs, the route table, events, test ids, harness contracts (frozen) |
| `db` | Drizzle schema, migrations, `openDb`, the write lock |
| `seed` | Deterministic world builder (`pnpm db:seed`, `pnpm db:digest`) |
| `core` | Domain commands, services, event handlers, `SimClock` |
| `payroll-tax` | Pure gross-to-net engine with versioned 2026 rate data (federal, CA, NY, TX, CO) |
| `sim` | Agency, bank, IdP, device, chat and carrier simulators with fault injection |
| `executor` | Registry, pipeline, proposals, decisions, action log, rollback, vault, redaction, memory, run workspaces |
| `agent` | Providers, the run loop, budgets, spend ledger, grounding use, traces |
| `routines` | Triggers, prechecks, checklists, run keys |
| `grounding` | Pure check that model claims cite real tool results (cents rule) |
| `ui` | Design tokens, Tailwind theme, shared components |

## Data

- `.data/weft.db`: SQLite via libsql (WAL, busy timeout 5 s, foreign keys on), one client per process.
- `.data/companies/<id>/`: memory repo and run workspaces.
- `.data/spend/`: the spend ledger (never reset).
- `.data-e2e/`: the same layout for `pnpm e2e`.

Money is integer cents everywhere; rates are decimal strings; tax math uses `decimal.js` and rounds half up once per tax line.
