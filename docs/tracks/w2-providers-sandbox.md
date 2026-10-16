# Track w2-providers-sandbox notes (wave 2, 2026-10-15)

Branch `track/w2-providers-sandbox`. Owner paths: `packages/agent/src/providers/{chat-completions,claude,factory}.ts`,
`packages/agent/test/providers/**`, `packages/executor/src/sandbox/**`, `createSandbox` in
`packages/executor/src/index.ts`, the `code.run` command in `packages/executor/src/builtins.ts`,
`packages/executor/test/sandbox/**`, the two package manifests, `pnpm-lock.yaml` and `docs/models.md`.

All three slices landed: the local chat-completions provider, the Claude provider with snapshot tests and the factory
wiring (the cut line), and `code.run` on QuickJS.

## What exists

- **Local chat-completions provider** (`packages/agent/src/providers/chat-completions.ts`). `WEFT_LLM=mlx` or
  `llama` builds it from `WEFT_LOCAL_BASE_URL` (required) and `WEFT_LOCAL_MODEL` (optional, defaults
  `mlx-community/Qwen3.6-27B-4bit` and `Qwen3-1.7B-Q4_0`), validated with `LocalProviderConfig`. Plain `fetch` to
  `/v1/chat/completions`, `chat_template_kwargs.enable_thinking: false`, `temperature: 0`, `max_tokens: 768`, tools
  sorted with compact descriptions, a 180 s step timeout, no retries. Arguments are parsed as strict JSON with no
  repair: an invalid one is handed to the loop unparseable, so the loop answers it with an `INVALID_INPUT` tool error
  and the run goes on; the replayed assistant message wraps it as `{"invalid_arguments": ...}` because chat
  templates parse replayed arguments. Empty call ids get deterministic ones. `<think>` text is dropped. Provider id
  `openai_compat`, `live: false` (see contract notes).
- **Claude provider** (`packages/agent/src/providers/claude.ts`), written only from the bundled claude-api docs
  (TypeScript README, tool-use.md, streaming.md, shared/model-migration.md "Migrating to Claude Opus 5.5",
  shared/models.md). `@anthropic-ai/sdk` 0.131.0 (0.135.0 was published today and fails the lockfile's
  minimum-release-age policy), `client.beta.messages.stream(body, { signal })` then `finalMessage()`. The body is typed
  against the SDK's `BetaMessageStreamParams`: `claude-opus-5-5`, `max_tokens` at least 16,000, adaptive thinking
  with summarized display, explicit `output_config.effort` (`none` maps to `low`), `betas:
  ["server-side-fallback-2026-07-01"]` with `fallbacks: "default"`, strict sorted tools, `tool_choice` auto, the
  frozen prompt as a cached system block, assistant content replayed verbatim (thinking blocks and signatures), tool
  outputs as `tool_result` blocks. Refusals carry `stop_details.category`; `max_tokens` runs no tool; usage counts
  cache reads and writes into `input`. `ANTHROPIC_API_KEY` from the environment or `WEFT_SECRETS_FILE`.
- **Factory** (`factory.ts`): claude, mlx and llama build their providers; `LIVE_PROVIDER_IN_TEST` still refuses all
  of them under vitest unless `WEFT_LIVE_OPENAI=1`; `PROVIDER_CONFIG` names the missing variable
  (`ANTHROPIC_API_KEY`, `WEFT_LOCAL_BASE_URL`, or says the URL is invalid). An optional `compactDescriptions` lookup
  is accepted for the local providers.
- **code.run on QuickJS** (`packages/executor/src/sandbox/`):
  - `quickjs.ts`: `createQuickJsEngine()` implements `SandboxEngine` on `quickjs-emscripten` 0.32.0. A fresh WASM
    module, runtime and context per run, disposed in `finally` with every handle. The script is an async function
    body; `weft.call(name, args)` returns a promise that the host serves one call at a time;
    `weft.memory.search(query, opts)` and `weft.memory.read(path)` map to the memory commands; `inputs` and `console`
    are the only other globals added. `DEFAULT_CODE_LIMITS` are enforced: heap and stack on the runtime, guest CPU
    (host time excluded) and wall through the interrupt handler plus a host timer, 25 calls and 256 KiB of inner
    results (over budget is refused as data, then the run ends `CALL_BUDGET`), 64 KiB value, 8 KiB of logs.
  - `host.ts`: `sandboxCall(engine, tx, ctx)` runs each inner call through `runInTx` on the code.run's own run and
    transaction with surface `sandbox` and a scope rebuilt from `exec_runs` (allowlist, tier, grants, references,
    policy, untrusted wrapping with a fresh nonce, taint, redaction). Commands without `sandbox: "read"` are
    `SANDBOX_NOT_ALLOWED` data before the pipeline. No batch state is touched. `memory.search` and `memory.read`
    get `at: <HEAD captured at start>` unless the script names a commit, so one script sees one memory commit.
  - `select.ts`: `WEFT_SANDBOX` (`off` default, `quickjs` or `on`, anything else is not built).
  - `code.run` in `builtins.ts`: R0 read, `mcp: "hidden"`, `sandbox: "hidden"` (cannot nest), tiers executable,
    refused outside an agent run, `UNAVAILABLE` with the reason when the sandbox is off. Input `{ source, purpose,
    inputs_json? }`. `SANDBOX_TIMEOUT`, `SANDBOX_OOM` and `CALL_BUDGET` are refusals; a script error is data
    (`SANDBOX_ERROR`). The result is `{ ok, value, error, logs, calls, memory_at }`; when any inner call was tainted
    it carries `taintedBy: "sandbox:code.run"` and `untrusted: ["value", "logs", "error"]`, so the pipeline wraps it
    with the run nonce and taints the run.
  - `createSandbox(env = process.env)` returns the engine when `WEFT_SANDBOX` is not off and throws
    `NotImplemented` with the reason otherwise.
  - `code.run` is on no allowlist; `CHAT_TOOLS` is still 14.

