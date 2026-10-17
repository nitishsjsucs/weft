# Phoenix tracing for Weft's agent loop

Researched 2026-10-16 for wave 4. Audience: the wave 4 builder who adds tracing to `packages/agent` and the eval
track that measures the agent. Weft code read on main `ba38559`. Nothing here is committed; Phoenix data never enters
the repo.

## 0. How to read this file

Evidence marks:

- **[V]** I ran it on this machine on 2026-10-16 (Phoenix 20.23.0 from `uvx`, Node 25.9.0, pnpm 12.3.4) and saw the
  result. Section 11 is the log.
- **[S]** I read it in the installed package source or `.d.ts` of the exact version named (npm tarballs, or the
  Phoenix wheel in the uv cache). Not run unless also [V].
- **[D]** a first-party docs page or spec states it (arize.com/docs/phoenix, github.com/Arize-ai/openinference).
  Not tested.
- **[C]** I read the Weft file named next to it.
- **[R]** my recommendation. Not a fact.

## 1. Summary and recommendations

1. **Server**: Phoenix **20.23.0** (PyPI and Docker, published 2026-10-16 03:22 UTC) [V]. Run it with
   `uvx --python 3.13 --from arize-phoenix==20.23.0 phoenix serve` [V]; Docker is the alternative but the daemon is not
   running on this Mac, so the Docker path is [D] only. Persist with `PHOENIX_WORKING_DIR=~/Developer/projects/weft-notes/phoenix`;
   Phoenix writes `phoenix.db` (SQLite, WAL mode) there and the data survives a restart [V].
2. **License**: the Phoenix server is **Elastic License 2.0 (ELv2)** [V, LICENSE file and PyPI metadata]. The npm
   packages Weft would import are **Apache-2.0** [V, npm]. ELv2 forbids offering Phoenix to third parties as a hosted or
   managed service; running it locally for Nitish is fine. Weft does not ship or vendor Phoenix, so Weft's own license
   is unaffected [R].
3. **Packages** [R]: the brain (`packages/agent`) depends only on `@opentelemetry/api@1.9.1`,
   `@arizeai/openinference-semantic-conventions@2.14.0` and `@arizeai/openinference-core@2.8.0` (attribute builders and
   the masking tracer, no exporter). The composition root (`apps/api`, and `evals/` scripts) depends on
   `@arizeai/phoenix-otel@2.2.0` to register the provider and export OTLP/HTTP protobuf. Evals use
   `@arizeai/phoenix-client@7.16.1` for datasets, experiments, annotations and span queries. **Do not** use
   `@arizeai/openinference-instrumentation-openai` (reasons in 5.3).
4. **Model of the loop** [R]: one `AGENT` span per run, one `CHAIN` span per stage row (admission, assemble, model,
   dispatch, post, terminal), one `LLM` span per provider call built from Weft's own request snapshot and `RawUsage`,
   one `TOOL` span per executor call carrying `weft.outcome` (`ok`, `proposal`, `refused:<CODE>`, `error`), `RETRIEVER`
   for memory recall and `memory.search`, `GUARDRAIL` for grounding and taint. `session.id` is the chat `threadId`,
   `user.id` is the acting principal, `metadata` carries run, routine, golden path and eval task ids. Verified end to
   end with a synthetic run (section 11).
5. **Secrets** [R]: redact at the source with Weft's own `Redactor` (injected from `apps/api/src/compose.ts`, because
   the brain may not import `@weft/executor/src/vault`), plus a second-line `onEnding` span processor in the process
   provider. The second line does **not** exist inside `runExperiment`'s own provider (5.6, [S]), so the source
   redaction is the one that counts. Both verified with Weft's real `Redactor` against a fake secret [V].
6. **Evals** [R]: Phoenix datasets of eval tasks, `runExperiment` with code evaluators (outcome, tool choice, grounding,
   cents) plus at most one LLM judge that calls gpt-5.6-luna **through Weft's own provider** so the spend ledger and
   live guard see every judge call. `concurrency: 1` for live runs. Verified dataset, experiment, code evaluator and span
   annotation round trips with no model spend [V].
7. **Local only** [R]: bind `PHOENIX_HOST=127.0.0.1`, set `PHOENIX_TELEMETRY_ENABLED=false` and
   `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`. Gotcha: the **gRPC collector ignores `PHOENIX_HOST` and binds `[::]`**
   (all interfaces) [V, S]. Weft does not need gRPC, so give it an assigned unused port and never send to it.

## 2. The Phoenix server

### 2.1 Version and install

| Item | Value | Mark |
|---|---|---|
| PyPI `arize-phoenix` latest | 20.23.0, uploaded 2026-10-16T03:22:46Z; previous 20.22.0 (2026-10-15), 20.21.4 (2026-10-14) | [V] |
| Python requirement | `>=3.11, <3.15` | [V] PyPI |
| Docker image | `arizephoenix/phoenix:20.23.0` (also `version-20.23.0`, `20.23`, `20`); arm64 digest `sha256:cb0975a5944be0e3a83587a56d96ea93f3c079dc1f093bc5acc05f96dac265c5`, amd64 `sha256:a43943f707669bf758c05fdda4c11659047293bfacacdc46fbaaff30646b72d3` | [V] Docker Hub API |
| Release cadence | several releases a day this week; `nightly` and `commit-*` tags exist | [V] |

Pin the exact version everywhere [R]. 20.23.0 is one day old; if it misbehaves, 20.22.0 is the fallback pin. Never use
`latest` or `nightly`.

**uv (verified path)** [V]:

```bash
# one-off, cached by uv; downloads CPython 3.13 on first use
PHOENIX_PORT=6116 PHOENIX_GRPC_PORT=6117 PHOENIX_HOST=127.0.0.1 \
PHOENIX_WORKING_DIR="$HOME/Developer/projects/weft-notes/phoenix" \
PHOENIX_TELEMETRY_ENABLED=false PHOENIX_ALLOW_EXTERNAL_RESOURCES=false \
uvx --python 3.13 --from arize-phoenix==20.23.0 phoenix serve

# or install once as a tool, then run `phoenix serve` with the same env
uv tool install --python 3.13 arize-phoenix==20.23.0
```

First `uvx` run took about a minute (CPython download plus wheels); later starts were a few seconds [V].

**Docker (docs path, not run here)** [D]: the docs give
`docker run -p 6006:6006 -p 4317:4317 -i -t arizephoenix/phoenix:latest` and, in their Compose file,
`PHOENIX_WORKING_DIR=/mnt/data` with a volume at `/mnt/data`. The pinned, local-only equivalent [R]:

