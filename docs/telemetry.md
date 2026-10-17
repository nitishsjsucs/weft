# Telemetry: tracing the agent into a local Phoenix

Wave 4 traces every agent run with OpenTelemetry spans that follow the OpenInference conventions, so a local Arize
Phoenix can show what the agent read, called and answered, and where it went wrong. The design is binding in
`research/wave4/phoenix.md` and `docs/wave4.md` section 3; this page is how to use it and what the code does.

## Turning it on

```bash
pnpm phoenix:up                          # Phoenix 20.23.0 on 127.0.0.1:6206, data in ~/Developer/projects/weft-notes/phoenix
WEFT_TRACE=phoenix pnpm dev              # the API registers the provider and exports OTLP over HTTP
open http://127.0.0.1:6206               # browse projects, traces, sessions
pnpm phoenix:down
```

| Variable | Meaning |
|---|---|
| `WEFT_TRACE` | `phoenix` turns tracing on in `apps/api` (and the eval runner). Unset installs no provider: the OTel API stays a no-op and nothing is sent. Any other value logs one line and stays off. |
| `WEFT_PHOENIX_URL` | Phoenix base URL. Default `http://127.0.0.1:<WEFT_PHOENIX_PORT or 6206>`. Only loopback hosts are accepted; a hosted Arize URL is refused. |
| `WEFT_PHOENIX_PROJECT` | Phoenix project. Default `weft`. An eval trial's spans live in its experiment's project, which `runExperiment` names `Experiment-<id>` (find it in the experiments list or through the compare URL in the suite report); `weft-eval-<date>-<sha>-<variant>` is the experiment name, not a project. |

A builder who needs a Phoenix for a smoke test starts a private one on its own ports and stops it:

```bash
WEFT_PHOENIX_PORT=4900 WEFT_PHOENIX_GRPC_PORT=4901 WEFT_PHOENIX_DIR=$PWD/.scratch/<track>/phoenix npx tsx scripts/phoenix.ts up
WEFT_PHOENIX_SMOKE_URL=http://127.0.0.1:4900 npx vitest run --project @weft/tests tests/telemetry-phoenix.test.ts
WEFT_PHOENIX_PORT=4900 WEFT_PHOENIX_GRPC_PORT=4901 WEFT_PHOENIX_DIR=$PWD/.scratch/<track>/phoenix npx tsx scripts/phoenix.ts down
```

From code (the eval runner, scripts): `startTracing({ url, projectName, batch })` from `apps/api/src/telemetry.ts`
returns `{ forceFlush, shutdown }`; call `shutdown()` before the process exits or the last batch is lost. Set the eval
fields with `runTraceTags.set({ eval_task_id, eval_split, eval_variant, eval_trial, golden_path, harness_sha })`
from `@weft/agent` before a trial and `runTraceTags.set(null)` after.

## The span tree

One trace per `runLoop` call (`weft.segment = loop`). A run woken after an approval is a second trace with the same
`weft.run_id` and `session.id`; a zero-token wake that finishes the run in code (the checklist passed and nothing is
pending) is a short trace of its own, `weft.segment = zero_token_wake`, with only a `terminal` CHAIN under it.

```
agent.run                 AGENT      input = the chat turn or "routine: <id> ..." and the trigger; output = the summary
├── admission             CHAIN      weft.outcome (ok or refused:BUDGET_EXCEEDED), reserve micros, weft.step_n
├── assemble              CHAIN      items, estimated input tokens, weft.prefix_hash
│   └── memory.recall     RETRIEVER  the run-start recall (first assemble of the run only): query in, the <recall> lines as documents
├── model                 CHAIN      weft.attempt, weft.stop, weft.request_id (one per attempt, retries included)
│   └── llm.responses     LLM        messages, tools, invocation parameters, tokens (cached, cache write, reasoning), llm.cost.*
├── dispatch              CHAIN      batch size, the model step it came from
│   └── <tool wire name>  TOOL       tool.id = call id, tool.parameters, output = the outcome, weft.outcome, weft.refusal_code, weft.proposal_id
│       └── memory.search RETRIEVER  under memory__search only: the query, each hit as a document (cite, snippet, path, line, taint)
├── post                  CHAIN      the recited plan, a notice (repair, budget), or the chat answer check
│   └── grounding.check   GUARDRAIL  the answer in, weft.grounded and the unmatched numbers out
└── terminal              CHAIN      weft.status, weft.terminal_reason
    └── taint.check       GUARDRAIL  weft.tainted, weft.tainted_by, pending proposals
```

