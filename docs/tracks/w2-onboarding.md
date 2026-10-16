# Track w2-onboarding: offer builder, new-hire portal, e-signature, documents, nudge routine

Branch `track/w2-onboarding`, cut from main at `9b88e26` (wave 2 scaffold plus the real email simulator).

## What exists

| Area | Where | What it does |
|---|---|---|
| Offer lifecycle | `packages/core/src/portal/offers.ts`, `apps/api/src/routes/offers.ts` | `documents.create_offer` (R1, draft), `documents.send_offer` (R2, approval always), `documents.void_offer` (R2, approval always), `documents.expire_offers` (R1), `documents.view_offer` (human only, the persona). Every move is checked against `OFFER_TRANSITIONS`; an illegal one is refused with `DOMAIN_ILLEGAL_TRANSITION`. Each command writes its action row through the executor. `GET /v1/offers/:id` returns `W2OnboardingOfferDetail` (lifecycle columns, the persona id and the allowed next states); `GET /v1/offers` keeps the wave 1 `Offer` fields and adds the same lifecycle fields |
| Send | `documents.send_offer` | Writes the offer letter and the confidentiality agreement (`documents`, status sent, body from templates over DB values, sha256 of the body), reserves the worker id, creates the persona principal, sets `sent_at` and `document_id`, emails an `offer_invite` through `sims.email` with the link `/portal?as=<usr_id>`, emits `offer.sent` |
| New hire persona | `packages/core/src/portal/persona.ts`, `apps/api/src/http/auth.ts` | A human principal with role `employee`, `worker_id` set to the reserved worker id, grants `people: view` and `benefits: view` only. `auth.ts` refuses every path outside `/v1/portal/*` for it with 403 `PORTAL_ONLY`. Every portal command also checks that the caller is the persona of the record it touches (`DOMAIN_NOT_NEW_HIRE` otherwise). Voiding or expiring the offer sets its grants to none |
| Portal API | `apps/api/src/routes/portal.ts`, `packages/core/src/portal/view.ts`, `packages/core/src/portal/forms.ts` | `GET /v1/portal/me` returns `W2OnboardingPortalView` (the frozen `PortalView` plus the signable documents with body and sha256, the state form, the seeded plans, the masked bank and upload). `POST /v1/portal/offer/view` marks the offer viewed (or expired past `expires_on`). Sign, W-4, state certificate, direct deposit, I-9 and benefits each run a human-only `documents.*` command |
| Click-to-sign | `documents.sign` | The typed legal name plus the sha256 the client saw. The server recomputes the hash of the stored body and refuses `STALE_SUBJECT` on any mismatch. Writes a `signatures` row (signer principal, signer name, typed name, sim time, sha256, action seq) and the action row (actor is the persona, `ts` is the sim time, args carry the hash, the summary names signer, time and hash). Signing the offer letter accepts the offer: the worker row is created as onboarding with the reserved id, the pay rate, the portal tasks and the agent tasks, and `offer.accepted` starts the wave 1 `rt_new_hire` routine. The confidentiality agreement can be signed only after the offer |
| Checklist | `completePortalTask` in `forms.ts` | Canonical order `PORTAL_TASK_ORDER`; `state_withholding` only when `STATE_WITHHOLDING_FORMS[state]` is not null (CA DE 4, NY IT-2104, CO DR 0004, none for TX). Every completed task marks its `onboarding_tasks` row done and emits `onboarding.task_completed`. When every employee-owned task is done the worker turns active and `worker.onboarding_completed` is emitted. Agent-owned tasks (it_accounts, device, state_registration) stay with `rt_new_hire` and do not gate activation |
| W-4 and state form | `documents.submit_w4`, `documents.submit_state_withholding` | The W-4 upserts `tax_profiles` (`w4_version` 2020, source `portal`); the state form writes `state_filing_status` and `state_allowances` (W-4 first). Both write a signed form record in `documents`, a signature and an `onboarding_submissions` row |
| Direct deposit | route plus `documents.submit_direct_deposit`, `packages/sim/src/bank-verify.ts` | The route validates `DirectDepositSubmission` (ABA checksum through zod) and answers 422 `INVALID_INPUT` with `field: "routing"` inline. Valid numbers go to the vault (`vault:bank-wrk-NNNN`); the command gets only the last 4 digits and the vault reference, resolves the numbers in memory, calls `sims.bankVerify.verify` and writes an active `bank_accounts` row with last 4 digits and the reference. No table holds the full account number (the GP7 scenario scans actions, submissions, documents, bank rows, events, sim rows and signatures) |
| Bank verification simulator | `packages/sim/src/bank-verify.ts` | Deterministic: a routing number failing the checksum fails ("routing number not found"), an account ending 0000 fails ("account closed"), everything else verifies. Stores last 4 digits only in `sim_bank_verifications`. Fault target `bankVerify.verify` |
| I-9 | route plus `documents.submit_i9` | Multipart through Hono `parseBody`: PNG, JPEG, WebP or PDF up to 5 MB, stored as `<dataDir>/uploads/<sha256>.bin` (mode 0600), one `uploads` row. Responses only ever carry `MaskedUpload` (name `ab***.ext`, hash prefix, size). A refused submission removes a freshly written file |
| Benefits | `documents.submit_benefits` | One plan per type from the seeded plans; medical, dental and vision need a tier (employee cents from the plan price), the 401(k) needs a deferral inside the plan's match range, HSA is left to HR. Writes active `benefit_enrollments` from the start date, so the payroll engine adds them as pre-tax deductions |
| Documents | `packages/core/src/documents/**`, `apps/api/src/routes/documents.ts`, `documents.list`, `documents.get` | `GET /v1/workers/:id/documents?status`, `GET /v1/documents/:id` (with body and signature record), `GET /v1/sim/email?to` |
| Nudge routine | `packages/routines/src/wave2/onboarding.ts`, `documents.list_stragglers` | `rt_onboarding_nudge`, cron `0 10 * * 1-5` PT, three tools, checklist `posted:#new-hires`, ships disabled. The `onboarding_nudge` precheck skips when no hire has an overdue employee-owned task or every overdue hire was already named in #new-hires today, and derives one nudge per hire (no numbers, so comms grounding passes) |
| Web | `apps/web/src/components/app/hiring/hiring-view.tsx`, `apps/web/src/components/portal/portal-view.tsx`, `apps/web/src/components/app/documents/document-library.tsx` | Hiring: draft form, offers list with Send and Void, the email simulator outbox with the portal link. Portal at `/portal` outside the admin shell: welcome, `done of total` counter and bar, the checklist with one panel per task. Person view Documents tab: Signed, Sent and Pending tabs, document text and signature record on click |
| Test ids | `packages/contracts/src/w2/testids-onboarding.ts` | `W2_ONBOARDING_TID`; the file also re-exports `packages/contracts/src/ext/w2-onboarding.ts` because the frozen index exports it |