```bash
docker run --rm --name weft-phoenix \
  -p 127.0.0.1:6116:6006 \
  -e PHOENIX_WORKING_DIR=/mnt/data -e PHOENIX_TELEMETRY_ENABLED=false -e PHOENIX_ALLOW_EXTERNAL_RESOURCES=false \
  -v "$HOME/Developer/projects/weft-notes/phoenix:/mnt/data" \
  arizephoenix/phoenix:20.23.0@sha256:cb0975a5944be0e3a83587a56d96ea93f3c079dc1f093bc5acc05f96dac265c5
```

Publishing only `127.0.0.1:6116` and not mapping 4317 sidesteps the gRPC bind gotcha inside Docker [R].

### 2.2 Ports and environment

| Variable | Default | Meaning | Mark |
|---|---|---|---|
| `PHOENIX_PORT` | 6006 | UI, REST `/v1`, GraphQL, OTLP over HTTP at `/v1/traces`, MCP at `/mcp` | [D], [V] |
| `PHOENIX_GRPC_PORT` | 4317 | OTLP over gRPC | [D], [V] |
| `PHOENIX_HOST` | `0.0.0.0` | bind address of the HTTP server only | [D]; gRPC ignores it [S] `phoenix/server/grpc_server.py:109` `add_insecure_port(f"[::]:{self._port}")`, [V] `lsof` showed `*:6117` |
| `PHOENIX_WORKING_DIR` | `~/.phoenix/` | data dir; default DB is `sqlite:///{working_dir}/phoenix.db` | [D]; DB path [S] `phoenix/config.py:3400`, [V] |
| `PHOENIX_SQL_DATABASE_URL` | unset | Postgres or SQLite URL; overrides the working dir DB | [D] |
| `PHOENIX_TELEMETRY_ENABLED` | true | master switch for the UI's FullStory and Scarf pixels | [D], [S] `config.py:158` |
| `PHOENIX_ALLOW_EXTERNAL_RESOURCES` | true | when false, Phoenix makes no public internet requests of its own (web fonts, telemetry, the WASM sandbox binary download) | [S] `config.py:164`; started cleanly with it false [V] |
| `PHOENIX_ENABLE_AUTH` and friends | off | auth; not needed on loopback | [D] |

Note: the configuration page says that with no database URL Phoenix uses SQLite "in a temporary folder". The 20.23.0
code and my run disagree: the DB lands in `PHOENIX_WORKING_DIR/phoenix.db` [S, V]. Trust the code.

What the working dir held after one run [V]: `phoenix.db`, `phoenix.db-wal`, `phoenix.db-shm` (about 1.8 MB for 22
spans, a dataset and an experiment), empty `inferences/` and `trace_datasets/`, and a 25 MB `wasm/` folder (the code
sandbox binary, downloaded at startup because the first start had external resources allowed). With
`PHOENIX_ALLOW_EXTERNAL_RESOURCES=false` from the first start, that download does not happen [S].

### 2.3 Ports for Weft

The brief reserves 6116 for this research. For the wave's long-lived Phoenix, pick one HTTP port and one gRPC port
that are free and not in the do-not-touch list (3070, 4070, 3170, 4170), check with
`lsof -nP -iTCP:<port> -sTCP:LISTEN`, and record them in `docs/status.md` [R]. The exporter only needs the HTTP port.

### 2.4 Starting and stopping cleanly

Start Phoenix in its own process group and kill the group, because `uvx` execs a Python child [V]. The script I used:

```python
# start-phoenix.py WORKDIR   (run with: nohup python3 -I start-phoenix.py "$WD" &)
import os, sys
os.setsid()                                  # new session, so pgid == this pid
wd = sys.argv[1]
env = dict(os.environ, PHOENIX_PORT="6116", PHOENIX_GRPC_PORT="6117", PHOENIX_HOST="127.0.0.1",
           PHOENIX_WORKING_DIR=wd, PHOENIX_TELEMETRY_ENABLED="false", PHOENIX_ALLOW_EXTERNAL_RESOURCES="false")
log = open(os.path.join(os.path.dirname(wd), "phoenix.log"), "ab")
os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
open(os.path.join(os.path.dirname(wd), "phoenix.pgid"), "w").write(str(os.getpgid(0)))
os.execvpe("uvx", ["uvx", "--python", "3.13", "--from", "arize-phoenix==20.23.0", "phoenix", "serve"], env)
```

Stop: `kill -TERM -- -$(cat phoenix.pgid)`, then wait until `lsof` shows neither port listening. SIGTERM shut it down
in under a second and the next start read every span back [V]. macOS has no `setsid` or `timeout` binaries by default,
hence the Python wrapper.

Readiness probe: `GET /arize_phoenix_version` returns the bare version string (`20.23.0`) [V].

## 3. npm packages

All versions checked with `npm view` on 2026-10-16 [V]. All are Apache-2.0 and ship both ESM (`import`) and CJS
(`require`) entry points [V].

| Package | Version | Published | Role for Weft | Use |
|---|---|---|---|---|
| `@opentelemetry/api` | 1.9.1 | 2026-10-13 | `trace`, `context`, `SpanStatusCode` | brain [R] |
| `@arizeai/openinference-semantic-conventions` | 2.14.0 | 2026-10-01 | attribute name constants (`SemanticConventions`, `OpenInferenceSpanKind`, `MimeType`) | brain [R] |
| `@arizeai/openinference-core` | 2.8.0 | 2026-10-01 | `OITracer` (masking), `getLLMAttributes`, `getToolAttributes`, `getRetrieverAttributes`, `getInputAttributes`, `getOutputAttributes`, `setSession`, `setUser`, `setMetadata`, `setTags`, `withSpan`, `traceAgent` | brain [R] |
| `@arizeai/phoenix-otel` | 2.2.0 | 2026-08-07 | `register()` builds a `NodeTracerProvider` with the OTLP proto exporter; re-exports all of openinference-core and semantic conventions | `apps/api`, `evals/` [R] |
| `@arizeai/phoenix-client` | 7.16.1 | 2026-10-09 | typed REST client: `createDataset`, `runExperiment`, `asEvaluator`, `getSpans`, `addSpanAnnotation`, `logSpanAnnotations`, sessions, traces | `evals/`, scripts [R] |
| `@arizeai/phoenix-evals` | 2.6.0 | 2026-09-22 | LLM judge library on the Vercel AI SDK v7; Node `>=22.12` | optional, see 9 [R] |
| `@arizeai/openinference-instrumentation-openai` | 4.4.1 | 2026-10-09 | monkey-patches the `openai` SDK, including `responses.create` | not recommended, see 5.3 |
| `@opentelemetry/sdk-trace-base` | 2.12.0 | 2026-10-06 | `InMemorySpanExporter`, `SimpleSpanProcessor` for unit tests | devDependency [R] |

