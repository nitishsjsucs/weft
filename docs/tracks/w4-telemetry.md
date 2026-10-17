# Track w4-telemetry

Round 1, 2026-10-16. Branch `track/w4-telemetry`. How to use it: `docs/telemetry.md`.

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

## Acceptance

| Item | State |
|---|---|
| Scripted chat, routine and MCP runs export the documented tree | chat and routine yes (in-memory and Phoenix); MCP not yet (see left) |
| Canary with and without the processor | yes, with the real Redactor through `createWeft` and a stand-in in the brain's tests |
| `WEFT_TRACE` unset installs no provider and sends nothing | yes |
| Spans read back from a private Phoenix by kind, `weft.outcome` and session | yes |
| Phoenix's computed cost agrees with `cost.ts` on a live run | agrees except the cache write rate, a pricing question for the `cost.ts` owner |
| No parity track file touched | yes |

## Left (also in `.scratch/w4-telemetry/left.md`)

1. MCP spans. MCP calls go `POST /v1/tools/:name` to `executor.human.exec` and never enter the loop. Plan: an
   observer hook in `packages/executor/src/pipeline.ts` (no OTel import in the executor) that `compose.ts` wires to an
   otel.ts function, giving a root TOOL span per MCP call with `user.id` the key's principal.
2. RETRIEVER spans: memory recall at run start (the context source returns a rendered block; it needs the hits) and a
   child RETRIEVER under the `memory__search` TOOL span from the outcome's hits.
3. Chat `session.id`: the thread id reaches `openChatRun` but not `agent_runs` (`baseRow` sets null), so chat runs get a
   session only from eval tags. Needs `threadId` in the `startChat` input (contract request).
4. `ChatContextSource.chat` may now return `principalId`; `apps/api/src/routes/agent.ts` should return it so user.id
   does not depend on parsing `actingFor`.
5. The cache write price for gpt-5.6-luna (`cost.ts` $0.20 versus Phoenix $0.25 per million).
6. Not traced yet: the zero-token wake and the runtime's own failure rows (outside `runLoop`), and a child run nesting
   test (no task agent path in the loop to drive it from).