## How to run it

```
pnpm test                                       # includes the GP6, GP7 and GP8 scenarios
pnpm --filter @weft/tests exec vitest run scenarios/gp6-offer-portal.test.ts scenarios/gp7-new-hire-checklist.test.ts scenarios/gp8-straggler-nudge.test.ts
WEFT_E2E_WEB_PORT=4301 WEFT_E2E_API_PORT=4302 npx playwright test e2e/gp6-offer-portal.spec.ts e2e/gp7-new-hire-checklist.spec.ts
```

Demo by hand: `pnpm dev`, open `/app/hiring` as Dana, save a draft, press Send, follow "Open the new-hire portal" in the outbox. Test routing numbers: `021000021` and `011000015` pass the checksum; `021000022` fails it; an account ending `0000` is refused by the bank simulator.

## Decisions

- **Command names live in `documents.*`.** The frozen wave 1 test `apps/api/test/offers.test.ts` parses every `onboarding.*` command with an all-null sample and needs a sample entry for each required field; that file belongs to t2-world. Offer letters, e-signature and the onboarding forms are all `DocumentKind`s, so the `documents` namespace (owned here) holds them. The integrator can rename them to `onboarding.*` after adding samples (contract request below).
- **The worker id is reserved at send.** The persona's `worker_id` and the documents' `worker_id` point at it before the worker row exists, so the portal and the library work from the first click and the worker keeps the same id after acceptance.
- **Expiry is lazy plus a command.** There is no system principal allowlist entry for this track, so `documents.view_offer` and the sign route expire an offer past `expires_on` when the new hire opens it, and `documents.expire_offers` sweeps all of them for a person or the agent.
- **Seed step stays a no-op.** Personas and documents are created by sending an offer, so no wave 1 count changes and Noor's seeded GP3 offer is untouched. The Hiring list shows Noor's sent offer; it has no persona because it was never sent through the new flow.