What `@arizeai/phoenix-otel@2.2.0` pulls in [V, pnpm resolution]: `@opentelemetry/sdk-trace-node@2.12.0`,
`@opentelemetry/context-async-hooks@2.12.0`, `@opentelemetry/exporter-trace-otlp-proto@0.220.0`,
`@opentelemetry/instrumentation@0.220.0`, `@opentelemetry/resources@2.12.0`, `@arizeai/openinference-vercel@3.3.0`.
The newest OTel experimental line is 0.223.0; phoenix-otel's `^0.220.0` range keeps it on 0.220.x. That is fine, but do
not add `@opentelemetry/exporter-*@0.223` beside it or pnpm installs two OTLP stacks [R].

Install commands for Weft [R] (do not run against the main checkout while `pnpm dev` is up; use a worktree):

```bash
pnpm --filter @weft/agent add @opentelemetry/api@1.9.1 @arizeai/openinference-semantic-conventions@2.14.0 @arizeai/openinference-core@2.8.0
pnpm --filter @weft/agent add -D @opentelemetry/sdk-trace-base@2.12.0
pnpm --filter @weft/api add @arizeai/phoenix-otel@2.2.0
pnpm add -w -D @arizeai/phoenix-client@7.16.1 @arizeai/phoenix-otel@2.2.0     # evals/ runs from the root with tsx
```

pnpm 12 note [V]: a fresh install in a scratch project failed the command with `ERR_PNPM_IGNORED_BUILDS` for esbuild
(from `tsx`), after installing everything. The Phoenix and OTel packages themselves did not request build scripts. In
Weft, tsx is already approved, so this should not recur.

## 4. OpenInference conventions Weft needs

From `spec/semantic_conventions.md` and `spec/configuration.md` in `Arize-ai/openinference` [D], cross-checked against
the constants exported by `@arizeai/openinference-semantic-conventions@2.14.0` [S]:

