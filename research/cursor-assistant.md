# A cursor assistant for Weft (research, 2026-10-24)

**Status: built (phases 1 and 2), 2026-10-24, branch `cf/assist`.** Section 8 lists what shipped, where it lives and
where it differs from this design. Phase 3 (the eval tasks and a live measurement) is still open.

Nitish asked for a feature like [cursor-buddy](https://github.com/leojuriolli7/cursor-buddy): an assistant that lives at the cursor and answers by pointing at something on screen, moving to another page, or showing a short answer in a popover next to the cursor. This note covers what cursor-buddy does, why Weft should borrow its ideas rather than its package, and a design that fits Weft's harness.

## 1. What cursor-buddy is

An MIT-licensed TypeScript package (React client plus a server handler on the Vercel AI SDK), small and young (3 stars, last updated 2026-05-07).

- **Push to talk.** Hold Ctrl+Alt, speak, release. Browser speech recognition first, server transcription (whisper) as a fallback.
- **Screen context.** While you talk it captures a screenshot and a token-efficient DOM snapshot of the visible page. Every visible, meaningful element gets an id such as `@12`, with its tag, text, key attributes and bounding box (`@8 button "Sign In" [type="submit"] [x=460 y=420 w=360 h=40]`).
- **The point tool.** The model answers in text and may call `point({ elementId, label })` once per reply. The client resolves `@12` from its snapshot registry and animates a second cursor along a bezier curve to the element's center, with a short label bubble.
- **Output.** A speech bubble at the cursor, spoken through browser or server text to speech, interruptible by pressing the hotkey again. Tool calls show as small bubbles; tools that need approval take Y or N.

## 2. Borrow the ideas, not the package

Dropping the package in would bypass what makes Weft's agent trustworthy:

- It runs its own model loop and tool execution on the AI SDK, outside Weft's executor, so none of these would apply: grounding (every number from a tool result), taint, proposals and approvals, the spend ledger and caps, the hosted rate limits and rows budgets, Phoenix tracing, the evals.
- Its DOM snapshot sends whatever text is visible, including text people typed (time-off notes, expense purposes, notice bodies), to the model unwrapped. Weft marks that text untrusted and taints the run.
- It brings a second model provider and a second chat history.

So Weft builds the feature natively and borrows four ideas: push to talk, a compact screen map with ids, a single point action, and an animated pointer with a bubble.

## 3. What Weft already has

| Piece | Where | Reused for |
|---|---|---|
| Guided tour engine: 43 `data-tour` anchors, element lookup with fallbacks, scroll into view, ring highlight, a card placed next to a target, route changes between steps | `apps/web/src/components/tour/` | pointing, moving between pages and placing the popover |
| Agent runs with typed tools, grounding, taint, proposals, approval cards | `packages/agent`, `packages/executor` | answering, with every guard unchanged |
| Page context ("Ask about this page") | `pageContext` in `POST /v1/agent/runs` | the current screen, extended into a screen map |
| Conversation threads and the Agent page | `apps/web/.../agent-page`, `thread_id` | "Continue in Agent" from the popover |
| Dictation: Workers AI whisper on the hosted app, 16 kHz WAV from the browser | `apps/cf/src/extras`, `dictate-button.tsx` | push-to-talk voice on the hosted app |
| Command menu and the nav registry | `shell/command-menu.tsx`, `nav.ts` | the list of places the assistant may navigate to |

## 4. Design

### 4.1 How a person uses it

- **Ask:** press a hotkey (for example Cmd+J) to type, or hold Ctrl+Alt to talk. A small composer opens next to the cursor.
- **Get the answer in one of three ways, chosen by the agent:**
  - **Point:** a soft pointer glides to the element and rings it, with a two-to-four-word label. Example: "Where do I approve Ruth's time off?" rings the request's Approve button in the Inbox.
  - **Go there:** it navigates to the right page or tab, then points. Example: "Show me the Oct 30 payroll flags" opens the run and rings the needs-review section.
  - **Answer:** a popover next to the cursor with a short, grounded answer (numbers cite their tool result, as in chat), plus **Continue in Agent**, which opens the same exchange as a thread on the Agent page.
- **Stop:** press the hotkey again to dismiss or interrupt.
- **Changes:** for anything that changes data, the popover shows the usual approval card. The assistant never clicks, types or approves for the person.

### 4.2 The screen map (instead of a raw DOM dump)

Built on the client when the composer opens, about 1,500 tokens at most:

- the route, the page title and the active tab;
- every visible Weft anchor (`data-tour`, test ids, ARIA landmarks) with an id (`@1`, `@2`, ...), its kind (button, tab, table row, card), its visible label, the entity it shows (`prp_0014`, `wrk_0016`) and its box;
- short visible text for headings and labels only; text from fields people typed is left out, or wrapped as untrusted, in which case the run is tainted as for any untrusted read.

### 4.3 The agent side

- **A new recipe, `assist`:** the chat read tools (CHAT_TOOLS) plus three presentation tools.
  - `ui.point({ target, label })`: the target must be an id from this request's screen map, or a known anchor of the destination page.
  - `ui.navigate({ route, target? })`: the route must be in the nav registry.
  - `ui.say({ text })`: the popover text, checked by the grounding guard like any answer.
- **Effects stay on the client:** the presentation tools are recorded in the run's steps like any tool call, and the client applies them (point, navigate, show). They change no data, so the executor treats them as R0 reads that write nothing.
- **Bounded runs:** at most 4 model steps, the usual $0.10 run cap, and on the hosted app RL_RUN and the rows budget. On gpt-5.6-luna a question costs about $0.001 to $0.004.
- **Instant path for "where is X":** a deterministic resolver over the nav registry, anchor labels and the help corpus answers navigation questions without a model call. Only questions it cannot match go to the agent.

### 4.4 Voice

- **Hosted app:** push to talk records 16 kHz WAV and sends it to the existing dictation route (Workers AI whisper, counted against the neuron share).
- **Local app:** the browser's speech recognition where available; otherwise typing only.
- **Spoken answers:** optional, through the browser's speech synthesis, which costs nothing and needs no server. Off by default.

### 4.5 Visuals

- The pointer reuses the tour's ring and card styles, so the assistant and the tour look like one system.
- The pointer glides along a short eased curve (cursor-buddy uses a bezier); with reduced motion it jumps.
- The popover follows the tour card's placement rules (stays inside the viewport, never covers its target) and becomes a bottom sheet on phones.

### 4.6 Evaluation

New `assist` tasks in the eval suite, with deterministic graders:

- **Pointing:** the target id is the expected anchor.
- **Navigation:** the route is the expected page.
- **Grounding:** every number in the popover comes from a tool result.
- **Safety:** no write without a proposal, and untrusted text taints the run.

## 5. Plan

| Phase | Scope | Size |
|---|---|---|
| 1 | Typed questions at the cursor: hotkey, composer and popover; the screen map; the `assist` recipe with `ui.point`, `ui.navigate` and `ui.say`; pointer and navigation on the tour engine; Continue in Agent; the instant "where is X" resolver; unit, API and Playwright tests on the scripted provider; local and hosted | about one build session |
| 2 | Push to talk (hosted whisper, browser speech recognition locally), the gliding pointer, tool bubbles, optional spoken answers | about half a session |
| 3 | `assist` eval tasks and a live measurement on luna; recorded showcase questions for the demo | about half a session |

## 6. jev-ultrafast, considered for computer use

[jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (Browser Use, MIT, released 2026-09-16) is a fast Python browser agent: each step reads the page into a numbered table of controls and one request picks an operation (click, type, select, scroll, done) and a target, with a small model writing text only when it types; before acting it checks that the element is still there and not covered. Weft does not use it directly: it drives Chrome from outside through remote debugging (it cannot run in a visitor's browser, and the hosted app has no browser to drive), it needs TypeSafe and OpenRouter accounts, and its clicks would act as the person, bypassing proposals, approvals and the audit log. Weft borrows its numbered element table, its check-before-acting step and its one-call-per-decision shape.

## 7. Decisions (Nitish, 2026-10-24)

1. **Wake:** a small icon floats next to the cursor. A double right-click wakes it and starts listening; a single right-click inside the app shows a small Weft menu (Copy, Ask about this) in place of the browser's menu; clicking the icon opens it for typing.
2. **Scope:** phases 1 and 2 together (typed and spoken questions, pointing, navigation, popover answers, the gliding pointer).
3. **What it does on its own ("show me"):** it points, navigates and drives the UI to show things (open a row, switch a tab or filter, scroll, expand a section). It never clicks Approve, Submit or any control that changes data; changes are proposals with the usual approval card, so the audit log stays honest.
4. **Voice in:** the browser's live speech recognition where available, with the hosted whisper route as the fallback.
5. **Voice out:** off by default. When on: Chatterbox Nano in the browser (community ONNX build, MIT, about 390 MB downloaded once and cached, WebGPU in Chrome or Edge), falling back to Deepgram Aura-2 on Workers AI (about $0.006 per short answer) where the browser cannot run it.
6. **The in-browser voice:** Resemble AI's built-in default voice, the `conds.pt` its MIT model repos ship and its own code loads when it is given no reference clip (ResembleAI/chatterbox-nano at a pinned revision). Who the speaker is and their consent are not documented; that was accepted.
7. **Marking:** spoken answers carry no label and no audio watermark (the ONNX path applies none, unlike upstream's PerTh watermark in PyTorch).

## 8. What was built (2026-10-24)

Everything in sections 4 and 7, plus three upgrades from Nitish's review: the assistant uses the app from the inside
(structured cursor context and typed intents instead of synthetic clicks), page view state lives in the URL so one
validated link reaches any record on any page, and complicated requests go to the full agent on their own.

| Piece | Where |
|---|---|
| The manifest shared by client, executor and agent: tools, budget, screen map, cursor context, records, trail, nav registry, anchors, intents, URL query keys, show allowlist and denylist, effects, help corpus, test ids, speech constants | `packages/contracts/src/ext/assist.ts`, `assist-speech.ts` |
| Presentation tools, validated server side | `packages/executor/src/assist.ts` |
| The `assist` recipe, its frozen prompt (`as.r3`), pack, instant resolver, closing show and the handoff | `packages/agent/src/assist/`, `loop.ts`, `runtime.ts`, `prompts/index.ts` |
| The route, the screen map in the run workspace, taint, the minted thread | `apps/api/src/routes/agent.ts` |
| The client: icon, Weft menu, composer, card, progress card, chips, choices, walkthrough player, effects, live guard, voice in and out | `apps/web/src/components/assist/` (mounted once in `app-shell.tsx`) |
| Hosted: the speak route (Aura-2), the speech neuron share, the handoff's admission, the CSP | `packages/cf-extras/src/speech.ts`, `apps/cf/src/extras/http.ts`, `apps/cf/src/front/index.ts`, `apps/cf/src/core/company/company-do.ts`, `apps/web/scripts/cf-export.ts` |

Where it differs from sections 4 and 7:

- **Six presentation tools, not three.** `ui.point`, `ui.navigate`, `ui.say` as designed, plus `ui.show` (typed
  intents, or a non-mutating control from the screen map), `ui.handoff` and `ui.steps` (walkthroughs of at most 6
  steps). The 16-tool cap holds with 10 chat reads: the run feed post, `actions.get_run`, `agent.read_artifact` and
  `tax.list_registrations` are left out, and the full agent a handoff reaches has them all.
- **"Show me" goes through typed intents.** Pages register named, non-mutating intents; the server checks each
  against a static manifest that has no approve, submit or run intent at all. Global intents (`payroll.openPaycheck`,
  `people.openTab`, `compliance.openTab`, `approval.card` and others) are links whose query keys are validated per
  route (`ASSIST_QUERY_KEYS`). The element fallback takes only open, tab, scroll, expand and collapse on allowed
  kinds, and refuses any control whose label, test id or anchor reads as a change; the browser checks the live
  element again before it acts.
- **Context is structured, not scraped.** Besides the screen map: the record under the pointer, a hover trail, the
  selection, the focused control, an open layer and the URL's view state; summaries of the records the page already
  holds in its query cache; and the last ten in-app events. Text people typed goes only as untrusted and taints the
  run.
- **Handoff to the full agent.** A change, an analysis or several asks at once become an ordinary chat run in the
  same thread (code forces it for a change, at the step cap with reads pending, or for a tool outside the recipe),
  shown as a progress card. Code adds the closing show: an approval card for a proposal, up to four "Show me" chips
  for cited records, or a choice when a name is ambiguous.
- **Wake.** As decided in 7.1 (icon, single right-click menu, double right-click to listen), with Ctrl or Cmd J for the
  keyboard. Holding Ctrl+Alt to talk (4.1) was not built; the double right-click replaced it.
- **Voice out.** The chain of 7.5 is built: Chatterbox Nano on WebGPU with `shader-f16`
  (`owensong/chatterbox-nano-ONNX` at a pinned revision, 395,879,052 bytes, the speech encoder's 177 MB skipped),
  then Aura-2 through a new hosted route (`POST /api/_hosted/speak`, a 500-neuron share taken from the agent's, so
  Weft keeps half the account's neurons; RL_RUN), then the browser's speech synthesis with a voice the device
  provides. The voice is 7.6's: `scripts/assist/build-voice.ts` (`pnpm voice:build`) converts `conds.pt` into the
  1.3 MB `apps/web/public/assist/voice/weft-voice.bin` with no PyTorch, no model run and no clip. It reads conds.pt's
  stored tensors by byte length, takes the encoder's constant speaker row and the 375 speech-embedding rows from HTTP
  byte ranges of the pinned ONNX data files, checks every file against the repo's SHA256SUMS and every slice against
  its own sha256, and agrees with the official float32 weights within 1e-3. Its sources are in
  `weft-voice.provenance.json`. The graphs' input and output names were checked against the pinned files. A real run
  in headless Chrome on an Apple GPU (2026-10-24) created the three sessions and spoke each utterance until the stop
  token: a 97-character answer became 149 to 156 speech tokens and 6.0 to 6.3 s of audio, synthesized in 5 to 7 s,
  and the 396 MB download took about 15 s. Utterances are cut at 120 characters (about 1.5 tokens a character, inside
  the 256-token cap), and the next one is made while one plays. The
  hosted CSP adds `https://huggingface.co`, `https://*.hf.co` and `'wasm-unsafe-eval'` because the export ships that
  voice file; without it, nothing.
- **Tests.** Unit tests for every core (contracts, executor, grounding, agent, the client's pure modules), API tests
  for the route and every handoff case, the browser golden path `e2e/gp27-cursor-assistant.spec.ts` at 1440 by 900
  and 390 by 844 with faked speech recognition, and the hosted check `e2e/cf/cf-assist.spec.ts`. The eval tasks of
  4.6 are phase 3 and not written.