The recall RETRIEVER is a projection of the block the runtime packed into the context (recall returns only the
rendered block, so there are no scores); `weft.source = context_pack` says so. Untrusted lines carry
`metadata.untrusted = true`.

**MCP calls.** An MCP client calls `POST /v1/tools/:name`, which runs in the executor and never enters the loop. The
executor's pipeline has an optional call observer for calls from the MCP surface (`engine.observeCall`, set in
`compose.ts` to `traceMcpCall` from `@weft/agent`; the executor imports no OpenTelemetry). Each call is a root trace:

```
<tool wire name>          TOOL       user.id = the key's principal, tag.tags = ["mcp", <name>], metadata.kind = mcp,
│                                    weft.outcome, weft.refusal_code, weft.proposal_id, weft.tainted (always true: MCP input is untrusted)
└── memory.search         RETRIEVER  for memory__search, as above
```

A person's own UI or API key calls open no span. An `agent_ask` from MCP starts an ordinary chat run, traced as above.

Every span carries, from context set once at run start: `session.id` (the chat thread id, else
`routine_run:<id>`, else the eval task id), `user.id` (the acting principal, `routine:<id>` for unattended
routines), `metadata` (`TraceRunMeta`: run, company, kind, trigger, attended, provider, model, prompt version, routine,
routine run, the eval fields and `chat_can_propose`) and `tag.tags` (for example `["routine","rt_agency_notice"]`,
`["chat","eval","EX-01","variant:default"]`).

Status rules: a refusal is the harness doing its job, so a refused TOOL span keeps status UNSET and is found by
`weft.outcome`. ERROR is only for an executor exception (`weft.outcome = error`), a provider failure on the LLM and
model spans, and a run that failed.

Runs are root traces unless they are child runs (`parentRunId`): a routine started by an event from another run's
tool call does not nest under that call.

## Queries that work (Phoenix REST)

```bash
PHX=http://127.0.0.1:6206; P=weft
curl -s "$PHX/v1/projects/$P/spans?span_kind=TOOL&attribute=weft.outcome:%22proposal%22"
curl -s "$PHX/v1/projects/$P/spans?span_kind=TOOL&attribute=weft.refusal_code:%22UNAVAILABLE%22"
curl -s "$PHX/v1/projects/$P/spans?attribute=session.id:%22routine_run:rtr_...%22"
curl -s "$PHX/v1/projects/$P/sessions"
curl -s "$PHX/v1/projects/$P/spans?span_kind=RETRIEVER"                                   # recall and memory search
curl -s "$PHX/v1/projects/$P/spans?span_kind=TOOL&attribute=user.id:%22usr_...%22"        # MCP calls (parent_id null) by key principal
```

Ingestion is asynchronous: right after a flush a query can come back empty or short, so poll.

## Secrets never reach a span

1. **At the source** (`packages/agent/src/otel.ts`): every attribute value, string or JSON, passes through the
   executor's `Redactor.value`, which `apps/api/src/compose.ts` injects with `setTraceRedactor` (the brain never
   imports the vault). Spans are built from Weft's copies: the tool outcomes the model saw (already redacted by the
   executor) and the request the loop assembled. A redaction memory also removes, anywhere later in the process, every
   token the redactor once removed, because code can quote a bare value without its context (the grounding check
   lists an unmatched "021000021" that was a routing number in the answer).
2. **Never captured**: HTTP headers, the client config, the API key, the `prompt_cache_key` value (only
   `prompt_cache_key_set`), encrypted reasoning (only reasoning summary text), raw exceptions (an exception event
   carries the redacted message and no stack).