- `openinference.span.kind` is required on every span. Values: `LLM`, `EMBEDDING`, `CHAIN`, `RETRIEVER`, `RERANKER`,
  `TOOL`, `AGENT`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`, `DECISION`. Phoenix's span filter also accepts `UNKNOWN` [S,
  OpenAPI].
- Generic: `input.value`, `input.mime_type`, `output.value`, `output.mime_type` (`text/plain` or `application/json`).
- LLM: `llm.provider` (`openai`), `llm.system` (`openai`), `llm.model_name`, `llm.request.model_name`,
  `llm.response.model_name`, `llm.invocation_parameters` (JSON string), `llm.finish_reason`,
  `llm.input_messages.<i>.message.{role,content,contents,tool_call_id,name}`,
  `llm.output_messages.<i>.message.tool_calls.<j>.tool_call.{id,function.name,function.arguments}`,
  `llm.tools.<i>.tool.json_schema`.
- Tokens: `llm.token_count.prompt`, `.completion`, `.total`, `.prompt_details.cache_read` (OpenAI `cached_tokens`),
  `.prompt_details.cache_write`, `.completion_details.reasoning`.
- Cost (USD floats): `llm.cost.prompt`, `llm.cost.completion`, `llm.cost.total`, `llm.cost.prompt_details.input`,
  `llm.cost.prompt_details.cache_read`, `llm.cost.prompt_details.cache_write`, `llm.cost.completion_details.output`,
  `llm.cost.completion_details.reasoning`.
- Reasoning content parts: `message_content.type = "reasoning"`, with `message_content.id` mapping to the Responses
  reasoning item id "for stateless replay", and `message_content.encrypted_content` for OpenAI's encrypted blob. Weft
  replays statelessly (`store: false`), so the encrypted blob would land in spans if copied; do not copy it [R].
- Tool: `tool.name`, `tool.description`, `tool.parameters` (JSON string), `tool.id` (the call id), `tool.json_schema`.
- Retriever: `retrieval.documents.<i>.document.{id,content,score,metadata}`.
- Context: `session.id`, `user.id`, `metadata` (JSON string), `tag.tags` (string list), `agent.name`,
  `graph.node.id`, `graph.node.parent_id`.
- Feedback in span attributes (newer spec): `annotations.<i>.annotation.{name,label,score,explanation}`. Phoenix's REST
  annotation endpoints are the better path for evals (section 7).

What the JS helpers cover and do not [S, `openinference-core@2.8.0` `helpers/types.d.ts`]:

- `getLLMAttributes({ provider, system, modelName, requestModelName, responseModelName, invocationParameters,
  inputMessages, outputMessages, tokenCount, tools })`. `tokenCount` has `prompt`, `completion`, `total` and
  `promptDetails: { cacheRead, cacheWrite, audio }`. It has **no reasoning tokens and no cost**: set
  `SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING` and `LLM_COST_*` yourself.
- `Message` supports `contents` with `type: "reasoning"` (text, signature, data, encryptedContent).
- `getToolAttributes({ name, description, parameters })`, `getRetrieverAttributes({ documents })`.
- Context setters: `setSession(ctx, { sessionId })`, `setUser(ctx, { userId })`, `setMetadata(ctx, {...})`,
  `setTags(ctx, [...])`. Spans started by an `OITracer` inside `context.with(ctx, ...)` inherit them [V]: every span in
  the probe trace carried `session.id`, `user.id`, `metadata.*` and `tag.tags`.

## 5. Modeling Weft's loop

### 5.1 Where the loop is today [C]

`packages/agent/src/loop.ts` `runLoop` cycles admission, assemble, model, dispatch, post and writes one `run_steps` row
per stage (`stage` in `admission | assemble | model | dispatch | post | terminal`, `kind` in
`context | model_call | tool_call | notice | recite | verify | error`, `packages/contracts/src/trace.ts`). Model rows
carry `usage` (`input`, `cached`, `cacheWrite`, `output`, `reasoning`), `costUsdMicros`, `requestId`, `prefixHash`
and timings. Tool rows carry `toolName`, `toolArgs`, `callId` and the executor's `ToolOutcome`
(`{ ok: true, status: "done", summary, resultId, actionSeq }`, `{ ok: true, proposalId, title }` or
`{ ok: false, refusal: { code, message, hint } }`). Grounding runs through `@weft/grounding` `check`. The run record has
`threadId` (chat) and `routineRunId`. `packages/agent/src/trace.ts` already summarizes tokens, cache hit ratio and
USD for the run view. The OpenTelemetry trace should be a second projection of the same facts, emitted where the rows
are appended, not a parallel bookkeeping path [R].

### 5.2 Span tree [R]

```
agent.run                        AGENT      agent.name=weft-agent, input=task or chat turn, output=terminal summary
├── admission (attempt n)        CHAIN      reserveMicros, cap, outcome (ok | refused:BUDGET_EXCEEDED)
├── assemble                     CHAIN      items, estInputTokens, prefixHash, recipe name
│   └── memory.recall            RETRIEVER  query, retrieval.documents (path as id, snippet, score, tainted flag)
├── model (attempt n)            CHAIN      attempt, outcome
│   └── openai.responses         LLM        messages, tools, invocation params, tokens incl. cached and reasoning, cost
├── dispatch                     CHAIN      batch size, batchDispatchMs
│   ├── payroll__approve         TOOL       tool.name, tool.id=callId, tool.parameters, output=outcome JSON, weft.outcome
│   └── memory__search           TOOL       (and a child RETRIEVER span with the hits)
├── post                         CHAIN      recite plan, notices
│   ├── grounding.check          GUARDRAIL  claim text in, matched and unmatched spans out, weft.guardrail=grounding
│   └── taint.check              GUARDRAIL  tainted, taintedBy, weft.guardrail=taint
└── terminal                     CHAIN      status, reason (TerminalReason), wall ms
```

One trace per run. Child runs (task agents, harness 4.7) start their own `AGENT` span as a child of the parent's
dispatch `TOOL` span, so the tree nests the way `RunTrace.children` does. The loop repeats; repeated stages are
siblings under `agent.run` with `weft.attempt` and `weft.step_n` (the `run_steps.n`) attributes so a span joins back to
its row.

Attributes on every span (via context, set once at run start):

| Attribute | Value | Source |
|---|---|---|
| `session.id` | `run.threadId` for chat; for routines, `routine_run:<routineRunId>` so Phoenix's Sessions view groups a routine's runs | [C] `AgentRunRow` |
| `user.id` | the acting principal id (the person for chat and attended runs; `routine:<id>` for unattended) | [R] |
| `metadata` | `{ run_id, company_id, kind, trigger, attended, provider, model, routine_id, routine_run_id, golden_path, eval_task_id, eval_variant, chat_can_propose, prompt_version }` | [R] |
| `tag.tags` | e.g. `["chat"]`, `["routine","rt_agency_notice"]`, `["eval","L4"]`, `["variant:chat_can_propose"]` | [R] |

`metadata.eval_variant` and the `variant:chat_can_propose` tag are how the explicitly labeled chat_can_propose eval
variant stays separable in every query and chart; the flag itself stays off by default [R].

Weft-specific attributes use a `weft.` prefix (`weft.run_id`, `weft.step_n`, `weft.attempt`, `weft.outcome`,
`weft.refusal_code`, `weft.prefix_hash`, `weft.request_id`, `weft.guardrail`, `weft.terminal_reason`). Phoenix's span
API filters on any dot path (`attribute=weft.outcome:"proposal"`) [V].

### 5.3 LLM spans: build them, do not auto-instrument [R]

`@arizeai/openinference-instrumentation-openai@4.4.1` does patch `OpenAI.Responses.prototype.create` and maps
`cached_tokens` and `reasoning_tokens` [S, `instrumentation.js:366`, `responsesAttributes.js`]. Reasons not to use it:

1. It records the raw SDK request body, which is assembled before Weft's redaction of the outgoing snapshot; the
   source-redaction rule would then depend on the generic `OPENINFERENCE_HIDE_*` switches only.
2. For the Responses API it does not serialize tool definitions (`responsesAttributes.js:33`
   `TODO(2410): figure out how to serialize the list of tools`) [S]. Tool choice is the main thing to debug.
3. Under ESM it needs `instrumentation.manuallyInstrument(OpenAI)` [D]; its ESM build imports `APIPromise` from
   `openai` at top level while declaring `openai` as neither a dependency nor a peer [S], which is fragile under pnpm's
   isolated layout.
4. It pulls `@opentelemetry/instrumentation@0.46.0` alongside phoenix-otel's 0.220.0 [V, pnpm tree].
5. Weft already has everything an LLM span needs: the request snapshot (`providers/openai.ts`), `mapUsage`, `servedBy`,
   `requestId`, and `cost.ts`. It also covers the scripted, Claude and chat-completions providers the same way.

Mapping from Weft's `RawUsage` [C `providers/openai.ts:91-101`] to OpenInference:

| Weft | OpenInference | Note |
|---|---|---|
| `usage.input` (Responses `input_tokens`, includes cached) | `llm.token_count.prompt` | |
| `usage.cached` | `llm.token_count.prompt_details.cache_read` | |
| `usage.cacheWrite` | `llm.token_count.prompt_details.cache_write` | |
| `usage.output` | `llm.token_count.completion` | |
| `usage.reasoning` | `llm.token_count.completion_details.reasoning` | set manually |
| `input + output` | `llm.token_count.total` | |
| `costUsdMicros / 1e6` | `llm.cost.total` | Weft's ledger is the source of truth |
| `cost.ts` split | `llm.cost.prompt`, `llm.cost.prompt_details.cache_read`, `llm.cost.completion` | |
| `servedBy` | `llm.response.model_name` | |
| request `model` | `llm.model_name`, `llm.request.model_name` | |
| `reasoning.effort`, `store`, `max_output_tokens`, `prompt_cache_key` present (boolean), `tool_choice`, `parallel_tool_calls` | `llm.invocation_parameters` | never the key, never headers |
| `requestId`, `prefixHash` | `weft.request_id`, `weft.prefix_hash` | |

Phoenix also computes its own cost per span from `llm.model_name`, `llm.provider` and the `llm.token_count.*`
attributes, using a bundled price manifest [S, `phoenix/server/cost_tracking/span_cost_calculator.py`]. The 20.23.0
manifest has `gpt-5.6-luna` at $0.20 input, $0.02 cache read and $1.20 output per million (rising above 272k prompt
tokens) [S, `model_cost_manifest.json`], which matches harness section 0. So Phoenix's cost columns double as a check
on Weft's `cost.ts`. It does not read `llm.cost.*` for those columns [S], so send both [R].

Input messages: emit the redacted, assembled context items in order (system prompt, recited checklist, history, tool
results as `role: "tool"` with `tool_call_id`). Output messages: assistant text plus `tool_calls` with arguments.
Reasoning items: record `message_content.type = "reasoning"` with the summary text only; drop `encrypted_content` [R].

### 5.4 TOOL spans and the executor outcome [R]

```ts
span.setAttributes({
  ...getToolAttributes({ name: call.name, description: toolDesc, parameters: redact(args) }),
  [SC.TOOL_ID]: call.callId,
  ...getInputAttributes(JSON.stringify(redact(args))),
});
// after executor.run(...)
span.setAttributes({
  ...getOutputAttributes(JSON.stringify(redact(outcome))),
  "weft.outcome": outcomeCode(outcome),          // "ok" | "proposal" | "refused:PERMISSION" | "error" (loop.ts already computes this)
  ...(outcome.ok ? {} : { "weft.refusal_code": outcome.refusal.code }),
});
span.setStatus({ code: outcome.ok ? SpanStatusCode.OK : (isRefusal ? SpanStatusCode.UNSET : SpanStatusCode.ERROR) });
```

Status rule [R]: a refusal is the harness doing its job, so keep status `UNSET` or `OK` and use `weft.outcome` for
analysis; reserve `ERROR` for exceptions, provider failures and `INTERNAL`. Otherwise Phoenix's error-rate view counts
every correct refusal as a failure.

### 5.5 Context propagation and the tracer

```ts
// packages/agent/src/otel.ts  (brain: API and conventions only)
import { context, trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { OITracer, setSession, setUser, setMetadata, setTags } from "@arizeai/openinference-core";
import { SemanticConventions as SC, OpenInferenceSpanKind as K } from "@arizeai/openinference-semantic-conventions";

export type Redact = <T>(v: T) => T;                 // injected; apps/api/src/compose.ts passes redactor.value.bind(redactor)
let redact: Redact = (v) => v;
export function setTraceRedactor(r: Redact) { redact = r; }

// Resolve the tracer per call, never at module load: runExperiment swaps the global provider (5.6).
const tracer = () => new OITracer({ tracer: trace.getTracer("weft-agent"), traceConfig: { hideInputImages: true } });

export function withRunContext<T>(run: { threadId: string | null; routineRunId: string | null; principal: string; meta: Record<string, unknown>; tags: string[] }, fn: () => T): T {
  let ctx = context.active();
  const session = run.threadId ?? (run.routineRunId ? `routine_run:${run.routineRunId}` : null);
  if (session) ctx = setSession(ctx, { sessionId: session });
  ctx = setTags(setMetadata(setUser(ctx, { userId: run.principal }), redact(run.meta)), run.tags);
  return context.with(ctx, fn);
}

export async function span<T>(name: string, kind: K, attrs: Attributes, fn: (s: import("@opentelemetry/api").Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: { [SC.OPENINFERENCE_SPAN_KIND]: kind, ...redact(attrs) } }, async (s) => {
    try { return await fn(s); }
    catch (e) { s.recordException({ name: (e as Error).name, message: redact(String((e as Error).message)) }); s.setStatus({ code: SpanStatusCode.ERROR }); throw e; }
    finally { s.end(); }
  });
}
```

With no provider registered, `trace.getTracer` returns a no-op tracer, so tests and `WEFT_LLM` unset runs pay nothing
and send nothing [R; OTel API behavior]. `recordException` with a raw `Error` would put `exception.message` and
`exception.stacktrace` on a span event; pass a redacted message and no stack instead, because `OISpan.addEvent` and
`OISpan.recordException` pass straight through without masking [S `trace-config/OISpan.js:25-44`].

### 5.6 Registering the provider (composition root) [V]

```ts
// apps/api/src/telemetry.ts, imported first by the API entry when WEFT_TRACE=phoenix
import { register, OTLPTraceExporter, LazyOpenInferenceSpanProcessor } from "@arizeai/phoenix-otel";
import type { Span, SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";

class RedactingSpanProcessor implements SpanProcessor {           // second line of defense
  constructor(private redact: (s: string) => string) {}
  onStart() {}
  onEnding(span: Span) {                                          // span is still writable here (sdk-trace 2.12 Span.end)
    for (const [k, v] of Object.entries(span.attributes)) if (typeof v === "string") { const r = this.redact(v); if (r !== v) span.setAttribute(k, r); }
    for (const ev of span.events) for (const [k, v] of Object.entries(ev.attributes ?? {})) if (typeof v === "string") (ev.attributes as Record<string, unknown>)[k] = this.redact(v);
  }
  onEnd(_: ReadableSpan) {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}

export function startTracing(redact: (s: string) => string, url = process.env.WEFT_PHOENIX_URL!) {
  return register({
    projectName: "weft",                                          // or weft-evals for eval runs
    spanProcessors: [                                              // passing this replaces register's default processor
      new RedactingSpanProcessor(redact),                          // must come first: onEnding runs in array order
      new LazyOpenInferenceSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${url}/v1/traces` }), batch: true }),
    ],
  });
}
// on shutdown: await provider.shutdown()  (flushes the batch)
```

Facts behind this [S unless marked]:

- `register()` accepts `projectName` (else `PHOENIX_PROJECT`, then `PHOENIX_PROJECT_NAME`, else `default`), `url`
  (else `PHOENIX_COLLECTOR_ENDPOINT`; `/v1/traces` is appended if missing), `apiKey`, `headers`, `batch` (default true),
  `instrumentations`, `spanProcessors` (overrides the default processor), `global` (default true) and `diagLogLevel`.
  It installs an `AsyncLocalStorageContextManager` and W3C trace context plus baggage propagators.
- The exporter is OTLP over HTTP with protobuf (`exporter-trace-otlp-proto`).
- `SpanProcessor.onEnding(span)` exists in `@opentelemetry/sdk-trace@2.12.0` and `Span.end()` calls it before setting
  `_ended`, so attribute writes there still apply.
- [V] With `batch: false` the server log showed one `POST /v1/traces` per span; use `batch: true` in the API and call
  `provider.shutdown()` on exit.

Do not put the provider in `packages/agent`: the brain should not own exporters, URLs or process lifecycle, and
`apps/api/src/compose.ts` is already exempt from the import scan and holds the `Redactor` [C `tests/boundaries.test.ts`].

## 6. Keeping secrets out of spans

The brief: the vault, keys and credential values must never reach a span; redact at the source and test it.

Layers [R]:

1. **Source**: every attribute value Weft builds passes through the injected `redact` (Weft's `Redactor.value` deep
   redaction: vault values, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `WEFT_VAULT_KEY`, API key plaintexts and the proxy
   secret in 5 encodings, plus SSN, EIN, routing and account patterns) [C `packages/executor/src/vault/redact.ts`]. The
   tool outputs the model sees are already redacted by the executor (harness 6.4) [C]; tracing must take the same
   redacted copies, never the pre-redaction values.
2. **Never captured at all**: HTTP headers, the OpenAI client config, `WEFT_SECRETS_FILE` contents, the vault
   plaintext, `encrypted_content` reasoning blobs, `prompt_cache_key` value (record only that it was set), raw
   exceptions (stack traces can carry config).
3. **Processor**: `RedactingSpanProcessor.onEnding` in the API's provider re-runs the redactor over every string
   attribute and event attribute.
4. **OpenInference masking**: `OITracer({ traceConfig })` and `OPENINFERENCE_HIDE_*` env vars can blank whole classes
   (`hideInputs`, `hideOutputs`, `hideInputMessages`, `hideOutputMessages`, `hideInputText`, `hideOutputText`,
   `hideLLMTools`, `hideInputImages`, `hideEmbeddingVectors`, `hidePrompts`, `base64ImageMaxLength`), replacing values
   with `__REDACTED__` [S `openinference-core` `trace-config/types.d.ts`, D `spec/configuration.md`]. Gotcha: the JS
   `TraceConfigOptions` has **no** `hideLLMInvocationParameters` (the spec and Python have it) [S]. These are blunt;
   Weft wants full synthetic content for debugging, so keep them off and rely on 1 to 3.

Why layer 1 is mandatory: `runExperiment` registers its **own** provider with `register({ ..., global: false })` and the
default span processor, then attaches it as the global provider for the task's duration
(`setGlobalTracerProvider` defaults to true) [S `phoenix-client` `experiments/runExperiment.js:80-97`]. Weft spans
emitted during an experiment go through that provider, which has no `RedactingSpanProcessor`.

Tests [R]:

- `packages/agent` unit test with `InMemorySpanExporter` + `SimpleSpanProcessor` on a local `NodeTracerProvider`
  (or `BasicTracerProvider`): register a fake secret with a `Redactor`, run the scripted provider through a run whose
  tool result, model text, tool args, error message and memory hit each contain the secret in raw, base64 and hex form,
  then assert `JSON.stringify(exporter.getFinishedSpans().map(s => [s.attributes, s.events]))` contains none of the
  encodings and does contain `[redacted]`.
- A second test runs the same with **no** processor-level redaction, to prove the source layer alone suffices.
- A grep test that `packages/agent/src/otel.ts` never reads `process.env` keys matching `KEY|SECRET|TOKEN`.

My probe did the end-to-end version against Phoenix with Weft's real `Redactor`: a 41-character fake key placed in
an LLM input message came back as `debug key [redacted]`, and the fake key appeared nowhere in the JSON of all 11
spans fetched over REST [V].

## 7. Datasets, experiments and annotations from TypeScript

All of this ran against the local Phoenix with no model calls [V]:

```ts
import { createClient } from "@arizeai/phoenix-client";
import { createDataset } from "@arizeai/phoenix-client/datasets";
import { runExperiment, asEvaluator } from "@arizeai/phoenix-client/experiments";
import { addSpanAnnotation, getSpans } from "@arizeai/phoenix-client/spans";

const client = createClient({ options: { baseUrl: "http://127.0.0.1:<phoenix-port>" } });

// 1. Dataset of eval tasks: input is what the agent gets, output is the expectation, metadata joins back to Weft.
const { datasetId } = await createDataset({ client, name: "weft-agent-tasks-v1", description: "L and GP tasks", examples: [
  { input: { task: "Approve the October payroll" }, output: { expect: "proposal", tool: "payroll__approve" },
    metadata: { eval_task_id: "L4", golden_path: "GP3" } },
] });

// 2. Experiment: the task runs Weft's loop; spans inside it land in the experiment's project and link to the run.
const exp = await runExperiment({
  client, dataset: { datasetId }, experimentName: "luna-baseline",
  experimentMetadata: { provider: "openai", model: "gpt-5.6-luna", chat_can_propose: false, harness_sha: "<sha>" },
  concurrency: 1,                                  // live spend: one at a time, guard checked per task
  task: async (example) => runWeftTask(example),  // returns { outcome, tool, summary, run_id, usd }
  evaluators: [asEvaluator({ name: "outcome_match", kind: "CODE", evaluate: async ({ output, expected }) => {
    const ok = (output as { outcome: string }).outcome === (expected as { expect: string }).expect;
    return { score: ok ? 1 : 0, label: ok ? "match" : "mismatch", explanation: ok ? undefined : JSON.stringify(output) };
  } })],
});

// 3. Annotate a production or eval span (a judge result, or Nitish's own verdict).
await addSpanAnnotation({ client, sync: true, spanAnnotation: {
  spanId, name: "task_success", annotatorKind: "CODE", label: "pass", score: 1, explanation: "proposal created" } });
```

Types [S]: an `Example` is `{ input: Record<string, unknown>; output?; metadata?; splits?; spanId?; id? }`. The task is
`(example) => TaskOutput`. An evaluator gets `{ input, output, expected, metadata, traceId }` and returns
`{ score?, label?, explanation?, metadata? }`. `AnnotatorKind` is `"LLM" | "CODE" | "HUMAN"`. `runExperiment` defaults:
`concurrency: 5`, `record: true`, `repetitions: 1`, `useBatchSpanProcessor: true`, `setGlobalTracerProvider: true`;
`dryRun: n` runs n examples without recording. `resumeExperiment` and `resumeEvaluation` exist for interrupted runs.

What I saw [V]: the experiment printed task and evaluation summaries and UI links
(`/datasets/<id>/compare?experimentId=<id>`), Phoenix created an `evaluators` project for evaluator spans, and the
dataset and experiment survived a server restart.

Recommended eval shape for wave 4 [R]:

- One dataset per suite (`weft-live-L`, `weft-golden-GP`, `weft-chat`), examples carrying `eval_task_id` and
  `golden_path` in metadata.
- Code evaluators first, because they are free and exact: terminal reason, outcome kind, tool chosen and args (exact
  match against the expectation), cents rule (every money figure in the answer appears in a tool result), grounding
  pass, refusal code expected, steps used versus budget, USD versus cap, cache hit ratio.
- Experiment metadata records `harness_sha`, `prompt_version`, model and the `chat_can_propose` variant flag; compare
  experiments in Phoenix's compare view to see what a harness change did.
- The task function wraps the whole run in `withRunContext` with `eval_task_id` and `eval_variant` so production-style
  traces and experiment rows join on `metadata.eval_task_id`.

## 8. Querying spans for analysis (REST)

Endpoints from the 20.23.0 OpenAPI document at `/openapi.json` [V]; the ones I called are marked.

| Endpoint | Use |
|---|---|
| `GET /v1/projects` [V] | list projects |
| `GET /v1/projects/{name or id}/spans` [V] | spans with filters: `trace_id` (repeatable), `span_id`, `parent_id` (`null` for roots), `name`, `span_kind`, `status_code`, `attribute=key:value` (dot path, JSON-parsed value), `start_time`, `end_time`, `sort` (`id` or `start_time`), `order`, `limit`, `cursor` |
| `GET /v1/projects/{p}/spans/otlpv1` | the same search returned as OTLP JSON |
| `GET /v1/projects/{p}/traces` [V] | traces, `include_spans`, `session_identifier`, and `filter` with the filter-expression DSL (`latency_ms >= 5000`, `error_count > 0`) |
| `GET /v1/projects/{p}/sessions` [V] | sessions (chat threads), with `filter` |
| `GET /v1/sessions/{id}` | one session |
| `POST /v1/span_annotations` [V], `POST /v1/trace_annotations`, `POST /v1/session_annotations`, `POST /v1/document_annotations` | write feedback (`?sync=true` to wait) |
| `GET /v1/projects/{p}/span_annotations?span_ids=...` [V] | read feedback |
| `POST /v1/span_notes`, `/v1/trace_notes`, `/v1/session_notes` | free-text notes |
| `GET /v1/experiments/{id}/runs`, `/json`, `/csv` | experiment results for offline analysis |
| `GET /v1/datasets/{id}/examples`, `/jsonl` | dataset export |
| `POST /v1/projects/{p}/spans` | create spans over REST (no OTel needed) |
| `DELETE /v1/projects/{p}/traces`, `DELETE /v1/traces/{id}` | prune |
| `PATCH /v1/projects/{p}/retention` | retention policy |

Examples that worked [V]:

```bash
curl -s "$PHX/v1/projects/weft/spans?span_kind=TOOL&attribute=session.id:%22thread_probe_1%22&limit=100"
curl -s "$PHX/v1/projects/weft/spans?span_kind=LLM&limit=1"     # attributes come back flattened, see section 11
```

Typed: `getSpans({ client, project: { projectName }, traceIds, spanKind, attributes, limit, cursor })` from
`@arizeai/phoenix-client/spans` [V].

Analysis queries the eval track will want [R]: refusals by code (`span_kind=TOOL&attribute=weft.outcome:...`), LLM
spans with `llm.token_count.prompt_details.cache_read` low against `prompt` (prefix churn; join `weft.prefix_hash`),
`GUARDRAIL` spans with `grounded:false`, runs whose terminal reason is `REPEATED_ERRORS` or `MODEL_INCOMPLETE`, and
tool choice confusion (same `eval_task_id`, different `tool.name` across experiments).

Gotcha [V]: ingestion is asynchronous. Right after `forceFlush()` resolved and the server had answered every OTLP POST
with 200, `GET /v1/projects/weft-probe/spans` returned **404** because the project row did not exist yet. Poll with a
short retry (I used up to 20 tries at 250 ms; the first retry succeeded).

## 9. LLM-as-judge

Options:

1. **`@arizeai/phoenix-evals@2.6.0`** [D, npm README]: `createClassifier({ model, choices, promptTemplate })` and
   prebuilt `createFaithfulnessEvaluator`, `createCompletenessEvaluator`, `createConcisenessEvaluator`,
   `createCorrectnessEvaluator`, `createRetrievalRelevanceEvaluator`, `createRefusalEvaluator`,
   `createToolInvocationEvaluator`, `createToolSelectionEvaluator`, `createToolResponseHandlingEvaluator`,
   `createPiiDetectionEvaluator`, all from `@arizeai/phoenix-evals/llm`. Built on the Vercel AI SDK v7 (ESM only, Node
   `>=22.12`), so it needs `ai@7` and `@ai-sdk/openai@4+` as new dependencies [D]. Its LLM evaluators plug into
   `runExperiment` (`ExperimentEvaluatorLike` accepts `LLMEvaluator`) [S].
2. **A Weft judge as an `asEvaluator({ kind: "LLM" })`** that calls gpt-5.6-luna through Weft's own provider with a
   strict JSON schema output (`{ label, score, explanation }`), recorded in the spend ledger and stopped by the live
   guard [R].

Recommendation [R]: option 2. The wave cap is $3.00 total, and only Weft's ledger enforces it; an AI SDK client would
spend outside the ledger. Borrow the prompt ideas from the prebuilt tool selection, tool invocation, faithfulness and
refusal evaluators, but keep the judge's own prompt in `evals/` and version it. Use the judge only where code cannot
decide (is the explanation faithful to tool results, was the refusal message helpful, did the agent choose a
reasonable tool when several were valid). Cost estimate for planning: a judge call with about 3k input tokens and 150
output tokens costs about $0.0008 at Luna prices (3000 x $0.20/M + 150 x $1.20/M), so 100 judged runs is about $0.08
[R, arithmetic].

Phoenix can also hold model provider credentials itself (the 20.23.0 API has `PUT /v1/secrets`,
`GET /v1/model_providers` and an OpenAI-compatible `POST /v1/chat/completions`) for its playground and UI-driven evals
[V, OpenAPI list]. Do not configure an OpenAI key in Phoenix: it would sit outside Weft's vault and ledger [R].

## 10. Gotchas, collected

1. **gRPC binds all interfaces** regardless of `PHOENIX_HOST` [V, S]. Use an unused assigned port; do not export to it.
2. **Async ingestion**: a fresh project 404s for a moment after spans are accepted [V]. Retry reads.
3. **Short scripts lose spans** with the default batch processor unless you `await provider.shutdown()` or
   `forceFlush()` [D, V].
4. **`spanProcessors` replaces the default processor** in `register()`; include an exporter processor yourself [S].
5. **`runExperiment` swaps the global provider** during tasks [S]. Resolve the tracer per span (`trace.getTracer` at
   call time); never cache a tracer at module scope. Its provider lacks Weft's processors, so source redaction is
   required.
6. **JS masking lacks `hideLLMInvocationParameters`** [S]; never put secrets in invocation params.
7. **`getLLMAttributes` has no reasoning tokens and no cost** [S]; set those constants directly.
8. **Span events are not masked** by `OITracer` [S]; `recordException` with raw errors leaks messages and stacks.
9. **Docs say default SQLite is in a temp folder; code puts it in the working dir** [S, V].
10. **Phoenix downloads a 25 MB WASM sandbox binary** into the working dir on startup unless
    `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false` [V, S].
11. **Telemetry pixels are on by default** (`PHOENIX_TELEMETRY_ENABLED=true`) [D, S].
12. **Node 25 and ESM**: everything ran under Node 25.9.0 with `tsx@4.23.15` and `"type": "module"` with no flags
    [V]. Use the subpath imports (`@arizeai/phoenix-client/spans`, `/datasets`, `/experiments`); the root export has
    `createClient`, auth fetch, errors and version helpers, not the dataset or span functions [S].
13. **OTel version skew**: phoenix-otel 2.2.0 stays on the 0.220.x experimental line while 0.223.0 is current [V];
    let phoenix-otel own the SDK packages.
14. **The OpenAI auto-instrumentation drops Responses tool definitions** [S]; one more reason to build LLM spans.
15. **Phoenix releases daily**: pin `arize-phoenix==20.23.0` and the image digest, and upgrade deliberately [V].
16. **Persistent data dir is shared with nobody**: `~/Developer/projects/weft-notes/phoenix` sits outside the repo; the
    repo `.gitignore` does not need to know about it. Never point `PHOENIX_WORKING_DIR` inside the repo [R].

## 11. Verification log

Run on 2026-10-16 from a scratch folder outside the repo, using ports 6116 (HTTP) and 6117 (gRPC), both checked free
first. No live model calls; spend $0.00.

1. Started `uvx --python 3.13 --from arize-phoenix==20.23.0 phoenix serve` in a new process group with the env in
   2.1 and a scratch working dir. Banner: UI and REST on `http://127.0.0.1:6116`, OTLP HTTP `/v1/traces`, OTLP gRPC
   `:6117`. `GET /arize_phoenix_version` returned `20.23.0`.
2. Installed into a scratch pnpm project: `@arizeai/phoenix-otel@2.2.0 @arizeai/openinference-core@2.8.0
   @arizeai/openinference-semantic-conventions@2.14.0 @arizeai/phoenix-client@7.16.1
   @arizeai/openinference-instrumentation-openai@4.4.1 @opentelemetry/api@1.9.1 tsx@4.23.15` (the last two only to read
   their source and run the script).
3. Ran a TypeScript probe (ESM, tsx) that registered the provider with the redacting processor plus a non-batching
   exporter, imported Weft's real `Redactor` read-only from `packages/executor/src/vault/redact.ts`, and emitted one
   synthetic run: `agent.run` AGENT, `admission`, `assemble`, `model`, `dispatch`, `post` CHAIN, `memory.search`
   RETRIEVER, `openai.responses` LLM, `payroll.approve` TOOL, `grounding.check` and `taint.check` GUARDRAIL, under a
   context with session, user, metadata and tags. A fake key sat in an LLM input message.
4. Queried back through `getSpans` and raw REST. All 11 spans returned with the right kinds and one root. The LLM span
   attributes came back as:

   ```
   llm.cost.completion = 0.0001152          llm.token_count.completion = 96
   llm.cost.prompt = 9.36e-05               llm.token_count.completion_details.reasoning = 64
   llm.cost.total = 0.0002088               llm.token_count.prompt = 2310
   llm.input_messages.1.message.content = Approve October payroll. debug key [redacted]
   llm.invocation_parameters = {"reasoning":{"effort":"low"},"store":false,"max_output_tokens":800}
   llm.model_name = gpt-5.6-luna            llm.token_count.prompt_details.cache_read = 2048
   llm.output_messages.0.message.tool_calls.0.tool_call.function.name = payroll.approve
   llm.provider = openai   llm.system = openai   llm.tools.0.tool.json_schema = {"type":"function",...}
   metadata.eval_task_id = probe-1   metadata.golden_path = GP0   metadata.routine_id = rt_probe
   session.id = thread_probe_1   tag.tags = ["probe","weft"]   user.id = usr_admin_larkspur
   weft.prefix_hash = abc123   weft.request_id = req_probe
   ```

   Note that Phoenix returns the `metadata` JSON string flattened into `metadata.<key>` attributes; the spans API's
   own parameter description uses `metadata.tier` as its filter example [S], so `attribute=metadata.eval_task_id:"L4"`
   should work (not run).
   Fake key present in any span: **false**. Redaction marker present: **true**. Raw REST filter
   `span_kind=TOOL&attribute=session.id:"thread_probe_1"` returned the TOOL span with `weft.outcome = proposal`.
   `GET /v1/projects/weft-probe/sessions` listed `thread_probe_1`.
5. Wrote a span annotation (`task_success`, CODE, pass, 1) on the AGENT span and read it back.
6. Created a two-example dataset and ran an experiment with a CODE evaluator: 2/2 tasks, 2/2 evaluations, labels
   `match,match`.
7. Stopped Phoenix (SIGTERM to the process group), restarted on the same working dir with
   `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`: 22 spans (two probe runs), the dataset and the projects were all still
   there.
8. Stopped Phoenix again, confirmed the process group was gone and ports 6116 and 6117 were closed, and deleted the
   scratch working dir.

Not verified here: the Docker path (daemon not running), the OpenAI auto-instrumentation at runtime, phoenix-evals at
runtime, any live gpt-5.6-luna call, Phoenix's computed cost column for the probe span.

## 12. Sources

- Phoenix repository and license: https://github.com/Arize-ai/phoenix, https://raw.githubusercontent.com/Arize-ai/phoenix/main/LICENSE
- PyPI metadata: https://pypi.org/pypi/arize-phoenix/json
- Docker Hub tags API: https://hub.docker.com/v2/repositories/arizephoenix/phoenix/tags
- Phoenix configuration: https://arize.com/docs/phoenix/self-hosting/configuration
- Phoenix Docker deployment: https://arize.com/docs/phoenix/self-hosting/deployment-options/docker
- Phoenix TypeScript tracing helpers: https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-otel/tracing-helpers
- phoenix-otel 1.0 release note: https://arize.com/docs/phoenix/release-notes/04-2026/04-13-2026-phoenix-otel-ts-1-0
- TypeScript SDK overview: https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview
- Tracing setup: https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/instrument
- OpenInference semantic conventions: https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
- OpenInference configuration (masking): https://github.com/Arize-ai/openinference/blob/main/spec/configuration.md
- npm: https://www.npmjs.com/package/@arizeai/phoenix-otel, https://www.npmjs.com/package/@arizeai/phoenix-client,
  https://www.npmjs.com/package/@arizeai/openinference-core, https://www.npmjs.com/package/@arizeai/openinference-semantic-conventions,
  https://www.npmjs.com/package/@arizeai/openinference-instrumentation-openai, https://www.npmjs.com/package/@arizeai/phoenix-evals
- Phoenix 20.23.0 source read from the uv cache: `phoenix/config.py`, `phoenix/server/grpc_server.py`,
  `phoenix/server/cost_tracking/{span_cost_calculator.py,model_cost_manifest.json}`, and the served `/openapi.json`.
- Package source read from the installed tarballs: `@arizeai/openinference-core@2.8.0` `dist/esm/{helpers,trace}`,
  `@arizeai/phoenix-otel@2.2.0` `dist/esm/register.*`, `@arizeai/phoenix-client@7.16.1` `dist/esm/experiments/runExperiment.*`,
  `@arizeai/openinference-instrumentation-openai@4.4.1` `dist/esm/{instrumentation,responsesAttributes}.js`,
  `@opentelemetry/sdk-trace@2.12.0` `build/esm/{Span,SpanProcessor,MultiSpanProcessor}`.
- Weft: `packages/agent/src/{loop,trace}.ts`, `packages/agent/src/providers/openai.ts`, `packages/contracts/src/trace.ts`,
  `packages/executor/src/vault/redact.ts`, `tests/boundaries.test.ts`, `research/harness.md`.
