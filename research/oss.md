# Weft: open-source building blocks and base-project decision

Researched 2026-10-15, 13:05 to 13:35 PDT, on the build Mac (Apple M5, Node 25.9.0, pnpm 12.3.4). Every fact carries a source: a URL, a GitHub API call (written as `gh api repos/<owner>/<repo>` and run on 2026-10-15), an `npm view` call (run 2026-10-15), or a local test (scratch folder `S=/private/tmp/claude-501/-Users-nitishcs-Downloads-resume-fine-tuner/dbbbe8b6-3969-4418-a6af-c3e18c3900aa/scratchpad/oss`, which is temporary; the outputs that matter are quoted below).

## TL;DR (read this if nothing else)

1. **Build fresh on a TypeScript stack. Do not fork any existing HR or payroll project.** No serious open-source HR or payroll project is TypeScript plus React plus a permissive license. The large ones are Python, PHP or Angular (Frappe HRMS, Horilla, OrangeHRM, Ever Gauzy) and/or GPL or AGPL, and none of them computes US federal and state withholding. Details in section 2.
2. **Borrow only from MIT, Apache-2.0 or CC0 sources**, with attribution in a `NOTICE` file: shadcn/ui components (via its CLI), the shadcn data-table v9 pattern, the API shape and test cases of `@molecule/api-payroll-tax-us` (Apache-2.0), and dashboard-shell ideas from `next-shadcn-dashboard-starter` and `shadcn-admin` (MIT). Use AGPL and GPL projects (Midday, Ever Gauzy, Twenty, Frappe HRMS, Horilla, OrangeHRM, PolicyEngine) as **feature checklists and domain-model references only, never copy their code**, unless Weft itself goes AGPL. Suggested Weft license: Apache-2.0 (compatible with every source we borrow from).
3. **Agent: write our own small loop** over a `Provider` interface (anthropic / openai-compatible / scripted), with tools defined once in zod and exported both to the agent and to the MCP server. Do not adopt the Claude Agent SDK (commercial terms, Claude-only), Mastra, LangGraph.js or the Vercel AI SDK. Copy the AI SDK's *approval pattern* (approval request is data, resume by re-calling with an approval response) rather than the dependency. Section 4.
4. **Pinned stack verified today** (section 5). Three install traps found on this Mac: (a) pnpm 12 rejects any version younger than 24 h (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), so pins below are the newest versions at least 3 days old; (b) pnpm 12 treats unapproved build scripts as a hard error (`ERR_PNPM_IGNORED_BUILDS`), so `pnpm-workspace.yaml` needs `allowBuilds: { esbuild: true }`; (c) `better-sqlite3@13.0.3` has no prebuilt binaries and fails with `node-gyp: command not found`. **Use `@libsql/client` 0.18.0** (prebuilt, no build step, works with Drizzle and drizzle-kit on Node 25).
5. **TanStack Table 9 renamed the hook**: `useReactTable` no longer exists (build error), use `useTable`. The shadcn data-table guide already uses v9; most dashboard starters and older tutorials are still v8.

## 1. Is there already an open-source Warp?