3. **Processor**: `RedactingSpanProcessor.onEnding` in the API's provider re-runs the redactor over every string
   attribute, event attribute and status message. It does not exist inside Phoenix's `runExperiment` provider, which is
   why layer 1 is the one that counts and why the tracer is looked up on every span. The eval's Task span output (the
   trial record with its error, first failure and grader reasons) is passed through the trace redactor in
   `evals/suite/phoenix.ts` before `runExperiment` sees it.

Layer 1 also redacts provider key shapes (`sk-`, `sk-proj-`, `sk-ant-`, derived from `SECRET_PATTERNS` in the
telemetry contract) that nothing registered, such as a key pasted into chat, and the redaction memory evicts its
oldest token when full instead of refusing new ones.

### Phoenix on the network

`pnpm phoenix:up` binds HTTP to 127.0.0.1 through `PHOENIX_HOST`. Phoenix 20.23.0 binds its OTLP gRPC collector to
`[::]` whatever that says and cannot turn gRPC off, so the script starts the server through
`scripts/phoenix-loopback.py`, which rewrites that bind to 127.0.0.1, and checks with lsof that every listening port is
loopback; otherwise it stops the process group and refuses to report ready (`phoenix:status` warns too). An instance
started before this change still listens on all interfaces for gRPC: restart it. The eval runner and its OTLP capture
proxy refuse a Phoenix URL that is not loopback, like `startTracing` and the judge label store.

Accepted risk: Phoenix runs with auth off and does not check the Host header, so a web page using DNS rebinding could
read traces and datasets from 127.0.0.1. The data is synthetic and holds no secrets (redacted at the source and
checked), and plain cross-origin reads are blocked because Phoenix sends no CORS header. If that changes, put Phoenix
behind a loopback proxy that rejects other Host values or turn on `PHOENIX_ENABLE_AUTH` with `PHOENIX_SECRET` in the
secrets file.

### Labels on traces before `4c7eb1c`

Before `4c7eb1c`, every default-variant chat run in the baseline and round 1 intermediate experiments was stamped
`metadata.chat_can_propose = true`, though it was offered only read tools. For those experiments filter on
`metadata.eval_variant`, not `metadata.chat_can_propose`. Round 1, round 2 and later are labeled correctly.

Tests: `packages/agent/test/otel.test.ts` (span tree for chat and routine runs, both RETRIEVERs, MCP spans and the
zero-token wake segment, a canary that plants a fake key and a vault value in raw, base64 and hex form plus routing and
account numbers in a tool result, tool arguments, model text, an error message, an exception, a recalled memory line
and MCP arguments, hits and refusals, and a control run that proves the canary would catch a leak) and
`tests/telemetry-api.test.ts` (the switch, the tree through `createWeft` for a chat, the GP1 routine and MCP calls with
the seeded mcp key, and the canary with the executor's real Redactor with and without the processor, for a chat and
for MCP calls). `tests/telemetry-phoenix.test.ts` reads the same spans back from a private Phoenix.

## Cost: Weft and Phoenix

LLM spans carry Weft's own figures: `llm.cost.total` is the ledger's `costUsdMicros / 1e6` and the split
(`llm.cost.prompt`, `.prompt_details.input`, `.cache_read`, `.cache_write`, `llm.cost.completion`) follows `cost.ts`.
Phoenix computes its own cost from `llm.model_name`, `llm.provider` and the token counts with its bundled price
manifest. On the live gpt-5.6-luna run of 2026-10-16 (two model steps, 9,288 prompt tokens of which 3,999 cache reads
and 5,283 cache writes, 365 completion tokens) the two agree on every token class except cache writes: Phoenix's
manifest prices Luna cache writes at $0.25 per million, while `cost.ts` charges them at the input rate ($0.20, "OpenAI
has no write surcharge"). Phoenix said $0.001840, Weft $0.001576; with cache writes at $0.20 Phoenix's per span
numbers equal Weft's to the micro. Which rate OpenAI bills is for the `cost.ts` owner to settle; until then read
Weft's `llm.cost.*` as the ledger and Phoenix's cost columns as an upper bound.
