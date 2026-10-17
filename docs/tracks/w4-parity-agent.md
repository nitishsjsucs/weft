# Track w4-parity-agent

Employee self-service questions in the portal (T9), tagging the agent in chat (Q6), email expense submission (S5) and
wait-and-resume routine steps (G6, R14). Branch `track/w4-parity-agent`. Round 1.

## What landed

### Portal questions (T9)

- `POST /v1/portal/agent/runs` (`apps/api/src/routes/agent-surfaces.ts`). Code classifies the topic first
  (`classifyPortalTopic` in `packages/core/src/agent-surfaces/portal.ts`).
- Human-only topics (medical leave, accommodation, workplace concern) never reach the model. The employee's own
  `portal.request_handoff` (human only, R1, additive to the planned table) opens an `hr_person` hand-off with a template
  summary (the question text stays out of the case), and the reply is a fixed line saying a person will follow up. No
  run, no proposal.
- Other questions run a chat with the portal reads only: `portal.my_profile`, `portal.my_paychecks`,
  `portal.my_time_off`, `portal.my_benefits`, `portal.policy_search`. All R0, strict inputs with no worker id; the worker
  is resolved from the principal. Tools on a domain the asker cannot view (memory.search for the persona) are left off
  the allowlist, so the model never spends a step on a refusal. Money is `amount_cents` plus `amount_display` and policy
  text is `text_display`, so answers pass the grounding check.
- The route waits for the answer (`WEFT_PORTAL_WAIT_MS`, 90 s) because the persona reaches only `/v1/portal/*`. The
  response adds `topic`, `status` and `answer` to the route table's `{ runId, threadId, handoffId }`
  (`packages/contracts/src/ext/w4-parity-agent.ts`).
- The portal recipe and pack in `packages/agent/src/prompts/portal.ts`: no company summary, no open loops, no recall.
  Wiring it into runtime.ts is a contract request.
- UI: the question box `apps/web/src/components/portal/w4-ask.tsx`, mounted below the portal sections.

### Mentions (Q6)

- `POST /v1/sim/chat/inbound` posts an inbound message; one that names `@weft` as a word is recorded through
  `agent.record_mention` (system only, svc_sim). A sender who is not a human of the company (or is a portal persona) is
  recorded as `ignored` and starts nothing.
- The answering run is opened on behalf of the person who tagged the agent, tainted before step 0
  (`chat:<message id>`) through the executor's `taintRun`, with read tools from the chat set plus `comms.post_update`.
  The thread's earlier messages are in the request, labeled untrusted.
- Code posts exactly one reply in the channel from the run's final answer (redacted), then marks the mention
  `answered` (or `refused`). `GET /v1/agent/mentions` lists them.

### Email intake (S5)

- `POST /v1/sim/email/inbound` resolves the receipt fixture (`packages/sim/src/email-inbound.ts`: generated demo PDFs
  whose extract stands in for OCR), writes it on the upload path, and runs `expenses.intake_email` as svc_sim.
- Accepted only from a worker's work address on file: one upload, one expense with `source = 'email'`, the policy
  checks, and `expense.submitted`, so the wave 3 review routine picks it up. The subject becomes the business purpose,
  untrusted as for a portal claim. Unknown senders and mail with no readable receipt bounce (a reply goes back only to
  `*.example` addresses). The message id is a hash of the content, so a second delivery is `duplicate`.
- `GET /v1/expense-intake` lists intake rows. Simulators panel: Post in a channel and Email a receipt
  (`apps/web/src/components/app/simulators/w4-inbound.tsx`).

### Wait and resume (G6, R14)

- `packages/routines/src/waits.ts` and the engine (`packages/routines/src/engine.ts`). A checklist item may declare a
  `wait` (`ChecklistItemW4`). The agent sees that item as handed to Weft, so a segment ends cleanly; at finalize the
  engine evaluates the real checklist (every segment's facts) and opens a `routine_waits` row for each wait item still
  open, parking the routine run in `waiting_event`.
- `tick()` resumes a wait once when its event arrives (compare and set on status, so a repeated event does nothing),
  follows up every `followUpEveryDays` with a new segment, and expires it after `timeoutDays` (the routine run fails
  with a "Check by hand" line). An `until` wait resumes at its time.
- The worked example `rt_laptop_hand_delivery` (disabled by default): an Austin office new hire, a request in
  #new-hires, a reminder every two days, a thank-you on `sim.device_delivered`, stop after 14 days.
  `GET /v1/routine-runs/:id/waits` lists a run's waits.

## Tests

`apps/api/test/agent-surfaces.test.ts` (15): the classifier; a question about another worker returns nothing about them
(tool results and answer checked for the other worker's id, name and pay); worker id arguments refused; a policy answer;
a human-only topic opens a hand-off with no run and no proposal; the portal pack; mention detection; a mention run is
tainted from step 0, refuses an injected submit, writes nothing and posts one reply; an outside sender is ignored;
intake files one expense per message and dedupes, and bounces unknown senders and missing receipts; a routine waits,
follows up, resumes once and expires. E2E: `e2e/gp20-portal-ask.spec.ts` (written, not yet run). Scenarios:
`portal_policy_meals`, `portal_other_worker`, `mention_draft_payroll_status`, `rt_laptop_hand_delivery`.

## Findings for the eval round

- `payroll.list_runs` returns `period` as one string, so quoting its end date is flagged UNGROUNDED.
- `comms.send_message` grounds every number in the text, so routine text derived in code must carry no dates or counts
  unless they are in its company facts.

Left for round 2 is in `.scratch/w4-parity-agent/left.md`; contract requests in `.scratch/contract-requests/w4-parity-agent.md`.