No. Warp is proprietary: a New York startup founded in 2023 that raised a $60M Series B for AI payroll, HR, compliance, benefits and IT ([dealroom](https://dealroom.co/news/135998-warp-lands-60m-series-b-to-automate-payroll-compliance-and-hr-with-ai/), [letsdatascience](https://letsdatascience.com/news/warp-raises-60m-to-automate-hr-workflows-0b7a1611)). A web search for open-source Warp, Gusto, Rippling or Deel alternatives returned only commercial products and comparison pages ([shyft.ai alternatives list](https://www.shyft.ai/tools/alternatives/warp), [Capterra Gusto alternatives](https://capterra.com/p/131882/Gusto/alternatives/)). GitHub searches `open source rippling`, `open source gusto`, `open source deel` returned zero relevant repos (`gh search repos`, 2026-10-15). Warp publishes an `llms.txt` at https://www.warp.co/llms.txt (useful to the product-research stage, not read here).

## 2. Candidate base projects (HR, payroll, back office)

Stars, language, license and last push from `gh api repos/<owner>/<repo>` on 2026-10-15; license text from `gh api repos/<owner>/<repo>/license`.

| Project | License | Language / stack | Activity | Verdict for Weft |
|---|---|---|---|---|
| [frappe/hrms](https://github.com/frappe/hrms) | GPL-3.0 | Python on Frappe Framework, Vue (Frappe UI) frontend | 8,927 stars, pushed 2026-10-15 | Reference only |
| [horilla/horilla-hr](https://github.com/horilla/horilla-hr) | LGPL-2.1 | Django 5+, Python 3.12 to 3.14, htmx and jQuery UI | 1,458 stars, pushed 2026-10-15 | Reference only |
| [orangehrm/orangehrm](https://github.com/orangehrm/orangehrm) | GPL-3.0 | PHP | 1,152 stars, pushed 2026-06-28 | Reference only (no payroll) |
| [gamonoid/icehrm](https://github.com/gamonoid/icehrm) | Elastic License 2.0 (not OSI) | JavaScript / PHP | 733 stars, pushed 2026-10-13 | Do not use |
| [CybroOdoo/OpenHRMS](https://github.com/CybroOdoo/OpenHRMS) | AGPL-3.0 | Odoo addons (Python) | 167 stars, pushed 2026-09-22 | Do not use |
| [ever-co/ever-gauzy](https://github.com/ever-co/ever-gauzy) | AGPL-3.0 | TypeScript, Nx 23, NestJS 12, Angular 22, yarn; `engines.node >=26` | 8,380 stars, pushed 2026-10-15 | Reference only |
| [midday-ai/midday](https://github.com/midday-ai/midday) | AGPL-3.0 plus commercial-use clause in README | TypeScript, Next.js, Bun, Turborepo, Supabase, shadcn, Trigger.dev | 15,069 stars, pushed 2026-06-13 | Architecture reference only |
| [twentyhq/twenty](https://github.com/twentyhq/twenty) | AGPL-3.0, some files commercial (`/* @license Enterprise */`), some packages MIT | TypeScript | 58,396 stars, pushed 2026-10-15 | UI-pattern reference only |
| [zero8dotdev/avkash](https://github.com/zero8dotdev/avkash) | AGPL-3.0 | TypeScript, Bun + Hono + Drizzle + OpenFGA, pnpm + turbo | 24 stars, pushed 2026-06-16 | Validates our backend stack; do not copy |
| [dubbl-org/dubbl](https://github.com/dubbl-org/dubbl) | Apache-2.0 | TypeScript, Next.js 16.1.6, Drizzle, Postgres, next-auth, Trigger.dev | 53 stars, last commit 2026-06-23 | Borrowable (ledger patterns) with attribution |
| [Payroll-Engine/PayrollEngine](https://github.com/Payroll-Engine/PayrollEngine) | MIT | .NET / C# (repo language PowerShell) | 132 stars, pushed 2026-10-02 | Design-idea reference |
| [VonHoltenCodes/SlowBooks-Pro-2026](https://github.com/VonHoltenCodes/SlowBooks-Pro-2026) | Source-available, not OSI | Python, includes US payroll | 745 stars, pushed 2026-10-15 | Do not copy |
| [highoncarbs/Hafta](https://github.com/highoncarbs/Hafta) | MIT | JavaScript | 147 stars, pushed 2022-12-08 | Stale, skip |

Per-project notes (only what changes a decision):

- **Frappe HRMS**: modules cover employee lifecycle (onboarding, transfers, exit), leave and attendance, expense claims with multi-level approval, performance, and payroll with salary structures, income-tax configuration, additional salaries and off-cycle payments ([README](https://github.com/frappe/hrms)). US federal, state or FICA withholding is not mentioned. Needs a Frappe bench (or docker-compose) plus ERPNext ([README](https://github.com/frappe/hrms)). Reuse: the domain vocabulary (salary component, salary structure, salary structure assignment, payroll entry producing salary slips, additional salary, off-cycle run) is a proven model worth mirroring in Weft's schema. Cost of adopting: Python stack, GPL-3.0 (derivatives must be GPL), Vue UI that would have to be thrown away to get the Warp look.
- **Horilla**: modules are employee management (LDAP), recruitment, onboarding and offboarding, attendance (biometric), leave, payroll, performance, assets, helpdesk; payroll mentions "tax calculations" without naming jurisdictions; there is a `horilla_api` folder but no API docs ([README](https://github.com/horilla/horilla-hr)). Cost: Django + htmx server-rendered UI, Python.
- **OrangeHRM**: the open-source plugins are Admin, Attendance, Authentication, Buzz, Claim, CoreOAuth, Core, CorporateBranding, CorporateDirectory, Dashboard, Help, I18N, LDAP, Leave, Maintenance, Mobile, OpenID, Performance, PIM, Recruitment, SystemCheck, Time, WorkspaceNotifications: **no payroll plugin** (`gh api repos/orangehrm/orangehrm/contents/src/plugins`).
- **IceHrm**: LICENSE is "Elastic License 2.0 (ELv2)", which forbids providing the software "to third parties as a hosted or managed service" (`gh api repos/gamonoid/icehrm/license`). Incompatible with an open-source, self-hostable Weft.
- **Ever Gauzy**: the most feature-complete TypeScript option, and it already ships `agent`, `mcp`, `server-mcp` and `mcp-auth` apps (`gh api repos/ever-co/ever-gauzy/contents/apps`). But it is Angular 22 + NestJS 12 + Nx 23 and declares `"engines": {"node": ">=26", "yarn": ">=1.22"}` (`gh api repos/ever-co/ever-gauzy/contents/package.json`), so it does not match Node 25.9 on this Mac, and the whole UI would need replacing to mirror Warp. AGPL-3.0. Not adoptable in 9 hours.
- **Midday**: closest in look and stack (Next.js, shadcn, Tailwind, Turborepo, Bun) ([README](https://github.com/midday-ai/midday)). `apps/`: api, dashboard, desktop, website, worker. `packages/`: accounting, app-store, banking, bot, cache, categories, cli, connectors, customers, db, desktop-client, documents, email, encryption, events, health, import, inbox, insights, invoice, job-client, jobs, location, logger, mcp-apps, notifications, plans, supabase, trpc, tsconfig, ui, utils, workbench (`gh api repos/midday-ai/midday/contents/apps` and `/packages`). Its README says AGPL-3.0 applies to non-commercial use and commercial use needs a separate license ([README](https://github.com/midday-ai/midday)). Hard dependency on Supabase (DB, auth, storage, realtime) and Trigger.dev. Last push 2026-06-13, so four months quiet. Reuse: the layout of the monorepo (separate `apps/api` and `apps/worker`, shared `packages/ui`, `packages/db`, `packages/jobs`, an `mcp-apps` package) is a good template to imitate in our own code.
- **Twenty**: license file says AGPL-3.0 for most code, commercial for files marked `/* @license Enterprise */`, MIT for some packages (`gh api repos/twentyhq/twenty/license`). Look at it for record pages, command bar and table UX; copy nothing.
- **Avkash**: description "Open-core HR API, self-hostable leave, attendance, people, and org management ... Bun + Hono + Drizzle + OpenFGA"; pnpm workspace + turbo; apps `api`, `worker` (`gh api repos/zero8dotdev/avkash`, `/contents/apps`). Tiny (24 stars) and AGPL; useful only as proof that Hono + Drizzle + pnpm + turbo is a sane HR backend layout.
- **Dubbl**: Apache-2.0 Xero/QuickBooks alternative on Next.js 16.1.6 + Drizzle 0.45 + Postgres (`pg`) + next-auth 5 beta + Trigger.dev 4.4.6 (`gh api repos/dubbl-org/dubbl/contents/package.json`). Route groups `(admin) (auth) (dashboard) (landing) (onboarding)` plus `pay`, `portal`, `sign` (`gh api repos/dubbl-org/dubbl/contents/app`). The only permissively licensed, modern-stack back-office app found; its double-entry ledger code can be borrowed with attribution if Weft needs a payroll journal. Postgres, so not drop-in for SQLite.
- **Payroll Engine**: "Open-source framework for regulation-driven payroll applications, multi-tenant" (repo description). .NET, so only its concept of regulations as layered, versioned data is worth borrowing.
- **SlowBooks Pro 2026**: license says "You may not sell it, rent it, or offer the Software itself as a paid service" (`gh api repos/VonHoltenCodes/SlowBooks-Pro-2026/license`). Not open source; do not read its payroll code into Weft.

## 3. Payroll tax calculation

Findings:

- **`@molecule/api-payroll-tax-us`** 1.0.2 (published 2026-09-20, created 2026-08-03), Apache-2.0, zero dependencies, source in [molecule-dev/molecule/packages/api/utilities/payroll-tax-us](https://github.com/molecule-dev/molecule/tree/main/packages/api/utilities/payroll-tax-us) (`npm view @molecule/api-payroll-tax-us`). Pure functions, all amounts integer cents; input is one paycheck (gross cents, filing status, pay period, YTD wages, optional state, allowances, pre-tax deductions); output decomposes federal income-tax withholding (IRS Pub 15-T annualised method, 2024 and 2025 tables only), Social Security with wage cap, Medicare, Additional Medicare (0.9% over $200K per employer), and state withholding for CA, NY, TX, FL, IL, MA; more states via `registerStateCalculator` (package README, fetched via `gh api .../payroll-tax-us/README.md`). Source files: `calculate.ts`, `federal.ts`, `fica.ts`, `state.ts`, `tax-year.ts`, `types.ts` (`gh api .../payroll-tax-us/src`). Gaps: no 2026 tables; the 2025 `FEDERAL_STANDARD_DEDUCTION.single` is `15_000_00` (`federal.ts` lines 138 to 150), which should be rechecked against current IRS guidance before reuse; the monorepo has 44 stars, so treat it as unreviewed code.
- **[PSLmodels/Tax-Calculator](https://github.com/PSLmodels/Tax-Calculator)**: CC0 / US public domain (`gh api .../license`), Python, "USA Federal Individual Income and Payroll Tax Microsimulation Model". Annual-liability microsimulation, not per-paycheck withholding. Good source of federal parameters with no license friction.
- **[PolicyEngine/policyengine-us](https://github.com/PolicyEngine/policyengine-us)**: AGPL-3.0, Python, a rules engine of the US tax-benefit system. Reference only.
- **tenforty** (Python, federal plus some states) ([libraries.io](https://libraries.io/pypi/tenforty)); **paycheck-utils** (Rust, federal withholding plus FICA estimates) ([docs.rs](https://docs.rs/paycheck-utils)). Wrong languages; skip.
- No maintained JavaScript library covers all 50 states. `npm search payroll tax` surfaced only the molecule package for the US (plus Mongolia and Kenya packages).

Recommendation: write `packages/payroll-tax` in Weft (pure TypeScript, integer cents, no I/O, year-keyed tables, one module per state behind a registry), modelled on the molecule API shape and seeded with its test cases (Apache-2.0: keep its license notice if any file or test is copied). Tax rates and brackets are public facts from IRS Pub 15-T and state agency tables, not copyrightable. For the 9-hour build, cover federal (Pub 15-T 2026, W-4 2020+ path), FICA, Additional Medicare, FUTA and SUTA employer taxes, and a handful of states including at least one no-income-tax state, one flat-tax state and CA or NY for brackets. Golden-number tests in vitest are the acceptance bar. Use `decimal.js` only inside rate math, round to cents at defined points, store cents as integers.

## 4. Agent frameworks and MCP

| Option | License | Versions (npm, 2026-10-15) | Fit |
|---|---|---|---|
| `@anthropic-ai/sdk` (tool runner) | MIT | latest 0.135.0 (published 2026-10-15), pin 0.133.0 | Use for the Claude provider; use its raw `messages.create`, not the runner, inside our loop |
| `@anthropic-ai/claude-agent-sdk` | "Anthropic's Commercial Terms of Service" | 0.3.301 | Reject |
| `ai` (Vercel AI SDK) + `@ai-sdk/openai-compatible` | Apache-2.0 | `ai` 7.0.142, node >=22 | Reject the dependency, copy the approval pattern |
| `@mastra/core` | Apache-2.0 outside `ee/` dirs, separate license inside | 1.77.0, node >=22.13.0 | Reject |
| `@langchain/langgraph` | MIT | 1.5.0 | Reject |
| `@modelcontextprotocol/sdk` | MIT moving to Apache-2.0 | 1.32.1 (only dist-tag `latest`) | Use |
| `openai` (client for local OpenAI-compatible servers) | Apache-2.0 | latest 7.34.0, pin 7.32.0, node >=22 | Use in the local provider |

Evidence and reasoning:

- **Anthropic tool runner**: `client.beta.messages.toolRunner()` with `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`, or `betaTool()` from `.../helpers/beta/json-schema` (bundled docs `/private/tmp/claude-501/bundled-skills/2.1.299/29a7ff8b7a71aa7db21b9e598e16094f/claude-api/typescript/claude-api/tool-use.md` lines 19 to 61). It is beta, does not auto-resume `pause_turn` (line 69), and for human-in-the-loop the docs say to gate inside `run()` or inspect pending `tool_use` blocks between iterations (line 106). Verified locally: with SDK 0.133.0 and zod 4.6.7, `typeof client.beta.messages.toolRunner === "function"` and `betaZodTool({... inputSchema: z.object(...)})` constructs (`$S/t2/src/smoke.ts`). Why not use it: Weft approvals must survive across HTTP requests (a human approves minutes or hours later in the UI), the loop must be identical for three providers, and the scripted provider must replay deterministically. An in-memory runner does neither. Our loop: persist the message history and pending tool calls per agent run in SQLite; when a tool is marked `requiresApproval`, stop and write an approval row; on approve or deny, append the tool result (or a denial result) and continue.
- **Claude API facts the Claude provider needs** (bundled docs, `typescript/claude-api/README.md` lines 199 to 211 and `tool-use.md` line 317, `shared/model-migration.md` lines 995 to 1005): Opus 5.5 thinking is always on, do not send `{type:"disabled"}` or a budget; set depth with `output_config: { effort }`, values `low | medium | high | xhigh | max`, default `medium` on Opus 5.5. Forcing `tool_choice` (`any` or a named tool) returns 400 on Opus 5.5; steer with the prompt and use `strict: true` tools whose schemas set `additionalProperties: false`. `fallbacks: "default"` needs beta header `server-side-fallback-2026-07-01` (the array form uses `-2026-06-01`; mixing returns 400). In SDK 0.133.0 `fallbacks?: BetaFallbacksParam` exists only on the beta messages params and `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'` (`$S/t2/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` lines 3919 and 6968), so the Claude provider must call `client.beta.messages.create({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", ... })`. The `Model` union includes `'claude-opus-5-5'` (`.../resources/messages/messages.d.ts` line 3583).
- **zod to JSON Schema for tools**: zod 4 has it built in. `z.toJSONSchema(z.object({id:z.string()}).strict())` produced `{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}` (local run in `$S/t2`), which satisfies `strict: true`. No `zod-to-json-schema` dependency needed.
- **Claude Agent SDK**: README license clause is "Use of this SDK is governed by Anthropic's Commercial Terms of Service" ([repo](https://github.com/anthropics/claude-agent-sdk-typescript)); npm shows license "SEE LICENSE IN README.md" and per-platform native optional dependencies (`@anthropic-ai/claude-agent-sdk-darwin-arm64` etc., 5.5 MB unpacked) (`npm view @anthropic-ai/claude-agent-sdk@0.3.296`). Claude-only, so it cannot drive the local Qwen or scripted providers, and its terms are not open source.
- **Vercel AI SDK**: tool approval is now `toolApproval` on `generateText` / `streamText` / `ToolLoopAgent` (`needsApproval` on `tool()` is deprecated); the call returns `tool-approval-request` parts without pausing, and the app resumes by pushing a `tool-approval-response` (`approvalId`, `approved`) in a `role: 'tool'` message and calling again; `stopWhen` defaults to `isStepCount(1)` ([AI SDK tools docs](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)). This stateless request/response shape is exactly what Weft's approval table should imitate. Rejected as a dependency because the brief requires the official `@anthropic-ai/sdk` for Claude, and wrapping it under a second abstraction adds risk for no gain.
- **Mastra**: model routing by `provider/model` strings with per-provider env keys; human-in-the-loop is a separate guide ([Mastra agents overview](https://mastra.ai/docs/agents/overview)). License splits `ee/` directories off ([LICENSE.md](https://github.com/mastra-ai/mastra)). Too much framework for nine hours.
- **LangGraph.js**: MIT ([repo](https://github.com/langchain-ai/langgraphjs)); graph runtime plus LangChain message types. Same objection.
- **MCP TypeScript SDK** 1.32.1: verified `new McpServer({name, version}).registerTool("ping", { description, inputSchema: { msg: z.string() } }, handler)` with zod 4 and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js` (local run). Its own dependencies include `hono ^4.11.4` and `@hono/node-server ^1.19.9 || ^2.0.5`, peer `zod ^3.25 || ^4.0` (`npm view @modelcontextprotocol/sdk@1.32.1`), so it shares our Hono and zod pins. License file: transitioning from MIT to Apache-2.0 ([LICENSE](https://github.com/modelcontextprotocol/typescript-sdk)).
- **Local model servers** (for the openai-compatible provider): installed `mlx_lm` is 0.32.0 and its `server.py` parses tool calls with the tokenizer's `tool_parser` and returns `tool_calls` (`~/Developer/projects/_models/mlx-venv/lib/python3.12/site-packages/mlx_lm/server.py` lines 58 to 84, 149, 734, 928). `llama-server` is at `/opt/homebrew/bin/llama-server`. The `openai` 7.32.0 client constructs with a custom `baseURL` (local run). Tool-call quality from Qwen is the stage-gate's job to test, not verified here.

## 5. Pinned stack (verified 2026-10-15 with `npm view`, installed and run on Node 25.9.0 + pnpm 12.3.4)

"Pin" is the newest stable version published at least 3 days ago (pnpm 12's default release-age gate is 24 h, see 6.1); "latest" is today's `latest` dist-tag. Publish dates from `npm view <pkg> time` (script `$S/pick.py`).

| Package | Pin | Latest today | License | Engines / notes | Local result |
|---|---|---|---|---|---|
| next | 16.4.0 (2026-10-06) | 16.4.1 (2026-10-14) | MIT | node >=20.9.0 | `next build` OK, Turbopack, "Compiled successfully in 4.5s" |
| react, react-dom | 19.3.0 (2026-09-09) | 19.3.1 (2026-10-14) | MIT | | OK |
| tailwindcss, @tailwindcss/postcss | 4.3.3 (2026-07-16) | same | MIT | | OK (`@import "tailwindcss"` + postcss plugin) |
| shadcn (CLI) | 4.21.4 (2026-10-07) | 4.21.5 | MIT | node >=20.18.1 | not run (CLI copies components) |
| radix-ui (unified package) | 1.8.0 (2026-10-12) | 1.8.1 | MIT | | `import { Dialog } from "radix-ui"` built OK |
| motion | 14.1.0 (2026-10-09) | 14.3.0 (2026-10-15) | MIT | import from `motion/react` | built OK |
| recharts | 3.10.1 (2026-07-25) | same | MIT | node >=18 | built OK (shadcn charts wrap Recharts) |
| @tanstack/react-table | 9.3.1 (2026-10-12) | same | MIT | node >=20, peer react >=18 | v9 API is `useTable`; `useReactTable` import fails the build |
| lucide-react | 1.55.0 (2026-10-10) | 1.57.0 | ISC | | built OK |
| class-variance-authority / clsx / tailwind-merge | 0.7.1 / 2.1.1 / 3.7.0 | same | Apache-2.0 / MIT / MIT | | installed |
| hono | 4.13.13 (2026-10-04) | same | MIT | node >=16.9.0 | OK |
| @hono/node-server | 2.1.4 (2026-10-08) | 2.1.5 | MIT | node >=20 | served and answered a POST |
| @hono/zod-validator | 0.9.1 (2026-08-31) | same | MIT | | `zValidator("json", z.object(...))` OK with zod 4 |
| drizzle-orm | 0.45.4 (2026-10-08) | same | Apache-2.0 | drivers present: better-sqlite3, bun-sqlite, libsql, op-sqlite, sqlite-proxy (no node:sqlite driver) | insert/select via `drizzle-orm/libsql` OK |
| drizzle-kit | 0.31.11 (2026-09-21) | same | MIT | | `generate` wrote `0000_*.sql`; `push` applied to a `file:` DB |
| @libsql/client | 0.18.0 (2026-09-02) | same | MIT | prebuilt binaries, no build approval needed | OK, **recommended driver** |
| better-sqlite3 | 13.0.3 (2026-08-05) | same | MIT | node >=22, no prebuilds | **fails by default** (6.2) |
| zod | 4.6.7 (2026-10-12) | same | MIT | | OK, `z.toJSONSchema` built in |
| @modelcontextprotocol/sdk | 1.32.1 (2026-10-05) | same | MIT to Apache-2.0 | node >=18 | `McpServer.registerTool` OK |
| @anthropic-ai/sdk | 0.133.0 (2026-10-09) | 0.135.0 (2026-10-15) | MIT | peer zod `^3.25.0 \|\| ^4.0.0` | client, toolRunner, betaZodTool OK (no API call, no key) |
| openai | 7.32.0 (2026-10-09) | 7.34.0 | Apache-2.0 | node >=22 | client OK |
| croner | 10.0.1 (2026-02-01) | same | MIT | zero deps | `new Cron("0 9 * * 1", {timezone:"America/Los_Angeles"}).nextRun()` gave 2026-10-19T16:00Z (Monday 09:00 PDT) |
| node-cron (alternative) | 4.6.0 | same | ISC | node >=20 | not tested; croner preferred (timezone, `nextRun`, pause) |
| @faker-js/faker | 10.6.0 (2026-08-14) | same | MIT | node `^20.19 \|\| ^22.13 \|\| ^23.5 \|\| >=24` | `faker.seed(42)` deterministic names OK |
| decimal.js | 10.6.0 (2025-07-06) | same | MIT | | OK |
| vitest | 5.0.4 (2026-10-12) | 5.0.5 (2026-10-15) | MIT | node `^22.12 \|\| ^24 \|\| >=26` (25 not listed) | **ran fine on 25.9.0** (1 test passed in 226 ms) despite the engines range; pnpm did not block it |
| @playwright/test | 1.64.0 (2026-10-07) | 1.64.1 | Apache-2.0 | node >=20 | CLI OK; needs browser `chromium-1248`, cache has only `chromium-1243` (6.4) |
| turbo | 2.11.7 (2026-10-02) | 2.11.8 | MIT | | `turbo --version` OK |
| typescript | 7.0.2 (2026-07-08) | same (`next` tag is 7.1.0-dev) | Apache-2.0 | | `tsc -v` "Version 7.0.2"; Next 16.4.0 type-check step ran with it ("Finished TypeScript in 1012ms"). Fallback if any tool breaks: 6.0.3 |
| tsx | 4.23.15 (2026-09-20) | same | MIT | | `node --import tsx` OK |
| @types/node, @types/react, @types/react-dom | 26.6.5 / 19.3.0 / 19.3.0 | same | MIT | | installed |

Other useful pins checked: `@tanstack/react-query` 5.104.3, `nuqs` 2.10.2, `date-fns` 4.4.0, `dinero.js` 2.0.2 (not needed if money is integer cents) (`npm view`, all MIT).

## 6. Install and runtime traps on this Mac (Node 25.9.0, pnpm 12.3.4)

1. **pnpm 12 release-age gate.** Installing a lockfile that contained `@anthropic-ai/sdk@0.135.0`, `vitest@5.0.5`, `motion@14.3.0`, `openai@7.34.0` failed with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION ... within the minimumReleaseAge cutoff (2026-10-14T20:09:13Z)`, i.e. 24 h. `pnpm add` of a too-new version silently writes a `minimumReleaseAgeExclude:` list into `pnpm-workspace.yaml`. Rule for builders: pin exact versions from section 5, never `@latest`, and do not hand-edit the exclude list (`$S/install-test`).
2. **pnpm 12 build-script approval is a hard error.** `ERR_PNPM_IGNORED_BUILDS ... Ignored build scripts: esbuild@0.18.20, esbuild@0.25.12, esbuild@0.28.2`. pnpm writes `allowBuilds:\n  esbuild: set this to true or false` into `pnpm-workspace.yaml`; set it to `true` (esbuild comes from tsx, vitest/vite and drizzle-kit). `pnpm approve-builds --all` is the non-interactive equivalent (`pnpm approve-builds --help`).
3. **better-sqlite3 13.0.3 needs a compiler toolchain.** Its package has no install script of its own and no `prebuild-install` dependency (only `node-addon-api`), so the install is an implicit `node-gyp rebuild`, which failed with `sh: node-gyp: command not found` (exit 127). It does build when `allowBuilds: { better-sqlite3: true }` is set and `node-gyp` (13.1.0) is a devDependency; Xcode CLT is at `/Library/Developer/CommandLineTools`; then `select sqlite_version()` returned `3.53.4` (`$S/bsq`). Use libsql instead and avoid the native build entirely. Node 25's built-in `node:sqlite` (`DatabaseSync`) also works, but Drizzle 0.45.4 has no driver for it.
4. **Playwright browsers.** `@playwright/test@1.64.0` wants `chromium-1248` (Chrome for Testing 156.0.8078.4); `~/Library/Caches/ms-playwright` holds `chromium-1243`, `chromium_headless_shell-1243`, `ffmpeg-1011` (`npx playwright install --dry-run chromium`). Either run `pnpm exec playwright install chromium` once (one download) or set `use: { channel: "chrome" }` to drive the installed `/Applications/Google Chrome.app`.
5. **Processes that never exit.** A script that opens a libsql client and starts `@hono/node-server`, then calls `server.close()`, was still running after 30 s (all assertions had printed). Tests and seed scripts must call `client.close()` and close servers explicitly (and builders must kill their process group, per the brief).
6. **`next build` rewrites `tsconfig.json`**: it forced `jsx: "react-jsx"`, added `allowJs: true` and `.next/types/**/*.ts` includes. Commit the rewritten file so CI does not churn.
7. **Ever Gauzy and anything else declaring `node >=26`** will warn or refuse on Node 25.9 (`gh api repos/ever-co/ever-gauzy/contents/package.json`).

## 7. UI building blocks (Warp look, original assets)

- **shadcn/ui** (MIT, 125,692 stars, `gh api repos/shadcn-ui/ui`): components are copied into the repo by the CLI, so they become our source. The [data-table guide](https://ui.shadcn.com/docs/components/data-table) now uses TanStack Table v9: `import { useTable, type ColumnDef, type RowData } from "@tanstack/react-table"`.
- **Dashboard starters** (MIT, borrow layout ideas or small pieces with attribution, do not fork): [Kiranism/next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter) (7,130 stars, pushed 2026-09-11) is Next 16.2.12 with Clerk, Sentry, kbar, dnd-kit, nuqs, zustand, motion ^11, react-table ^8.21.3; [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) (15,757 stars, pushed 2026-09-10) is Vite + TanStack Router + Clerk + react-table ^8.21.3 (`gh api .../contents/package.json`). Both need Clerk keys (bad for an offline, self-hosted demo) and are on Table v8, so take the sidebar shell and page layouts as reference only.
- **Motion** 14 (`motion/react`), **Recharts** 3 (shadcn chart wrapper), **lucide-react** icons: all MIT or ISC and verified in the Next build above.
- Fonts: substitute any commercial face with an open one from Google Fonts or Fontsource (decision belongs to the design-research stage).

## 8. Recommendation for the 9-hour foundation

**Approach: build fresh on the pinned stack; borrow specific MIT/Apache modules; treat copyleft projects as reading material.**

Why not a base project: every HR/payroll base is the wrong language or UI framework (Python, PHP, Angular), and the one TypeScript HR suite (Ever Gauzy) is Angular + NestJS, AGPL, and declares Node >=26. Midday has the right stack and look but is invoicing, depends on Supabase, is AGPL with an extra commercial clause, and has been quiet since June. Forking any of them costs more than the nine hours.

License implications:
- If Weft copies any code from AGPL-3.0 projects (Midday, Ever Gauzy, Twenty, OpenHRMS, Avkash, PolicyEngine), Weft must be AGPL-3.0 as a whole, and network users must be offered the source; Midday's README additionally asserts a commercial-use restriction, which makes it unsafe to copy from at all. GPL-3.0 (Frappe HRMS, OrangeHRM) has the same effect minus the network clause. LGPL-2.1 (Horilla) is Python, so irrelevant to linking.
- Elastic License 2.0 (IceHrm) and the SlowBooks source-available license are not open source.
- MIT, Apache-2.0 and CC0 sources (shadcn, starters, molecule payroll-tax-us, Dubbl, Tax-Calculator, all stack libraries) are compatible with an Apache-2.0 or MIT Weft; keep a `NOTICE` / `THIRD_PARTY.md` listing anything copied.

Suggested workspace shape (for the architect to confirm), pnpm workspaces + turbo:
- `apps/web`: Next 16 App Router, Tailwind 4, shadcn, Motion, Recharts, TanStack Table v9. Calls the API.
- `apps/api`: Hono on `@hono/node-server`. Public REST API, agent runs and approvals, simulators, and the croner routine scheduler (a long-lived process; do not put the scheduler in Next).
- `apps/mcp`: stdio MCP server built from the same tool registry as the agent.
- `packages/db`: Drizzle schema, libsql `file:` database, drizzle-kit migrations, seeded faker generator (`faker.seed`).
- `packages/payroll-tax`: pure functions, integer cents, year-keyed tables, golden tests.
- `packages/core`: domain services (people, payroll runs, benefits, devices, contractor payments), each tool defined once with zod.
- `packages/agent`: `Provider` interface with `anthropic.ts` (official SDK, `claude-opus-5-5`, `output_config.effort`, beta `fallbacks: "default"`), `openai-compatible.ts` (openai client, `baseURL` to mlx_lm.server or llama-server), `scripted.ts` (deterministic replay for tests); a persisted, resumable loop with approval rows.
- `packages/simulators`: IRS, state agencies, ACH bank, benefits carriers, SaaS (Google Workspace, Slack style) fakes behind interfaces.

Priority order if time runs short: (1) DB schema + seed + payroll-tax package with golden tests, (2) payroll run end to end through the API (draft, preview, approve, pay via bank simulator, filings via agency simulator), (3) agent loop with approvals on the scripted provider, then Claude and local providers, (4) web UI for people, payroll run and agent inbox, (5) MCP server and routines.

## Sources

- GitHub API (`gh api`, 2026-10-15): repos/{frappe/hrms, horilla/horilla-hr, orangehrm/orangehrm, gamonoid/icehrm, CybroOdoo/OpenHRMS, ever-co/ever-gauzy, midday-ai/midday, twentyhq/twenty, zero8dotdev/avkash, dubbl-org/dubbl, molecule-dev/molecule, PSLmodels/Tax-Calculator, PolicyEngine/policyengine-us, Payroll-Engine/PayrollEngine, VonHoltenCodes/SlowBooks-Pro-2026, highoncarbs/Hafta, satnaing/shadcn-admin, Kiranism/next-shadcn-dashboard-starter, anthropics/anthropic-sdk-typescript, anthropics/claude-agent-sdk-typescript, vercel/ai, mastra-ai/mastra, langchain-ai/langgraphjs, modelcontextprotocol/typescript-sdk, honojs/hono, drizzle-team/drizzle-orm, Hexagon/croner, shadcn-ui/ui, TanStack/table, recharts/recharts, motiondivision/motion} plus their `/license` and `/contents` endpoints.
- GitHub search (`gh search repos` and `search/repositories` with `topic:hrms`, `topic:payroll`, `topic:hris`, with and without `language:TypeScript`).
- npm registry (`npm view <pkg> version time engines license dist-tags dependencies peerDependencies`), 2026-10-15; `npm search payroll tax`.
- Web: https://github.com/midday-ai/midday, https://github.com/frappe/hrms, https://github.com/horilla/horilla-hr, https://github.com/anthropics/claude-agent-sdk-typescript, https://ui.shadcn.com/docs/components/data-table, https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling, https://mastra.ai/docs/agents/overview, https://dealroom.co/news/135998-warp-lands-60m-series-b-to-automate-payroll-compliance-and-hr-with-ai/, https://letsdatascience.com/news/warp-raises-60m-to-automate-hr-workflows-0b7a1611, https://www.shyft.ai/tools/alternatives/warp, https://capterra.com/p/131882/Gusto/alternatives/, https://libraries.io/pypi/tenforty, https://docs.rs/paycheck-utils.
- Bundled Claude API docs: `/private/tmp/claude-501/bundled-skills/2.1.299/29a7ff8b7a71aa7db21b9e598e16094f/claude-api/typescript/claude-api/{README.md,tool-use.md}` and `.../claude-api/shared/model-migration.md`.
- Local tests: `$S/install-test` (first install, release-age and build-script errors), `$S/t2` (pinned install, `src/smoke.ts`, Next build in `app/`, drizzle-kit in `db/` + `drizzle.config.ts`, vitest in `tests/`), `$S/bsq` (better-sqlite3 compile), `$S/molecule` (downloaded molecule source for reading), `$S/pick.py` (pin selection).
- Local installs: `~/Developer/projects/_models/mlx-venv` (mlx 0.32.3, mlx_lm 0.32.0), `/opt/homebrew/bin/llama-server`, `~/Library/Caches/ms-playwright`.
