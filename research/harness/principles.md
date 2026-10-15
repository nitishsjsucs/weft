# Harness principles for a cheap model (gpt-5.6-luna)

Researched 2026-10-15, 13:48 to 14:15 PDT, for the Weft harness architect. Read this instead of redoing the reading. Every claim carries a source tag; the tags resolve in section 12.

**How to read the evidence labels**

- **[Observed]**: seen directly by this researcher today (npm registry metadata, a doc page's literal text or code, a local file).
- **[Stated]**: a company's or author's own claim about its product or practice (blog posts, docs). Not independently verified.
- **[Third party]**: a party other than the vendor inferring or reporting something.
- **[Inference]**: this researcher's conclusion for Weft. Not a fact from any source.
- **[Brief]**: stated in the Weft task brief (for example the 2026-10-15 Luna checks). Not re-run here.

**No live API calls were made.** The brief allowed up to 5, but the user's own request for this run did not ask for paid calls, so request shapes below come from the docs only. Section 6.9 lists the 5 smoke calls a builder should make once (well under $0.01 total).

**Added at the user's request:** section 9 covers open-source sandboxes and what Cloudflare offers on the free tier.

---

## 0. The answer in one screen

1. **Workflow first, agent second.** Every golden flow (onboard a hire, preview a payroll, register a state, triage a notice) is a code-owned state machine where the model fills narrow slots: classify, extract, choose, draft. The open-ended loop exists only for chat and is bounded by a step budget. Sources: [BEA] says to start with the simplest solution and that workflows suit "well-defined tasks"; [12F] says good agents are "mostly deterministic code, with LLM steps sprinkled in". [Inference] For a cheap model this is the single biggest lever.
2. **Narrow tool sets per agent kind, masked per phase.** Each agent kind has its own frozen tool list (main agent under 20, task agents 3 to 10). Within a run, restrict callable tools with `tool_choice: {type: "allowed_tools", ...}`; never add or remove tools mid-run. Sources: OpenAI "Aim for fewer than 20 functions" and `allowed_tools` "helps with prompt caching" [OAI-FC], [OAI-CACHE]; Manus "mask, don't remove" [MANUS].
3. **Strict schemas everywhere.** `strict: true`, `additionalProperties: false`, every property required, optional means `["T", "null"]`, enums for every closed set. The model never supplies a number the executor can compute. [OAI-FC], [ATOOLS].
4. **Code owns pre- and post-conditions.** The executor validates, checks grants, limits, leases and approval policy before running (already designed in research/agent.md section 7.2). Add post-conditions: after every write the executor re-reads state and returns a verification digest, and a run cannot finish until a code check over the end state passes. [ACC-BP] "Give Claude a check it can run"; [ALONG] feature list where agents may only flip `passes`.
5. **Plan, then act, then verify.** A task agent's first forced call is a strict `agent__submit_plan`; the plan lives in run state; the model updates step status only through `agent__update_plan` (enum statuses, cannot delete steps); a compact checklist is recited as an appended notice. [ALONG], [MANUS] todo.md, [ACC-BP] explore, plan, implement.
6. **Errors stay in context, compact and actionable; three strikes escalate.** Tool errors return `{ok:false, code, message, hint, example}`; consecutive-error counter resets on success; at 3 the run pauses into the decision inbox. [12F-9], [MANUS], [ATOOLS], [OAI-GUIDE] "failure thresholds".
7. **Cache-friendly, append-only context.** Frozen developer prompt (at least 1,024 tokens for GPT-5.6 caching) plus a byte-identical tool list first; per-run context next; then only appended items. No timestamps or ids in the prefix, deterministic JSON, fixed `reasoning.effort` and `parallel_tool_calls` per agent kind (both are part of the cache prefix). [OAI-CACHE], [MANUS].
8. **Stateless chaining, `store: false`.** Replay every output item (including encrypted reasoning) from Weft's own SQLite step log. `previous_response_id` bills all prior input anyway [OAI-STATE] and ties run state to OpenAI's 30-day store. [Inference] Weft runs must survive restarts and day-long approvals, and the same log drives the scripted and local providers.
9. **Separate verifier context.** Deterministic verifiers first; an LLM reviewer (fresh context, sees only output plus criteria) only for prose like a notice reply. [DYN] "self-preferential bias"; [ACC-BP] writer/reviewer.
10. **Evals that catch harness regressions, not just model regressions.** Prefix-stability test (hash of developer prompt plus tools per agent kind), scripted-provider scenarios, recorded Luna cassettes for the adapter, and a small opt-in live suite scored on database end state with tool-call, error, token, cache-hit and cost metrics. [ATOOLS], [OAI-GUIDE].

---

## 1. What the primary sources say (dense notes)

### 1.1 Anthropic, Building effective agents (Dec 19, 2024) [BEA]

[Stated]
- Workflows are "LLMs and tools orchestrated through predefined code paths"; agents "dynamically direct their own processes and tool usage".
- Five workflow patterns: prompt chaining (with programmatic "gates" between steps), routing (send easy queries to smaller models, hard ones to larger), parallelization (sectioning or voting), orchestrator-workers, evaluator-optimizer (use when evaluation criteria are clear).
- Agents get "ground truth" from the environment at each step, pause for human feedback at checkpoints, and need stopping conditions such as a maximum iteration count. Expect higher cost and compounding errors.
- Start with LLM APIs directly; frameworks obscure prompts and responses.
- Agent-computer interface (Appendix 2): spend as much effort on tools as on prompts; poka-yoke ("Change the arguments so that it is harder to make mistakes"); the SWE-bench agent failed with relative paths and worked once tools required absolute paths; the team spent more time on tools than on the overall prompt; keep formats close to natural text, avoid counting lines or escaping code.

### 1.2 Anthropic, Effective context engineering for AI agents (Sep 29, 2025) [ACE]

[Stated]
- Goal: the "smallest possible set of high-signal tokens". Recall degrades gradually as context grows (context rot, attention budget).
- System prompt at the "right altitude": between brittle hardcoded logic and vague guidance; sections with XML tags or Markdown headers; start minimal, add instructions only where failures appear.
- Tools: minimal set, little overlap. "If a human engineer can't clearly pick the right tool, the agent likely can't either." Token-efficient outputs.
- Examples: a few diverse canonical examples, not a laundry list of edge cases.
- Just-in-time retrieval: hold references (paths, ids, queries) and load at runtime; hybrid with some upfront data is often best.
- Compaction (tune for recall first, then precision); tool result clearing is the lightest-touch compaction; structured note-taking (NOTES.md, to-do list); sub-agents return condensed summaries, often 1,000 to 2,000 tokens.

### 1.3 Anthropic, Effective harnesses for long-running agents (Nov 26, 2025) [ALONG]

[Stated, from a Claude Agent SDK experiment building a web app]
- Failure modes observed: tried to do too much at once and ran out of context mid-feature; later sessions declared the project done early; features marked complete without end-to-end testing.
- Fix: an initializer agent writes `init.sh`, a progress log, an initial git commit and a JSON feature list (more than 200 features, all failing, each with category, description, test steps, `passes`). Coding agents may only change `passes`. "JSON was chosen because the model was less likely to inappropriately alter or overwrite it than a Markdown file."
- One feature per session; commit and update progress notes at the end; begin each session with a basic end-to-end test to catch a broken state.
- Browser-automation testing as a human user surfaced bugs not visible in code.

### 1.4 Anthropic, Writing effective tools for agents (Sep 11, 2025) [ATOOLS]

[Stated]
- Evaluate tools with realistic multi-step tasks, each paired with a verifiable outcome; avoid verifiers so strict they reject correct answers on formatting.
- Metrics: accuracy, runtime per tool call and task, total tool calls, total tokens, tool errors. Many redundant calls suggest pagination or limits need tuning; many invalid-parameter errors suggest unclear descriptions. Use held-out test sets.
- Consolidate: `schedule_event` instead of `list_users` + `list_events` + `create_event`; `search_logs` instead of `read_logs`; `get_customer_context` instead of three getters.
- Namespacing by service and resource (`asana_projects_search`); prefix vs suffix matters per model, test it.
- Return high-signal fields (`name`, `file_type`) not `uuid`, `mime_type`; natural-language names or 0-indexed ids "reduced hallucinations".
- `response_format` enum (`DETAILED` or `CONCISE`): example 206 vs 72 tokens.
- Pagination, filtering, truncation with sensible defaults; Claude Code caps tool responses at 25,000 tokens by default.
- Errors should be actionable: suggest the fix or show a correctly formatted input, not opaque codes or tracebacks.
- Unambiguous parameter names (`user_id`, not `user`); strict data models; describe tools "as you would to a new hire".

### 1.5 Claude Code best practices (code.claude.com/docs/en/best-practices, current) [ACC-BP]

[Stated]
- "Give Claude a check it can run." Without one, "looks done" is the only signal. Gate strength ladder: in-prompt, `/goal` evaluator re-checked every turn, a Stop hook that blocks the turn until a script passes, or a verification subagent.
- "Have Claude show evidence rather than asserting success."
- Explore, plan, implement, commit; skip planning when the diff fits in one sentence.
- Hooks are "deterministic and guarantee the action happens", unlike advisory instructions.
- After two failed corrections, the context is polluted: clear and restart with a better prompt.
- Writer/Reviewer: a fresh context reviews without bias toward code it wrote. Reviewers prompted to find gaps will find some even in sound work; tell them to flag only correctness or requirement gaps.

### 1.6 Claude blog, A harness for every task: dynamic workflows in Claude Code (Jun 2, 2026; Thariq Shihipar, Sid Bidasaria) [DYN]

URL redirected from claude.com to claude.dev (308) [Observed].

[Stated]
- Single contexts degrade on long, parallel, structured or adversarial tasks. Named failure modes: agentic laziness (35 of 50 items addressed), self-preferential bias (favoring its own findings when verifying), goal drift through lossy compaction.
- Workflows are scripts with `agent(prompt, {schema, model, isolation})`, `parallel()`, `pipeline()`; schemas return validated JSON.
- Six patterns: classify-and-act, fan-out-and-synthesize (barrier merge of structured outputs), adversarial verification against a rubric, generate-and-filter, tournament ("comparative judgment is more reliable than absolute scoring"), loop until done.
- Quarantine pattern for untrusted content: unprivileged reader agents summarize; a separately privileged actor acts only on those summaries.
- Model routing by a classifier.
- Cost caveat: "parallelism and specialization have to earn their coordination cost".

### 1.7 OpenAI, A practical guide to building agents (PDF) [OAI-GUIDE]

[Stated; text extracted locally with pdftotext from the PDF at the cited URL]
- Model choice: "build your agent prototype with the most capable model for every task to establish a performance baseline. From there, try swapping in smaller models". Step 1 is "Set up evals to establish a performance baseline".
- Instructions: use existing documents (SOPs, policies); break dense resources into smaller steps; make every step a specific action or output, even the wording of user-facing messages; capture edge cases with conditional branches.
- A run is a loop until an exit condition: a tool call, a structured output, an error, or a maximum number of turns.
- Orchestration: single agent first; manager (agents as tools) or decentralized handoffs only when needed.
- Guardrails are layered (LLM-based, rules-based like regex, moderation). Tool safeguards: rate each tool "low, medium, or high" by read-only vs write, reversibility, permissions, financial impact, and use the rating to pause or escalate.
- Human intervention triggers: "Exceeding failure thresholds" (limits on retries or actions) and "High-risk actions" (example: making payments).

### 1.8 Manus, Context engineering for AI agents (Jul 18, 2025; Yichao "Peak" Ji) [MANUS]

[Stated]
- KV-cache hit rate is "the single most important metric for a production-stage AI agent". Average input to output ratio about 100:1. Example: Claude Sonnet cached input $0.30/MTok vs $3 uncached.
- Stable prefix: a second-precision timestamp at the top kills the cache; "Even a single-token difference can invalidate the cache from that token onward." Append-only context; deterministic JSON key order.
- Mask, don't remove: changing tools mid-task invalidates the cache and confuses the model when history references removed tools. Manus masks logits with a state machine; prefill modes Auto, Required, Specified; consistent prefixes (`browser_`, `shell_`) let it restrict to a group.
- File system as context with restorable compression (drop a page body, keep its URL).
- Recitation: about 50 tool calls per task; it rewrites `todo.md` to push the plan into recent attention.
- Keep errors in context: "Erasing failure removes evidence."
- Avoid few-shot ruts: reviewing 20 resumes drifted into repetition; add structured variation in templates and order.

### 1.9 12-factor agents (HumanLayer) [12F]

[Stated by a third-party practitioner, not a model vendor]
- Factors: natural language to tool calls; own your prompts; own your context window; tools are just structured outputs; unify execution state and business state; launch/pause/resume with simple APIs; contact humans with tool calls; own your control flow; compact errors into the context window; small, focused agents; trigger from anywhere; make your agent a stateless reducer; (13) pre-fetch context you will need.
- Teams often reach 70 to 80 percent quality and find "80% isn't good enough for most customer-facing features".
- Factor 8 [12F-8]: a `switch` on `next_step.intent`; sync intents (fetch) append the result and continue; async intents (clarification, approval) append, persist the thread, and break: "we'll get a webhook later". Owning the loop enables summarization, LLM-as-judge, compaction, logging, rate limiting, durable sleep.
- Factor 9 [12F-9]: append `{type: "error", data: format_error(e)}`; `consecutive_errors` increments per failure and resets after success; at 3 the loop breaks and escalates to a human or resets parts of the context. Raw repeated errors can make the agent "spin out".

### 1.10 MemGPT and Letta [MEMGPT], [LETTA]

[Stated]
- MemGPT (Packer et al., arXiv 2310.08560, Oct 2023): virtual context management like an OS memory hierarchy; main context vs external storage; the model pages data in and out with function calls.
- Letta memory blocks: `label`, `description` (the main signal for how the agent reads and writes it), `value`, `limit` in characters (examples 4,000 to 6,000), `read_only`. Compiled into the prompt inside `<memory_blocks>` with per-block metadata `chars_current` and `chars_limit`. Shared blocks are last-write-wins; read-only or controlled updates recommended.
- Not verified this pass: the exact Letta memory tool names (the base-tools page fetched today listed only web_search, fetch_webpage, run_code).

### 1.11 Code execution instead of tool calls [ACODE], [CF-CODEMODE]

[Stated]
- Anthropic (Nov 4, 2025): present MCP servers as code APIs on a filesystem; example token use 150,000 to about 2,000 (98.7 percent); PII can be tokenized before the model sees it; caveat: needs "a secure sandbox with resource limits and monitoring".
- Cloudflare Code Mode (Sep 26, 2025; Kenton Varda, Sunil Pai): convert MCP tools to a TypeScript API, give the model one code tool, run it in a fresh V8 isolate via the Worker Loader API with `globalOutbound: null`; bindings hold the keys so generated code cannot leak them. The post gives no measured benchmark numbers.

[Inference] Not for Weft's foundation: every Weft write must go through the executor's per-call grant, limit, approval and logging path, and Luna's code-writing quality on a Weft API is unmeasured. Revisit for read-only analytics later (section 9).

---

## 2. Why a cheap model needs a stronger harness [Inference, built on the sources above]

Small models fail in predictable ways; each has a harness counter that does not depend on model quality:

| Failure | Harness counter | Grounding |
|---|---|---|
| Picks a wrong or overlapping tool | 3 to 10 tools per task kind, no overlap, `allowed_tools` per phase | [ACE], [OAI-FC], [MANUS] |
| Malformed or invented arguments | `strict: true`, enums, ids from prior results only, executor Zod check, at most 2 repairs | [OAI-FC], [ATOOLS], research/agent.md 6.4 |
| Arithmetic and money errors | Model never computes amounts; executor returns totals with a `result_id` the model quotes | research/agent.md section 15 |
| Stops early or declares done | Plan state in code; `done` blocked until post-conditions pass | [ALONG], [ACC-BP], [DYN] |
| Goal drift over many steps | Recited checklist notice; one item per task agent; step budget | [MANUS], [DYN] |
| Loops on the same error | Actionable error with hint and example; 3 consecutive errors pause the run | [12F-9], [ATOOLS] |
| Follows instructions in untrusted text | Quarantine: reader task agent with no write tools emits a strict summary; actor acts on the summary | [DYN] |
| Grades its own work generously | Deterministic checks; separate reviewer context for prose | [DYN], [ACC-BP] |
| Repetition across a batch | One task agent per item (fan-out), not one long loop | [MANUS], [DYN] |
| Cost creep from long contexts | Compact observations, cache-stable prefix, tool result clearing, sub-agent summaries | [MANUS], [ACE], [OAI-CACHE] |

---

## 3. Harness architecture rules for Weft

### 3.1 Control flow (own the loop)

- One run is a persisted state machine: `queued → planning → acting → verifying → done | waiting_approval | waiting_input | failed | escalated`. The model chooses the next tool call; code chooses the next state. [12F-8], [Inference]
- Exit conditions per [OAI-GUIDE]: final message with no tool calls, a forced report tool, an error threshold, or a step budget (main agent 24 steps, task agent 12, defaults to tune with evals [Inference]).
- Approvals never block a process: a gated command returns `pending_approval` as its tool result; the run persists and stops; a human decision appends a notice and re-queues the run (matches research/agent.md decision 4 and [12F-8]).
- Stateless reducer: `nextRequest = render(runState, steps)`; every model call can be rebuilt from SQLite alone. [12F] factor 12, [Inference]

### 3.2 Per-task tool sets

- Each agent kind (main, `task:it_setup`, `task:state_registration`, `task:notice_reader`, `task:payroll_review`, ...) has a frozen, name-sorted tool list. The list is part of the cache prefix, so it never changes inside a run. [OAI-CACHE] "Preserve tool definitions, ordering, and schemas."
- Phase masking with `tool_choice: {type: "allowed_tools", mode: "auto" | "required", tools: [{type: "function", name}]}`; e.g. planning phase allows only `agent__submit_plan`, verify phase allows only reads plus `agent__report`. [OAI-FC], [MANUS]
- Force a specific call with `tool_choice: {type: "function", name: "agent__submit_plan"}`. [OAI-FC]
- Keep wire names `namespace__action` (research/agent.md decision 3) so groups share a prefix, as Manus does. [MANUS] Note: OpenAI's name length and character rules were not re-verified this pass; check the API reference before freezing names [Inference].
- Do not use OpenAI tool search, namespaces or `defer_loading` in the foundation: they exist [OAI-FC] but add moving parts; under 20 tools per kind makes them unnecessary [Inference].

### 3.3 Strict schemas and pre/post-conditions

- Function tools: `{type: "function", name, description, parameters, strict: true}`. Strict requires `additionalProperties: false` on every object and every property in `required`; optional fields use a `"null"` type union; a non-conforming strict schema is rejected (400). If `strict` is omitted in Responses, the API tries to normalize and may silently fall back to non-strict. Always set it explicitly. [OAI-FC]
- Do not make the model fill arguments code already knows ("Don't make the model fill arguments your code already knows") [OAI-FC]: `company_id`, `acting_for`, the run id and the clock come from run state, never from tool args. [Inference] This also closes a cross-tenant hole.
- Pre-conditions (executor, before running): research/agent.md section 7.2 steps 1 to 7 already cover them. Add: referenced ids must appear in an earlier tool result in this run, or the call returns `UNKNOWN_REFERENCE` with the closest matches (guards hallucinated ids) [Inference, from [ATOOLS] on id hallucination].
- Post-conditions (executor, after running): re-read the written rows and return `verify: {checked: [...], ok: true}`; failures return an error and roll back inside the transaction. [Inference]
- Run-level completion check: each task kind declares `isDone(state)` in code (e.g. hire has a Weft account, I-9 task exists, IT accounts provisioned in the simulator). `agent__report(status: "done")` is refused with `NOT_DONE` and the failing checks until it passes. [ALONG] "passes" field, [ACC-BP] Stop hook gate.

### 3.4 Plan, recite, verify

- Plan: forced strict `agent__submit_plan({steps: [{id, action, tool, expect}], assumptions, needs_input})`. Store it in `run_plans`. The model can only call `agent__update_plan({step_id, status: "doing" | "done" | "blocked", note})`; adding steps is allowed, deleting is not. [ALONG] JSON over Markdown because models overwrite less, [Inference]
- Use function tools, not `text.format`, for plans and reports: `text.format` is part of the cache prefix [OAI-CACHE], `tool_choice` is not listed as one, and `allowed_tools` is documented as cache-friendly. [Inference from the documented list]
- Recitation: after each tool batch, the harness appends a `<weft_notice kind="plan">` with the compact checklist (under about 150 tokens). Append, never edit earlier items. [MANUS], [OAI-CACHE] "append new messages rather than rewriting earlier turns"
- Verification order: (1) executor post-conditions, (2) run-level `isDone`, (3) only for prose meant for a person (notice replies, employee messages): a reviewer task agent in a fresh context with the draft, the source facts and a short rubric, told to flag only correctness gaps. [ACC-BP], [DYN]

### 3.5 Errors and retries

- Tool error result shape: `{ok: false, code: "INVALID_INPUT", message: "start_date must be on or after 2026-10-15", hint: "Use the date from people__get.result.start_date", example: {...}}`. Short, specific, with a fix. [ATOOLS], [12F-9]
- Keep failed calls and their errors in context; do not erase them. [MANUS]
- Counters: `consecutive_errors` per run (reset on any success) and `attempts` per tool per run. At 3 consecutive errors or 3 failures of one tool, the run moves to `escalated` and posts to the decision inbox. [12F-9], [OAI-GUIDE]
- Argument repair: when arguments do not parse or fail Zod, return the error as the tool output (not a new user message) so the model fixes it in place; at most 2 repairs per call. research/agent.md 6.4, [Inference]
- A retried run starts a fresh context with a short "previous attempt" note, rather than continuing a polluted transcript. [ACC-BP] two failed corrections, [Inference]

### 3.6 Compact observations

- Default `response_format: "concise"` on read tools; `"detailed"` only on request. [ATOOLS]
- Names plus short stable ids (`Rowan Achebe (emp_014)`), never raw UUIDs alone. [ATOOLS]
- Hard cap per tool result (about 2,000 tokens [Inference]); over the cap, store the full result as a run artifact and return a summary, row count and `artifact_ref` that a paging tool can read. Manus restorable compression [MANUS], just-in-time retrieval [ACE].
- Tool result clearing: when a run passes a token threshold, replace old bulky tool outputs with their one-line summaries in the rendered history. [ACE] Caveat: this rewrites history and breaks the cache from that point [OAI-CACHE]; do it rarely, at a threshold, not every step [Inference].
- Sub-agent reports are bounded summaries (under about 1,500 tokens), not transcripts. [ACE]

### 3.7 Memory

- Two tiers, MemGPT style [MEMGPT]: a small always-in-context "core" block per company (preferences, standing instructions), with a character limit and its usage shown to the model like Letta's `chars_current/chars_limit` [LETTA]; and the memory git repo (research/agent.md section 9) as external memory reached only through search and read tools.
- The core block goes in the per-run context message, not the frozen prefix, so edits do not break the shared cache. [Inference]

### 3.8 Quarantine for untrusted content

- Agency notices, emails and documents are read by `task:notice_reader`, which has only read tools plus a forced strict `agent__report({agency, notice_type, amounts_cents, due_date, account_ref, requested_actions[], confidence})`. The main agent sees only that structured report, never the raw text, and acts through its own gated tools. [DYN] quarantine pattern, research/agent.md `<untrusted>` rule.

### 3.9 Batches

- Routines over many subjects (open enrollment for 30 employees, quarterly filings for 6 states) fan out to one task agent per subject with a barrier merge in code. Counters agentic laziness and few-shot ruts. [DYN], [MANUS]
- Concurrency still respects the provider queue in the draft SPEC.

---

## 4. Prompt and context layout (cache-friendly)

[Observed in docs, OAI-CACHE] Facts that drive the layout:
- GPT-5.6 and later: minimum cacheable prompt 1,024 tokens; exact boundaries reported; "Cache reuse requires the entire rendered prefix to match."
- Settings that change the prefix: `model`, `tools`, `parallel_tool_calls`, `text.format`, `reasoning.effort`, `text.verbosity`, `context_management`.
- GPT-5.6 and later: lifetime set by `prompt_cache_options.ttl`, only `"30m"` supported (default), refreshed on reuse. Explicit mode: `prompt_cache_options: {mode: "explicit"}` plus `prompt_cache_breakpoint: {mode: "explicit"}` on an `input_text` content part; top-level `instructions` cannot hold a breakpoint; up to four cache writes per request.
- `prompt_cache_key` on GPT-5.6+ is optional and used for separate cache accounting per customer, user or workspace and to prevent cross-user cache-hit probing; routing is automatic.
- Luna cache writes bill at 1.25x uncached input [OAI-LUNA].

Layout for every Luna request [Inference]:

```
input[0]  developer message, frozen per agent kind, >= 1,024 tokens
          (identity, how_you_work, tool namespace guide, memory conventions, style, role)
          no dates, names, ids, flags; byte-identical across runs
tools     frozen per agent kind, sorted by name, deterministic JSON (sorted keys)
input[1]  user message: <context> per run (company, simulated now, acting_for, grants,
          trigger, core memory block, memory hits) + <request>
input[2+] append-only: model output items (reasoning, function_call, message) exactly as
          returned, function_call_output items, <weft_notice> user messages
settings  model, reasoning.effort, parallel_tool_calls fixed per agent kind
```

- Put the frozen prompt in a developer message, not `instructions`, if explicit breakpoints are ever needed (instructions cannot hold one). [OAI-CACHE]
- Start with implicit caching; switch to explicit mode only if `cached_tokens / input_tokens` stays low across a multi-step run. [Inference]
- `prompt_cache_key: "weft:<agent_kind>:<company_id>"` for per-company accounting. [OAI-CACHE], [Inference]
- The section 15 prompt in research/agent.md says "at least 512 tokens so it caches". For Luna the floor is 1,024 tokens. [OAI-CACHE]

---

## 5. Model facts for gpt-5.6-luna

[Observed on the model page, OAI-LUNA]
- Context 1,050,000; max input 922,000; max output 128,000; knowledge cutoff Feb 16, 2026; text and image in, text out.
- Price per 1M tokens: input $0.20, cached input $0.02, output $1.20. Prompts over 272K input tokens cost 2x input and 1.5x output for the whole request. Cache writes 1.25x uncached input ($0.25/M).
- Reasoning efforts: none, low, medium, high, xhigh, max. Default medium. (No `minimal` listed.)
- Endpoints: Responses, Chat Completions, Batch. Features: function calling, structured outputs, streaming, prompt caching. The page does not mention parallel tool calls.
- Only snapshot: `gpt-5.6-luna`. Rate limits (Build tier): 5,000 RPM, 2,000,000 TPM.

[Observed, OAI-REASON]
- GPT-5.6 models default `reasoning.context` to `all_turns` (values `auto`, `current_turn`, `all_turns`); reasoning is reusable only within the same family (5.6 models can share with each other, not with 5.5). With `all_turns`, "you must preserve every output item and replay the full history" in stateless mode.
- Reasoning tokens are billed as output and reported in `usage.output_tokens_details.reasoning_tokens`.
- `max_output_tokens` caps reasoning plus visible output; hitting it gives `status: "incomplete"`, `incomplete_details.reason: "max_output_tokens"`, possibly with no visible output. The guide suggests reserving at least 25,000 tokens when experimenting.
- `reasoning.mode` (`standard` default, `pro`) exists for GPT-5.6 and GPT-6 models in Responses only; pro costs more. Keep standard.
- Prompting: give a clear goal, constraints, and output format; define what "done" means and how to verify; treat effort as a tuning knob, not the main quality lever.

[Brief] Verified 2026-10-15 by the brief's author: on `/v1/chat/completions` Luna rejects function tools unless `reasoning_effort` is `"none"`; on `/v1/responses` with `reasoning.effort: "low"` a strict function call worked. So the Luna provider must use Responses.

[Inference] Escalation to `gpt-5.6-terra` changes `model`, so it starts a new cache prefix, but reasoning items are shareable within the 5.6 family per [OAI-REASON]. Escalate a whole task agent run, not single steps.

---

## 6. Exact Responses API usage with the official openai TypeScript SDK

[Observed] npm registry today: `openai` latest is 7.34.0 (modified 2026-10-14). The SDK is not installed anywhere in this research, so the code below is assembled from the docs and is not compiled. The builder should pin `openai@7.34.0` and typecheck it.

### 6.1 Client

```ts
import OpenAI from "openai";
// Documented helper for replaying output items as input [OAI-FC]; verify the path after install.
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // loaded from env or WEFT_SECRETS_FILE, never logged
  maxRetries: 2,                      // SDK default; retries connection errors, 408, 409, 429, 5xx
  timeout: 120_000,                   // SDK default is 10 minutes; too long for one agent step
});
```
[OAI-NODE] for errors, retries and timeout.

### 6.2 Strict function tool

```ts
const tools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "people__get",
    description: "Get one employee by id. Returns name, title, state, start date, manager. Use ids from earlier results.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "Employee id like emp_014" },
        response_format: { type: "string", enum: ["concise", "detailed"] },
        fields: { type: ["array", "null"], items: { type: "string", enum: ["pay", "tax", "benefits", "it"] } },
      },
      required: ["person_id", "response_format", "fields"],
      additionalProperties: false,
    },
  },
];
```
Rules from [OAI-FC]: `additionalProperties: false` on every object, every property in `required`, `["T", "null"]` for optional; enums and object structure to prevent invalid states.

### 6.3 One step

```ts
const res = await client.responses.create({
  model: process.env.WEFT_MODEL ?? "gpt-5.6-luna",
  input,                                  // full replayed history, see 6.5
  tools,                                  // frozen per agent kind
  tool_choice: { type: "allowed_tools", mode: "auto", tools: phaseTools.map((name) => ({ type: "function", name })) },
  parallel_tool_calls: true,              // fixed per agent kind (cache prefix)
  reasoning: { effort: "low" },           // fixed per agent kind (cache prefix)
  store: false,
  include: ["reasoning.encrypted_content"], // legacy but accepted; default when store is false [OAI-REASON]
  prompt_cache_key: `weft:${agentKind}:${companyId}`,
  max_output_tokens: 16_000,              // tune from observed reasoning_tokens
});
console.log(res._request_id);             // log it with the run step [OAI-NODE]
```

- `tool_choice` options [OAI-FC]: `"auto"` (default), `"required"`, `"none"` (like passing no tools, keeps definitions for caching [OAI-CACHE]), `{type: "function", name}`, `{type: "allowed_tools", mode, tools}`.
- `parallel_tool_calls: false` guarantees zero or one call per turn [OAI-FC]. [Inference] Keep it `true` and let the executor run the calls of one turn sequentially in emitted order, stopping the batch at the first gated or failed write (remaining calls get a `SKIPPED_AFTER_BLOCK` output so every `call_id` still gets an output). Changing the flag per phase would break the cache.

### 6.4 Handling the response (order matters) [Inference, from OAI-REASON, OAI-SO, OAI-FC]

1. `res.status === "incomplete"` with `incomplete_details.reason === "max_output_tokens"`: do not execute any function call from it; retry the step once with a higher cap; then fail the run with `MODEL_INCOMPLETE`.
2. Any `status` other than `completed`: record and fail the step.
3. A message content part of type `"refusal"`: record it, end the run as `refused` with the text shown to the user [OAI-SO].
4. Append all output items to history (6.5) before executing tools.
5. For each `function_call` item (`id`, `call_id`, `name`, `arguments` as a JSON string [OAI-FC]): `JSON.parse` in a try block; Zod-validate; run through `Executor.exec`; append `{type: "function_call_output", call_id, output: JSON.stringify(result)}` [OAI-FC].
6. No function calls: the turn is a final answer; read `res.output_text`.

### 6.5 Conversation state: stateless replay vs previous_response_id

| | Stateless replay (recommended) | `previous_response_id` + `store: true` |
|---|---|---|
| Mechanism | Append `response.output` items (via `toResponseInputItems`) plus `function_call_output` items to your own `input` array [OAI-STATE], [OAI-FC] | Pass `previous_response_id: res.id` and only new items [OAI-STATE] |
| Reasoning items | With `store: false`, reasoning items carry `encrypted_content` by default; must be replayed; with `all_turns` (5.6 default) replay the full history [OAI-REASON] | Kept server-side |
| Billing | Every input token billed each step (cache makes repeats $0.02/M) | "all previous input tokens for responses in the chain are billed as input tokens" [OAI-STATE] |
| Retention | None at OpenAI | Response objects stored 30 days by default [OAI-STATE] |
| Fit for Weft | Same SQLite step log drives Luna, Claude, local and scripted providers; survives restarts and multi-day approvals; deterministic tests replay it | Run state split between SQLite and OpenAI; breaks after 30 days; no gain in cost |

[Inference] Choose stateless replay. Store each step's raw `output` array as JSON in `run_steps` so replay is byte-identical (cache-stable). For GPT-5.5 and 5.4, keep any assistant `phase` value exactly when replaying [OAI-REASON]; harmless to preserve for 5.6.

Compaction exists if a run ever gets long [OAI-COMPACT]: server-side `context_management: [{type: "compaction", compact_threshold}]` on create, or `client.responses.compact({...})` returning `compacted.output` to pass on unpruned; both ZDR-friendly with `store: false`. [Inference] Not needed at Weft's step budgets; the documented model list for compaction did not name Luna.

### 6.6 Structured output (when not using a tool)

```ts
import { zodTextFormat } from "openai/helpers/zod";
const r = await client.responses.parse({ model, input, text: { format: zodTextFormat(Schema, "notice_summary") } });
const parsed = r.output_parsed;
```
[OAI-SO]. [Inference] Use only for single-shot calls outside the agent loop (classifiers, extractors in workflows), because `text.format` is part of the cache prefix.

### 6.7 Usage and cost accounting

Fields [OAI-CACHE], [OAI-REASON]: `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.input_tokens_details.cache_write_tokens` (GPT-5.6+), `usage.output_tokens`, `usage.output_tokens_details.reasoning_tokens`. Cached and cache-write tokens are subsets of `input_tokens`; the doc's formula subtracts both to get ordinary input.

```ts
const u = res.usage!;
const cached = u.input_tokens_details?.cached_tokens ?? 0;
const written = (u.input_tokens_details as any)?.cache_write_tokens ?? 0; // field per docs; check SDK types
const ordinary = u.input_tokens - cached - written;
const long = u.input_tokens > 272_000;                       // Luna long-prompt surcharge [OAI-LUNA]
const inRate = 0.20 * (long ? 2 : 1), outRate = 1.20 * (long ? 1.5 : 1);
const usd = (ordinary * inRate + cached * inRate * 0.1 + written * inRate * 1.25 + u.output_tokens * outRate) / 1e6;
```
Worked example [Inference]: a step with 8,000 input tokens of which 6,000 cached, 400 output: 2,000 x $0.20/M + 6,000 x $0.02/M + 400 x $1.20/M = $0.0004 + $0.00012 + $0.00048 = about $0.001. A 20-step task is about 2 cents. Output (mostly reasoning) is about half the cost, so `effort: "low"` matters more than cache tuning once the cache works.

Store per step: model, effort, the 5 usage numbers, computed USD, `_request_id`, latency. Roll up per run and per day; enforce a per-run and per-day USD ceiling in code [Inference].

### 6.8 Errors [OAI-NODE]

| Error | SDK class | Weft action [Inference] |
|---|---|---|
| 400 | `BadRequestError` | Not retryable: a bad schema (strict non-conforming schemas are rejected [OAI-FC]) or unsupported parameter. Fail the step `PROVIDER_REQUEST_INVALID`; a request-builder snapshot test should catch these before runtime |
| 401 / 403 | `AuthenticationError` / `PermissionDeniedError` | Stop the queue for this provider; surface a config error; never print the key |
| 404 | `NotFoundError` | Wrong model id in `WEFT_MODEL`; config error |
| 409 / 408 / 429 / 5xx | `ConflictError` / `RateLimitError` / `InternalServerError` | SDK retries twice with backoff; then requeue the step with backoff in Weft's queue |
| No response | `APIConnectionError`, `APIConnectionTimeoutError` | Same as 5xx |
| Abort | via `signal: AbortSignal` | User cancelled the run |

### 6.9 The 5 smoke calls to run once (not run here)

Each is tiny (under 2,000 input tokens, `max_output_tokens` about 1,000), under $0.01 total [Inference]:
1. One strict function tool, `effort: "low"`, `store: false`: confirm a `function_call` item and its `call_id`.
2. Send the `function_call_output` back with the replayed output items: confirm a final message and that `reasoning` items carried `encrypted_content`.
3. Two independent read tools with `parallel_tool_calls: true`: confirm whether Luna emits parallel calls at all (the model page does not mention them).
4. Repeat call 1 with a >1,024-token frozen developer message twice: confirm `cached_tokens` > 0 and the presence of `cache_write_tokens` in usage.
5. `allowed_tools` restricting to one of three tools: confirm the restriction and that `cached_tokens` is unchanged vs call 4.

---

## 7. Evals that catch regressions

[Grounded in ATOOLS and OAI-GUIDE; the tiering is Inference]

| Tier | What | When | Cost |
|---|---|---|---|
| T0 unit | Executor matrix, error shapes, `isDone` checks, request-builder snapshot per agent kind | Every commit | 0 |
| T0 prefix stability | Hash of (developer prompt bytes + serialized tools + model + effort + parallel flag) per agent kind; changes must be deliberate and noted. Catches silent cache breakers like a timestamp or key reordering [MANUS], [OAI-CACHE] | Every commit | 0 |
| T1 scripted scenarios | Golden flows driven by the scripted provider with live executor and simulators; assert database end state | Every commit | 0 |
| T2 cassettes | Recorded Luna responses replayed through the Luna adapter: tool round trip, parallel calls, incomplete, refusal, malformed args | Every commit | 0 after one recording |
| T3 live eval | 10 to 20 realistic tasks, held-out subset, scored by deterministic verifiers on end state, 1 to 3 trials each | On demand, `WEFT_LIVE_EVAL=1`, hard USD cap | About 2 cents per task run |

T3 metrics per task [ATOOLS]: success, total tool calls, invalid-argument errors, other tool errors, input/cached/output/reasoning tokens, cache-hit ratio, USD, wall time, steps to done. Store as JSON and diff against the last baseline; flag a regression when success drops or cost or error counts rise beyond a threshold.

Baseline [OAI-GUIDE]: if budget allows, run T3 once with a stronger model (terra or Claude) to set the ceiling, then compare Luna; the gap shows which task kinds need more harness, not a bigger model.

Read transcripts, not only scores: redundant calls point to pagination or truncation; invalid-parameter errors point to unclear descriptions [ATOOLS].

---

## 8. Patterns: copy, adapt, avoid

### Copy as is
- Strict function tools with explicit `strict: true`, all-required, nullable optionals, enums [OAI-FC].
- `allowed_tools` for phase masking; never mutate the tool list mid-run [OAI-FC], [OAI-CACHE], [MANUS].
- Append-only context, deterministic serialization, no timestamps in the prefix [MANUS], [OAI-CACHE].
- Errors kept in context, actionable, with a 3-strike escalation [MANUS], [12F-9], [ATOOLS].
- Human approval as a tool result that pauses the run [12F-7], [12F-8], [OAI-GUIDE].
- Tool risk tiers (low, medium, high) mapped to approval policy [OAI-GUIDE] (already in the command registry).
- Concise/detailed `response_format`, readable names over UUIDs, capped results [ATOOLS].
- Writer/reviewer separation for prose; deterministic checks for everything else [ACC-BP], [DYN].
- Quarantine reader for untrusted documents [DYN].
- Evals with realistic tasks, verifiable outcomes, and the five metrics [ATOOLS].

### Adapt
- Manus logit masking and prefill modes: Weft cannot mask logits on a hosted API; use `tool_choice` (`required`, specific function, `allowed_tools`) for the same three modes [MANUS], [OAI-FC].
- Manus todo.md recitation: a plan table in SQLite plus an appended compact `<weft_notice kind="plan">` [MANUS].
- Anthropic feature-list JSON: a per-run plan where the model can only change step status, and code decides done [ALONG].
- Letta memory blocks: one company core block with a visible character budget, in the per-run context [LETTA].
- Sub-agents: task agents with fixed tool subsets and bounded reports; fan-out per subject for batches [ACE], [DYN].
- Model routing: escalate a whole task run to terra only after a verifier failure, behind a flag [BEA], [DYN].
- Compaction: available via `context_management` but keep runs short enough not to need it [OAI-COMPACT].

### Avoid
- An open-ended "do anything" agent for golden flows [BEA], [12F].
- `previous_response_id` plus `store: true` as the source of truth [OAI-STATE].
- Changing `reasoning.effort`, `parallel_tool_calls`, `text.format` or tools inside a run (each breaks the cache) [OAI-CACHE].
- Editing earlier messages to inject fresh facts; append notices instead [OAI-CACHE], [MANUS].
- Letting the model compute money, dates or totals [Inference].
- Self-grading in the same context [DYN], [ACC-BP].
- Long uniform loops over many subjects (few-shot ruts, laziness) [MANUS], [DYN].
- Code Mode or any arbitrary code execution in the foundation [ACODE] caveat, [Inference].
- Chat Completions for Luna tool use [Brief].
- Raw stack traces as tool output [ATOOLS].

---

## 9. Sandboxes: open source and Cloudflare free tier (user request)

### 9.1 Does Weft need one? [Inference]

Not for the foundation. The Weft agent never runs code: it emits typed tool calls and the executor runs registered commands against SQLite and in-repo simulators (research/agent.md decision 1). That boundary is the sandbox. A sandbox becomes useful only for (a) a later Code Mode style "analyze data" tool, (b) running third-party MCP servers or shell commands, or (c) hosting a public demo. Since only a few people will use it, the laptop options below are enough; nothing needs a hosted fleet.

### 9.2 Options

| Option | License | Isolation | Runs on this Mac (M5, Node 25.9) | Cost | Fit for Weft |
|---|---|---|---|---|---|
| quickjs-emscripten 0.32.0 | MIT [Observed npm] | QuickJS compiled to WASM, in process; "no host functionality is exposed" by default; memory limit, stack limit, interrupt-after-deadline [QJS] | Yes, pure WASM | Free | Best fit for a future read-only code tool: expose one `weft` object whose functions call `Executor.exec` with read commands only. README: not audited [QJS] |
| workerd 1.20261015.1 (+ Dynamic Worker Loader) | Apache-2.0 [Observed npm] | V8 isolates; `globalOutbound: null` blocks network; bindings carry capabilities [CF-CODEMODE], [CF-DW-BETA] | Cloudflare states dynamic worker loading works locally with Wrangler and workerd [CF-CODEMODE] (Sep 2025 statement, not re-tested) | Free locally | Heavier: a separate process the Node app calls over HTTP. Good if Weft ever targets Workers |
| @anthropic-ai/sandbox-runtime 0.0.79 (`srt`) | Apache-2.0 [Observed npm] | OS level: macOS `sandbox-exec` Seatbelt profiles, Linux bubblewrap; network deny-by-default through a host proxy with domain allowlist; write allow-list [SRT] | Yes (needs ripgrep) | Free | Wrap shell commands, third-party MCP servers or a local model server; "Beta Research Preview" [SRT] |
| microsandbox 0.7.8 | Apache-2.0 [Observed npm] | Micro VMs; network allowlist; secrets injected outside the VM [MSB] | macOS Apple Silicon supported; "under 100 milliseconds" boot claim on M1 [MSB] | Free | Full Linux per task if ever needed; "still beta software" [MSB] |
| Docker (already installed) | n/a | Containers in Docker Desktop's VM; `--network none`, read-only root, CPU and memory limits | Yes | Free | Simple fallback for running untrusted tools |
| isolated-vm 7.0.1 | ISC [Observed npm] | V8 isolates in Node; memory limit is "more of a guideline" | **No**: odd-numbered Node versions are unsupported and this Mac runs Node 25.9; README says "maintenance mode" [IVM] | Free | Avoid |
| E2B infra | Apache-2.0 [E2B-INFRA] | Firecracker microVMs | **No**: needs Linux with KVM [E2B-INFRA] | Self-host on cloud | Avoid for a laptop project |

### 9.3 Cloudflare specifically

- **Sandboxes on Cloudflare** (Containers, a Linux microVM per sandbox driven by a Durable Object; plus Dynamic Workers): "Available on Workers Paid plan" [CF-SANDBOX]. Packages: `@cloudflare/sandbox` 1.0.1, Apache-2.0 [Observed npm].
- Local dev without deploying: `wrangler dev` runs the container in Docker on your machine (Docker must be running; Wrangler 4.141.0 or later) [CF-SANDBOX-GS]. [Inference] That is free, but it is just Docker with Cloudflare's API on top.
- **Dynamic Workers** (V8 isolates created at runtime, the Code Mode engine): open beta since Mar 24, 2026 "for all paid Workers users"; `env.LOADER.load({compatibilityDate, mainModule, modules, globalOutbound: null})` for one-shot, `env.LOADER.get(id, cb)` to keep warm; helpers `@cloudflare/codemode`, `@cloudflare/worker-bundler`, `@cloudflare/shell` [CF-DW-BETA]. Pricing: 1,000 unique Dynamic Workers per month included then $0.002 per Worker per day (the changelog says this charge is not active yet), 10M requests and 30M CPU ms included [CF-DW-PRICING], [CF-DW-BETA]. Workers Paid is a $5 per month subscription [Third party: search summary; confirm on Cloudflare's plans page].
- **Workers Free plan**: 100,000 requests per day, 10 ms CPU per HTTP request, 128 MB memory, 50 subrequests per invocation, 5 cron triggers [CF-LIMITS]. No sandbox product is on it.
- [Inference] So: on the free tier there is no hosted Cloudflare sandbox. The free Cloudflare path is local only (workerd for isolates, wrangler dev plus Docker for containers). If a hosted demo ever needs sandboxed code, $5 per month Workers Paid covers Dynamic Workers well within the included quota for a handful of users.

### 9.4 Recommendation [Inference]

1. Foundation: no code-execution tool. The executor is the sandbox.
2. If a "compute over data" tool is added later: quickjs-emscripten in process, deadline 2 s, memory 32 MB, only read-command host functions, results capped like any tool result.
3. Wrap any third-party MCP server or shell tool with `srt` (network allowlist empty by default).
4. Keep Cloudflare Dynamic Workers as the hosted option only if Weft is ever deployed to Workers Paid.

---

## 10. Gaps against the draft SPEC and research/agent.md [Observed in local files]

- SPEC.md line 198 says the local provider uses plain `fetch` with "no `openai` or AI SDK dependency", and line 462 lists provider ids `"claude" | "openai_compat" | "scripted"`. The brief makes OpenAI Responses with the official `openai` SDK the default for real runs. The SPEC needs a fourth provider, `openai` (Responses, Luna), and the dependency.
- research/agent.md section 15 targets "at least 512 tokens so it caches" (a Claude figure). Luna needs at least 1,024 tokens [OAI-CACHE].
- research/agent.md 6.4 notices become user messages; keep that for Luna too (append-only), and never use top-level `instructions` for per-run content.
- research/agent.md section 5 sorts tools by name for Claude; do the same for Luna and add the prefix-stability hash test.
- The plan tool, `isDone` checks, consecutive-error counter, quarantine reader and cost ledger are not yet in the SPEC.

## 11. Open questions for the architect

1. Does Luna emit parallel function calls at all? (Smoke call 3.)
2. Default effort for task agents: `low` everywhere, or `none` for pure extraction steps in workflows (separate agent kind so the cache stays stable)?
3. `reasoning.context: "current_turn"` vs the 5.6 default `all_turns`: does dropping old reasoning cut cost without hurting multi-step runs? Needs a T3 comparison.
4. Step budgets and per-run USD ceilings per agent kind.
5. Whether to record a one-time stronger-model baseline for T3 within the $0.50 per agent budget.

---

## 12. Sources

| Tag | Source |
|---|---|
| BEA | https://www.anthropic.com/engineering/building-effective-agents |
| ACE | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| ALONG | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| ATOOLS | https://www.anthropic.com/engineering/writing-tools-for-agents |
| ACC-BP | https://code.claude.com/docs/en/best-practices (redirect target of https://www.anthropic.com/engineering/claude-code-best-practices) |
| DYN | https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/ (redirect target of https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) |
| ACODE | https://www.anthropic.com/engineering/code-execution-with-mcp |
| OAI-GUIDE | https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf |
| OAI-FC | https://developers.openai.com/api/docs/guides/function-calling |
| OAI-STATE | https://developers.openai.com/api/docs/guides/conversation-state |
| OAI-REASON | https://developers.openai.com/api/docs/guides/reasoning |
| OAI-CACHE | https://developers.openai.com/api/docs/guides/prompt-caching |
| OAI-SO | https://developers.openai.com/api/docs/guides/structured-outputs |
| OAI-COMPACT | https://developers.openai.com/api/docs/guides/compaction |
| OAI-LUNA | https://developers.openai.com/api/docs/models/gpt-5.6-luna |
| OAI-NODE | https://github.com/openai/openai-node (README) |
| MANUS | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus |
| 12F | https://github.com/humanlayer/12-factor-agents |
| 12F-7 | https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-07-contact-humans-with-tools.md (title only read) |
| 12F-8 | https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-08-own-your-control-flow.md |
| 12F-9 | https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-09-compact-errors.md |
| MEMGPT | https://arxiv.org/abs/2310.08560 |
| LETTA | https://docs.letta.com/guides/agents/memory-blocks |
| CF-CODEMODE | https://blog.cloudflare.com/code-mode/ |
| CF-SANDBOX | https://developers.cloudflare.com/sandbox/ |
| CF-SANDBOX-GS | https://developers.cloudflare.com/sandbox/get-started/ |
| CF-DW-BETA | https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/ |
| CF-DW-PRICING | https://developers.cloudflare.com/dynamic-workers/pricing |
| CF-LIMITS | https://developers.cloudflare.com/workers/platform/limits/ |
| SRT | https://github.com/anthropics/sandbox-runtime |
| MSB | https://github.com/microsandbox/microsandbox |
| QJS | https://github.com/justjake/quickjs-emscripten |
| IVM | https://github.com/laverdet/isolated-vm |
| E2B-INFRA | https://github.com/e2b-dev/infra |
| npm | `npm view` on 2026-10-15: openai 7.34.0; @anthropic-ai/sandbox-runtime 0.0.79 Apache-2.0; isolated-vm 7.0.1 ISC; quickjs-emscripten 0.32.0 MIT; microsandbox 0.7.8 Apache-2.0; @cloudflare/sandbox 1.0.1 Apache-2.0; workerd 1.20261015.1 Apache-2.0 |
| Local | ~/Developer/projects/weft/SPEC.md (lines 198, 462), ~/Developer/projects/weft/research/agent.md (sections 0, 6.4, 7.2, 15) |
