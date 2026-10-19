# Telemetry: tracing the agent into a local Phoenix

Wave 4 traces every agent run with OpenTelemetry spans that follow the OpenInference conventions, so a local Arize
Phoenix can show what the agent read, called and answered, and where it went wrong. The design is binding in
`research/wave4/phoenix.md` and `docs/wave4.md` section 3; this page is how to use it and what the code does.

## Turning it on

```bash
pnpm phoenix:up                          # Phoenix 20.23.0 on 127.0.0.1:6206, data in ~/Developer/projects/weft-notes/phoenix,
                                         # then Weft's model prices into it (see "Cost: Weft and Phoenix"), then the cost,
                                         # traces and metrics links of project WEFT_PHOENIX_PROJECT (default weft-demo)
WEFT_TRACE=phoenix pnpm dev              # the API registers the provider and exports OTLP over HTTP
open http://127.0.0.1:6206               # browse projects, traces, sessions
pnpm phoenix:status                      # running or not, and the same links when the project exists
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
WEFT_PHOENIX_SMOKE_URL=http://127.0.0.1:4900 npx vitest run --project @weft/tests tests/telemetry-phoenix.test.ts tests/phoenix-pricing.test.ts tests/phoenix-links.test.ts
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
Phoenix ignores those attributes and prices every span with an `llm.model_name` and token counts itself, from its
model table. Its bundled manifest charges Luna cache writes at $0.25 per million, while `cost.ts` charges them at the
input rate ($0.20, "OpenAI has no write surcharge"), so out of the box Phoenix read $0.001840 for a step Weft booked at
$0.001576.

**Phoenix prices like `cost.ts`.** `pnpm phoenix:up` (on start, and again when it finds Phoenix already running) and
the eval runner's `--phoenix` setup call `scripts/phoenix-pricing.ts`, which upserts one custom model per
`PRICES_BY_MODEL` entry through Phoenix's GraphQL API: `gpt-5.6-luna (weft cost.ts)` and `gpt-5.6-terra (weft
cost.ts)`, provider `openai`, a name pattern anchored on the exact model id (`^gpt-5\.6-luna$`), and input,
cache read, cache write, output and reasoning at the rates `cost.ts` charges. Phoenix ranks custom models above its
built-in ones, so every span ingested after the sync is priced as the ledger prices it; spans already stored keep the
price they were ingested with. The sync is idempotent (`kept ...` on a second run), touches no other custom model,
and prints one warning line instead of failing when Phoenix cannot be reached. Which rate OpenAI bills for cache
writes is still for the `cost.ts` owner to settle; Phoenix now follows whatever `cost.ts` says. Checked on
2026-10-18 on a private Phoenix 20.23.0: a live DE 2088 routine run (two Luna steps, 9,811 tokens) cost $0.00115276 in
Phoenix and 1,154 micros in the ledger, which rounds each step up to the micro.

**Where Phoenix shows a project's cost.** The Stats panel on a project's Spans tab (Total Cost) adds up the cost of
the spans its filter selects, and the tab opens with the filter `parent_id is None`: root spans only. A Weft root is
`agent.run`, which carries no token counts (OpenInference puts tokens and cost on the LLM span; pricing the root too
would count every run twice), so with that default filter Total Cost reads $0 however many runs the project holds.
Phoenix has no setting for a project's default filter, so the scripts print links that open the right views instead
(`scripts/phoenix-links.ts`):

```
Phoenix project weft-demo, last 7 days:
  cost     http://127.0.0.1:6206/projects/<id>/spans?spanFilterCondition=span_kind+%3D%3D+%27LLM%27&timeRangeKey=7d
           the Spans tab filtered to span_kind == 'LLM'; Stats, Total Cost is the model spend (the tab's own root-span filter reads $0)
  traces   http://127.0.0.1:6206/projects/<id>/traces?timeRangeKey=7d
  metrics  http://127.0.0.1:6206/projects/<id>/metrics?timeRangeKey=7d
```

`pnpm phoenix:up` prints them for `WEFT_PHOENIX_PROJECT` (default `weft-demo`, the demo's project), creating the project
empty through `POST /v1/projects` when no run has reached it yet, so the id in the link exists before the first trace
(spans exported later under that name land in it). `pnpm phoenix:status` prints them when the project exists and
`pnpm demo:scenario trace-mcp` prints them after the click path. Phoenix reads the Spans filter from the
`spanFilterCondition` query parameter and the range from `timeRangeKey`, which the links pin to Phoenix's own default
(7 days) so a range picked earlier in the browser does not hide the runs. To read the project's cost:

- The cost link (Spans tab, filter `span_kind == 'LLM'`): Total Cost is the sum over every model call in the time
  range.
- The metrics link (Metrics tab): the Cost chart (prompt and completion per day) and Top models by cost.
- One run: the trace header's Total Cost adds up every span in the trace; the exact figure for each call is on its
  `llm.responses` span. Phoenix prints any amount under a cent as `<$0.01`.

Checked on 2026-10-19 on a private Phoenix 20.23.0 with a live DE 2088 routine run traced into project `weft-demo`
(three Luna steps, 14,654 tokens, 1,190 micros in the ledger): Phoenix's cost summary was $0 under `parent_id is None`
and $0.00118888 under `span_kind == 'LLM'` and with no filter; the cost link opened the Spans tab with that filter in
the box and Stats, Total Cost `<$0.01`, and the Metrics Cost chart peaked at $1.2e-3. `tests/phoenix-links.test.ts`
repeats the check against a private Phoenix (`WEFT_PHOENIX_SMOKE_URL`): an agent.run root with one priced
llm.responses child reads $0 under the root filter and the priced amount under the link's filter.
