# AGENTS.md

Weft is an open-source, self-hostable, AI-native payroll and HR platform that runs on synthetic data for one fictional company. `SPEC.md` is the build spec; `research/harness.md` section 13 is binding for every contract that touches the agent, executor, approvals, memory, routines or MCP.

## Rules every builder follows (SPEC 0)

1. **Brand.** Mirror the look of the reference site (layout, spacing, type scale, color mood, motion, component shapes). Never use its name, logo, wordmark, illustrations, photos, customer logos, testimonials or marketing copy, and never hotlink its CDN. Use the Weft name, original copy, Inter Variable and JetBrains Mono (OFL, self-hosted), and original SVG art. No fake testimonials, no real company logos. Demo content is visibly fictional: every person and company name in the seed ends with `(demo)` where it is displayed as a name of record, and every domain is `*.example`.
2. **Reference material** (the reference site's HTML, CSS, fonts, screenshots) lives only in `research/design/reference/` (gitignored, absolute path `/Users/nitishcs/Developer/projects/weft/research/design/reference/`). Never copy files from it into the repo. Worktrees do not contain it; read it from the absolute path.
3. **Prose.** No em dashes or en dashes in any doc, comment, UI copy or commit message. `pnpm lint:prose` enforces it.
4. **Git.** In this repo `user.name "nitishsjsucs"`, `user.email "227862909+nitishsjsucs@users.noreply.github.com"`. Meaningful commits. Never add a Co-Authored-By trailer.
5. **Processes and ports.** Check a port before starting a server: `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Start servers in their own process group and kill the whole group when done. Never touch a process you did not start. Tests prefer Hono `app.request()` (no listening socket). Close every libsql client and server in tests, or the process never exits. Only T5 and T6 run `next dev`; the others test through `app.request()` (memory pressure on the 24 GB M5 with other agents running).
6. **Models.** Default for real runs is OpenAI `gpt-5.6-luna` through the Responses API (`/v1/responses`), opt-in with `WEFT_LLM=openai`. `WEFT_LLM` defaults to `scripted`. The key is `OPENAI_API_KEY` from the environment or from the file named by `WEFT_SECRETS_FILE` (`~/Developer/projects/.weft.secrets.env`, outside the repo); never print, log, commit or copy it, and never put real keys in `.env` files inside the repo. Real spend is capped by the wall-clock spend ledger (`WEFT_RUN_USD_CAP=0.10`, `WEFT_DAY_USD_CAP=2.00`, `WEFT_LIVE_USD_CAP=0.50` cumulative). Each builder spends at most about $0.50 live. Automated tests always use the scripted provider; the provider factory throws `LIVE_PROVIDER_IN_TEST` otherwise unless `WEFT_LIVE_OPENAI=1`. Builders never start the 27B model; the local and Claude providers are P1.
7. **Contracts are frozen** after the scaffold commit: `packages/contracts/**`, `packages/db/src/schema.ts` and its migrations, the route table, `apps/api/src/{compose,scheduler,app,main}.ts`, `packages/core/src/shared/**`, `packages/core/src/{commands,handlers}/index.ts`, `packages/seed/src/{index,cli}.ts`, design tokens. If a track needs an addition it writes it into its own file `packages/contracts/src/ext/<track-id>.ts` (additive only) and notes it in `.scratch/contract-requests/<track-id>.md`; the integrator folds it in between rounds. Never edit another track's owned paths.
8. **Scratch files** go in `.scratch/<track-id>/` (gitignored) or your session scratchpad, never in owned source dirs.
9. **Money** is integer cents everywhere. Rates are decimal strings (`"0.034"`). Never use floats for money; use `decimal.js` inside rate math and round half up to cents once per tax line.
10. **Time.** Run `date` at the start of each task. Each round is 80 minutes. If you run short, finish a smaller scope well (your cut line) and record what is left in `.scratch/<track-id>/left.md`.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install (Node 25.9.0, pnpm 12.3.4). After editing any `package.json`, run it again; if a dependency link is still missing, delete `node_modules` folders and reinstall |
| `pnpm test` | All vitest projects (`packages/*`, `apps/*`, `tests`) |
| `pnpm typecheck` | `tsc --noEmit` in every package through turbo |
| `pnpm --filter @weft/web build` | Next production build |
| `pnpm lint:prose` | No em or en dashes in tracked text |
| `pnpm lint:brand` | No reference-site names, domains or denylisted phrases outside `research/`, `NOTICE` and `SPEC.md` |
| `pnpm db:reset && pnpm db:seed && pnpm db:digest` | Rebuild the world in `.data/` and print its digest |
| `pnpm dev` | API on 127.0.0.1:4070 and web on 127.0.0.1:3070 in separate process groups (check ports first) |
| `pnpm e2e` | Playwright golden paths on ports 3170 and 4170 |
| `pnpm eval:live` | Live Luna gate, opt-in: `WEFT_LIVE_OPENAI=1 WEFT_LLM=openai` |

## Where things go

- Shared contracts: `packages/contracts/src` (frozen). Additions go in `packages/contracts/src/ext/<track-id>.ts` plus a note in `.scratch/contract-requests/<track-id>.md`.
- Commands: append to your file's array in `packages/core/src/commands/<namespace>.ts`; `commands/index.ts` concatenates them.
- Event handlers: `packages/core/src/{payroll,onboarding,tax}/handlers.ts`; `handlers/index.ts` concatenates them.
- Seed steps: `packages/seed/src/<step>.ts`, each `async (ctx: SeedContext) => void`, run in the SPEC 5 order by `seedWorld()`.
- Routes: replace the 501 stubs in `apps/api/src/routes/<file>.ts`; paths come from `packages/contracts/src/api.ts`.
- Tests: `apps/api/test/<route file>.test.ts` with `createTestWeft()` and `uiHeaders()`; scenarios in `tests/scenarios/`.
- Factories that are still stubs throw `NotImplemented`; `createWeft()` lists them in `weft.stubs` and in `GET /v1/health`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