## How to run it

```sh
pnpm --filter @weft/agent test           # providers: fake server, Claude snapshot and fixtures, factory
pnpm --filter @weft/executor test        # sandbox engine and code.run through the real executor
WEFT_LLM=llama WEFT_LOCAL_BASE_URL=http://127.0.0.1:4381/v1 pnpm dev
WEFT_LLM=claude WEFT_SECRETS_FILE=... WEFT_PRICES_JSON='{"inPerM":4,"cachedPerM":0.2,"outPerM":20}' pnpm dev
WEFT_SANDBOX=quickjs pnpm dev            # code.run registered and runnable; still on no allowlist
```

The Claude request snapshot is `packages/agent/test/providers/__snapshots__/claude-request.json`; if the body changes
on purpose, run the test with `-u` and review the diff. The response fixtures in
`packages/agent/test/providers/fixtures/claude-*.json` are hand-built in the documented response shape (no key on
this machine), and each says so in a `_note` field.

Smoke test: `llama-server --jinja` on port 4381 with `Qwen3-1.7B-Q4_0-rtn.gguf`; one strict tool call, the tool
output round trip and a grounded final answer in 0.64 s, 174 of 241 prompt tokens cached on step 2. The server was
stopped afterwards (process group killed). The 27B model was never started. Live spend: none.

## Tests added

38 tests: `packages/agent/test/providers/chat-completions.test.ts` (9), `claude.test.ts` (6),
`packages/executor/test/sandbox/quickjs.test.ts` (11) and `code-run.test.ts` (9, including a vault value that an inner
read leaks in every encoding and that never reaches the output), the s6 scenario, plus 2 in the existing files below.

## Edits outside the owned list, and why

- `tests/scenarios/s6-code-run.test.ts` (new file; the brief asks for scenario tests on the scripted provider): a
  routine run whose test-only routine row lists `code.run`, triggered through `POST /v1/routines/:id/trigger`; the
  scripted model calls `code__run`, the script reads `people__search` and `payroll__get_run` through `weft.call`, its
  send is refused `SANDBOX_NOT_ALLOWED`, the final text carries the CA headcount from the script, and no action row is
  written.

- `packages/agent/test/providers.test.ts`: the wave 1 test asserted `PROVIDER_CONFIG: not built in P0` for claude, mlx
  and llama, which the acceptance list replaces. It now asserts the message names the missing variable.
- `packages/executor/test/registry.test.ts`: the policy inline snapshot gains the line `"code.run": "R0 execute |
  tainted execute"`.
- `packages/executor/src/outcome.ts` (commit "contract: ..."): the executor's `KNOWN` refusal set lacked
  `SANDBOX_NOT_ALLOWED`, `SANDBOX_TIMEOUT`, `SANDBOX_OOM` and `CALL_BUDGET`, which `RefusalCode` has listed since wave
  1, so a thrown sandbox code became `INTERNAL`. Four names added; nothing else changes meaning.

## Contract notes

- No frozen contract file changed (`provider.ts`, `sandbox.ts`, `wave2.ts`).
- The local providers are `live: false`. In this codebase `live` gates spend (the loop reserves and settles non-live
  providers at zero and the live cap ignores them), and the brief asks for local usage to cost zero; the
  `LIVE_PROVIDER_IN_TEST` guard keys on `WEFT_LLM`, so tests still refuse them. Side effects: the header badge is the
  outline tone, unattended routine runs use the local model rather than the templates, and the model-backed
  routine draft recipe is not offered. The contract comment says "false only for scripted"; the integrator may
  prefer an explicit per-provider price instead (contract request below).
- `ToolSpec` has no compact description, so the local provider takes an optional lookup and falls back to the first
  sentence; wiring the registry's `compactDescription` needs one line in `apps/api/src/compose.ts` (request below).
- The QuickJS engine uses the sync build with promises, not the asyncify build harness 3.2 names: an asyncified host
  function cannot run from a job queued after an `await`, and model-written scripts await. The `SandboxEngine`
  contract is unchanged.

Requests for files this track does not own are in `.scratch/contract-requests/w2-providers-sandbox.md`; what is left
is in `.scratch/w2-providers-sandbox/left.md` (both in the main checkout; the left list is repeated below).

## Left for later

- Scenario S6 as harness 3.6 words it (summing CA SUI wages, checked in cents against `tax.rate_change_impact`):
  `tests/scenarios/s6-code-run.test.ts` covers the same path with a CA headcount and a draft-run read instead.
- A return value over the 8,000 character observation cap is offloaded by the pipeline to a run artifact the model
  pages with `agent.read_artifact` (tested); over 64 KiB it is a `SANDBOX_ERROR` asking for a smaller summary,
  where harness 3.5 wants `runs/<id>/code/<n>.out.json` with an `artifact_ref` at any size.
- Source and output are not written to the run workspace; inner calls are listed in the result, not as nested
  `run_steps` rows (the executor does not write `run_steps`).
- QuickJS runs on the API thread, so a long script can hold the event loop for up to the 2 s CPU deadline; a worker
  thread is the fix.
- Per-provider pricing in the loop (Claude at $4 and $20 per million, local at zero) and the compose wiring of
  compact descriptions (both contract requests).
- A live Claude call once an Anthropic key exists (the snapshot pins the body; one smoke call would confirm it).