## Contract changes

- `contract:` commit `98c91b7`: `parseEventBody` in `packages/contracts/src/events.ts` also accepts `Wave2EventBody`. Without it `emitEvent` rejected `offer.sent`, `offer.viewed`, `document.signed`, `onboarding.task_completed` and the other tracks' wave 2 events. The frozen `EventBody` union is unchanged. w2-offboarding and w2-benefits-contractors need the same change; if they made it too, keep one copy.
- Additive: `packages/contracts/src/ext/w2-onboarding.ts` (`W2OnboardingOfferDetail`, `W2OnboardingSignable`, `W2OnboardingPortalView`).

## What is stubbed or left

Also in `.scratch/w2-onboarding/left.md` (gitignored) and `.scratch/contract-requests/w2-onboarding.md`.

Everything in the acceptance list landed (GP6, GP7, GP8 scenarios; e2e gp6 and gp7). Left for later:

1. **Viewing as switcher.** The persona signs in through the portal link (`/portal?as=usr_NNNN`), which the portal keeps in its own local storage key. Adding personas to the shell's "Viewing as" control needs `apps/web/src/lib/api/hooks.ts` and `apps/web/src/components/app/shell/header.tsx` (t5-app and w2-reliability own them): list principals with role `employee` and route them to `/portal` instead of the admin shell.
2. **Command names.** The new commands are `documents.*` because `apps/api/test/offers.test.ts` (t2-world) needs a sample for every required field of every `onboarding.*` command. To move them to `onboarding.*`, add samples for them to that test.
3. **Expiry on the clock.** `documents.expire_offers` is not on a system principal allowlist (`packages/executor/src/system.ts`), so nothing expires offers on a timer; the portal expires an offer when the new hire opens it, and a person or the agent can run the sweep. Adding `documents.expire_offers` to `svc_scheduler` plus a scheduler hook would make it automatic.
4. **Nudge script for the default scripted provider.** `rt_onboarding_nudge` ships disabled. The GP8 scenario writes its script into a temp `WEFT_SCRIPTS_DIR`; enabling it in the demo needs `scenarios/rt_onboarding_nudge.json` (one `comms__send_message` call per derived nudge), which is outside this track's paths. With more than one straggler the scripted script posts only the first nudge; a live model follows the instructions and posts each.
5. **Persona of the seeded offer.** Noor's seeded offer (`offr_0001`, GP3) has no persona or documents, so it cannot be opened in the portal; the seed step stays a no-op to keep wave 1 counts and GP3 untouched.
6. **HSA in the portal.** HSA elections need an amount; the portal refuses them with `DOMAIN_HSA_WITH_HR`.
7. **Double completion event.** When `rt_new_hire` later completes the agent tasks, wave 1 `onboarding.complete_task` emits `worker.onboarding_completed` a second time (it fires when every task is done). Nothing consumes the event yet.
8. **State extra withholding.** `StateWithholdingSubmission.extraCents` is recorded in the submission and the signed form, but `tax_profiles` has no column for it and the payroll engine does not read it.
