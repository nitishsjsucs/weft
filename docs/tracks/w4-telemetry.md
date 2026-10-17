# Track w4-telemetry

Rounds 1 and 2, 2026-10-16. Branch `track/w4-telemetry`. How to use it: `docs/telemetry.md`.

## Done in round 1

## Done

- `packages/agent/src/otel.ts`: the span builder. AGENT per `runLoop` call, CHAIN per stage (admission, assemble,
  model per attempt, dispatch per batch, post, terminal), LLM per provider call built from the loop's own request and
  `Usage` (cached, cache write and reasoning tokens, `llm.cost.*` from `cost.ts`, never the key, headers, cache key
  value or encrypted reasoning), TOOL per call with `weft.outcome`, `weft.refusal_code` and `weft.proposal_id`
  (refusals keep status UNSET), GUARDRAIL for the chat grounding check and the terminal taint read. `session.id`,
  `user.id`, `metadata` (`TraceRunMeta`) and `tag.tags` are set in context once per run; eval fields come from
  `runTraceTags`. The tracer is looked up on every span. A run that is not a child run starts its own trace.
- Redaction at the source through the injected Redactor, plus a bounded redaction memory for bare values quoted later
  without their context (found by the canary: the grounding check and repair notice repeated a bare routing number).
- `packages/agent/src/loop.ts`: instrumented at the existing stage boundaries; behavior and rows unchanged.
  `packages/agent/src/runtime.ts`: the acting principal goes into `RunSetup.principal` (chat: `principalId` from the
  context source, else the `(usr_...)` id in `actingFor`; routines: the owner).
- `apps/api/src/telemetry.ts`: `startTracing` and `startTracingFromEnv` behind `WEFT_TRACE=phoenix`, OTLP over HTTP
  through `@arizeai/phoenix-otel@2.2.0`, loopback only, `RedactingSpanProcessor.onEnding` first in the chain, flush
  on SIGINT, SIGTERM and beforeExit. Wiring: one `setTraceRedactor` line in `compose.ts`, the import and one call in
  `main.ts`.
- Pins: `@opentelemetry/api@1.9.1`, `@arizeai/openinference-semantic-conventions@2.14.0`,
  `@arizeai/openinference-core@2.8.0` in the agent (test only: `@opentelemetry/sdk-trace-base@2.12.0`,
  `@opentelemetry/context-async-hooks@2.12.0`); `@arizeai/phoenix-otel@2.2.0`, `@opentelemetry/api@1.9.1` and
  `@opentelemetry/sdk-trace-base@2.12.0` in apps/api.
- Shared change (separate commit titled `contract:`): `pnpm-workspace.yaml` gains a package extension that makes
  `@opentelemetry/api` a plain dependency of `drizzle-orm@0.45.4`. Without it the agent's OTel dependency made pnpm
  build a second drizzle variant (drizzle lists the API as an optional peer) whose types do not mix with `@weft/db`.
- Tests: `packages/agent/test/otel.test.ts` (7) and `tests/telemetry-api.test.ts` (7) run in `pnpm test`;
  `tests/telemetry-phoenix.test.ts` (3) runs only with `WEFT_PHOENIX_SMOKE_URL` and passed against a private Phoenix
  20.23.0 on 127.0.0.1:4900 (spans by kind, by `weft.outcome`, by session, and the session list).
- Live: one traced chat on gpt-5.6-luna into the private Phoenix, $0.001576 recorded in the wave ledger
  (stage w4-telemetry, cap $0.10). Phoenix and Weft agree on every token class except cache writes, which Phoenix's
  manifest prices at $0.25 per million and `cost.ts` at the $0.20 input rate (details in `docs/telemetry.md`).

## Done in round 2

- RETRIEVER spans. `memory.recall` under the run's first `assemble` span, read from the `<recall>` block the runtime
  packed (`recallDocs`; recall returns only the rendered block, so the documents carry path, kind, date and the
  untrusted flag but no score), shown once per run, not again after a wake. `memory.search` under every
  `memory__search` TOOL span, with each hit as a document (cite, snippet, path, line, commit, taint).
