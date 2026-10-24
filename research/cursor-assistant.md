# A cursor assistant for Weft (research, 2026-10-24)

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