- MCP spans. `packages/executor/src/pipeline.ts` gained an optional call observer for calls from the MCP surface
  (`engine.observeCall`); it imports no OpenTelemetry, swallows observer failures and returns the outcome unchanged.
  One wiring line in `compose.ts` sets it to `traceMcpCall`, which opens a root TOOL span per call: `user.id` is the
  key's principal, `tag.tags` `["mcp", <name>]`, `metadata.kind` `mcp`, `weft.outcome`, `weft.refusal_code`,
  `weft.proposal_id`, `weft.tainted`, and the RETRIEVER child for memory search. UI and admin key calls open no span.
- The runtime's zero-token wake is now traced: a short AGENT segment (`weft.segment = zero_token_wake`, every other
  segment says `loop`) with a `terminal` CHAIN carrying the checklist count, in the run's session.
- Shared change (separate commit titled `contract:`): `packages/agent/src/index.ts` also exports `traceMcpCall` and
  `McpCallInfo`. Additive; the seam signatures are unchanged.
- Tests: `packages/agent/test/otel.test.ts` 12 (adds recall parsing, both RETRIEVERs in a chat run, `traceMcpCall`
  spans, an MCP canary, the wake segment; the chat canary now plants its secret in a real recall line).
  `tests/telemetry-api.test.ts` 10 (adds the MCP tree through HTTP with the seeded mcp key, and the MCP canary with
  the real Redactor with and without the processor; the switch test also makes an MCP call).
  `tests/telemetry-phoenix.test.ts` 4, passed against a private Phoenix 20.23.0 on 127.0.0.1:4900 (pgid 73771,
  stopped, ports closed, scratch data removed): MCP root TOOL spans by kind, by `weft.outcome` and by `user.id`, and
  the RETRIEVER's parent.
- No live model calls in round 2 (stage spend stays $0.001576 of $0.10).

## Acceptance

| Item | State |
|---|---|
| Scripted chat, routine and MCP runs export the documented tree | yes: in-memory through `createWeft` for all three, and read back from a private Phoenix |
| Canary with and without the processor | yes, for a chat run and for MCP calls, with the real Redactor through `createWeft` and a stand-in in the brain's tests |
| `WEFT_TRACE` unset installs no provider and sends nothing | yes (a chat run and an MCP call) |
| Spans read back from a private Phoenix by kind, `weft.outcome` and session | yes (plus by `user.id` for MCP) |
| Phoenix's computed cost agrees with `cost.ts` on a live run | agrees on every token class except the cache write rate, a pricing question for the `cost.ts` owner |
| No parity track file touched | yes |

Verification at the end of round 2: `pnpm test` 920 passed and 5 skipped (the 4 gated Phoenix tests and 1 that was
already skipped), `pnpm typecheck` 16/16, `lint:prose`, `lint:brand` and `brand:overlap` ok. No UI changed, so no
Playwright spec was added.

## Left (also in `.scratch/w4-telemetry/left.md`)

1. Chat `session.id`. The thread id reaches `openChatRun` but neither `exec_runs` nor `agent_runs` (`baseRow` sets
   null), so chat runs get a session only from eval tags. Needs `threadId` in the `startChat` input or on the handle
   (contract request; `packages/executor/src/runs.ts` and the agent route are not this track's).
2. `apps/api/src/routes/agent.ts` should return `principalId` from `ChatContextSource.chat` so `user.id` does not
   depend on parsing `actingFor` (the optional field exists).
3. The gpt-5.6-luna cache write price (`cost.ts` $0.20 input rate versus Phoenix's $0.25 per million).
4. Not traced: the runtime's PROCESS_RESTART failure rows at boot (no run segment exists for them). An exception
   inside `runLoop` is already on the AGENT span.
5. A child run nesting test: the code nests a run with `parentRunId` under the dispatching TOOL span, but the loop has
   no task agent path to drive it from a test yet.
6. MCP spans have no `session.id` (no contract names one for MCP); group them by `user.id` and the `mcp` tag.
