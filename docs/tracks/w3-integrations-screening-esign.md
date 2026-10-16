# Track w3-integrations-screening-esign: Checkr, HireRight and DocuSign

Branch `track/w3-integrations-screening-esign`, cut from main at `35b385f` (wave 3 plan and scaffold). Round 1 of 2.
Everything runs on the simulators; no vendor was called, no account was created and no credential was entered.

## What exists

| Area | Where | What it does |
|---|---|---|
| Checkr simulator | `packages/sim/src/vendors/checkr.ts` | Candidates, invitations, reports and adverse actions in Checkr's field names and enums, stored in `sim_vendor_records`. Invitation pending until the candidate consents on the simulated apply page, valid 7 days (to 11:59:59 pm PDT); consent creates the report, which completes after 1 business day on the sim clock. Faults `checkr.consider` (one synthetic, obviously fictional item marked `SIMULATED RECORD (fictional)`), `checkr.suspended`, `checkr.dispute` (pauses pre-adverse 5 business days, then extends the notice), `checkr.expire`. Every state change queues a webhook in `sim_webhook_outbox` signed like Checkr's (hex HMAC-SHA256 over the compact body, `X-Checkr-Signature`) with the sim key `weft-sim-checkr-webhook-key-not-a-secret`; retries every minute for 10 minutes, then hourly. Record text is reachable only through `listAdverseItems` |
| HireRight simulator | `packages/sim/src/vendors/hireright.ts` | Same engine, Weft's own normalized event shape, labeled `Simulated, API shape not published` in `status().detail` and in every event body |
| DocuSign simulator | `packages/sim/src/vendors/docusign.ts` | Envelopes in the eSignature v2.1 shape (documents, one embedded signer with `clientUserId`, `customFields` with the offer id), the recipient view (5 minute link to the portal), status reads recorded per envelope, void (reason cut to 200 characters), download, and Connect JSON SIM messages signed in base64 (`X-DocuSign-Signature-1`). Dedupe key `sha256(envelopeId + event + generatedDateTime)`. Fault `esign.send` |
| Simulator controls | `packages/contracts/src/ext/w3-integrations-screening-esign.ts` | `w3ScreeningSimControls(conn)` and `w3EsignSimControls(conn)` expose the vendor's side (consent, timers, outbox, ack, finish, reads) on simulated connectors only; real adapters have none |
| Real Checkr adapter | `packages/integrations/src/real/checkr.ts` | Written to the published shapes: Basic auth with `CHECKR_API_KEY`, `Idempotency-Key` on POST, hosted invitations (Weft never collects SSN or date of birth), `X-Checkr-Signature` check with constant-time compare. Staging by default; production (`CHECKR_ENV=production`) refused with `INTEGRATION_LIVE_DISABLED` unless `WEFT_LIVE_CHECKR=1`. Never run live; tested only against a fake fetch |
| Real HireRight adapter | `packages/integrations/src/real/hireright.ts` | Every call refuses `INTEGRATION_NOT_AVAILABLE`; `status().health` is `not_available` |
| Real DocuSign adapter | `packages/integrations/src/real/docusign.ts` | RS256 JWT grant through `node:crypto` (iss, sub, aud, iat, exp, scope `signature impersonation`), token reused until 15 minutes before expiry, base URI from `/oauth/userinfo`, one envelope with both documents and anchor `signHere` tabs, recipient view, void, download, base64 Connect HMAC, and a 15 minute per-envelope status guard (`INTEGRATION_RATE_GUARD`). Every call refused unless `WEFT_ESIGN=docusign` and `WEFT_LIVE_DOCUSIGN=1`; never run live |
| Commands | `packages/core/src/commands/screening.ts`, `packages/core/src/screening/orders.ts`, `packages/core/src/esign/envelopes.ts` | `screening.list_packages`, `screening.get_status`, `documents.get_envelope` (R0; status, result, adjudication, ETA and timestamps only). `screening.order` (R4, approval always, `amountCents` from `screening_packages`, ceiling `agent.screening_cents`, refused before acceptance with `DOMAIN_SCREENING_BEFORE_OFFER`, `DOMAIN_SCREENING_EXISTS` for a second open order; NYC hires must use the non-criminal package). `screening.cancel` (R3, approval always). Human only: `screening.review` (audited, untrusted `items[].text`), `screening.engage`, `screening.start_pre_adverse` (post notice 7 days out), `screening.send_final_adverse` (refused before the waiting period with `DOMAIN_SCREENING_WAITING_PERIOD`, and while disputed with `DOMAIN_SCREENING_TIMER_PAUSED`; never ends the offer), `screening.cancel_adverse`, `screening.proceed_to_criminal`. System only: `screening.apply_vendor_event`, `documents.apply_esign_event` (re-read by id, never a body) |
| background_check task | `ensureBackgroundTask` and `syncBackgroundTask` in `screening/orders.ts`; `onboarding/writes.ts` | Created (owner agent) when an order is placed, so the built-in GP6 and GP7 checklists are unchanged. Done on a clear result (the criminal phase for NYC) or a person's engage; blocked with a structured reason otherwise ("Waiting on a person: review required" and so on). `onboarding.complete_task` refuses it with `DOMAIN_SYSTEM_TASK`. It never gates activation or the first payroll |
| Webhook path and polling | `apps/api/src/integrations/poll-screening.ts` | On the scheduler's `integrations.poll` step: the simulators run their timers; their due deliveries go through `ingestVendorDelivery` (verify the HMAC over the raw bytes, insert `integration_deliveries` with ids and the body sha256 only, dedupe on `(vendor, dedupe_key)`, apply through `VENDOR_APPLY_COMMAND` as `svc_events`); then the poll fallback re-reads open orders not heard from in 30 minutes and open envelopes not read in 20 |
| Envelope on send and void | `packages/core/src/portal/offers.ts`, `packages/core/src/portal/forms.ts` | Only with `WEFT_ESIGN=docusign`: `documents.send_offer` also sends one envelope (the built-in path is the fallback when the send fails), void and expiry void it. `documents.sign` refuses an enveloped offer with `DOMAIN_ESIGN_ENVELOPE`. A completed envelope accepts the offer once through `acceptFromEnvelope` (the same acceptance as the built-in signature, then one signature per document with `signature_evidence`); delivered marks the offer viewed; declined sets the new `declined` state, voids the open documents and revokes the persona |
| Routes | `apps/api/src/routes/screening.ts` | `GET /v1/screening/packages`, `GET /v1/screening/orders`, `GET /v1/screening/orders/:id` (`?detail=items` runs `screening.review` for a signed-in person), `POST /v1/offers/:id/screening`, `POST /v1/screening/orders/:id/adjudicate`, `GET /v1/offers/:id/envelope`, `POST /v1/portal/esign/url`, plus the two new rows `GET /v1/portal/screening` and `POST /v1/portal/screening/consent` |
| Seed | `packages/seed/src/w3-screening-esign.ts` | The package catalog cached from the simulators (Checkr four packages, HireRight one, synthetic prices) and `agent.screening_cents` 10,000 and `agent.screening_day_cents` 30,000 |
| Web | `apps/web/src/components/app/screening/offer-screening.tsx`, `hiring-view.tsx`, `apps/web/src/components/portal/screening/section.tsx` | Hiring: each accepted offer shows its check (status badge, Simulated badge, package, price, ETA) with Order and the person-only steps. Portal: the order status and, while simulated, the labeled "Screening company apply page (simulated)" (disclosure, summary of rights, typed authorization) |

## Tests

| Test | Covers |
|---|---|
| `packages/sim/test/vendors/checkr.test.ts` | Hex HMAC vector on raw bytes (re-serialized and padded bodies fail), the state machine and timers, outbox retries, consider with record text only in `listAdverseItems`, pre-adverse and the scheduled post notice, expire, suspended, dispute, cancel, missing state |
| `packages/sim/test/vendors/hireright.test.ts` | Label, state machine, signed normalized events |
| `packages/sim/test/vendors/docusign.test.ts` | Base64 Connect vector (any `-N` header, re-serialized and CRLF bodies fail), JSON SIM parser, envelope send, signing link rules, completion, decline, void, fault |
| `apps/api/test/screening.test.ts` | Real adapters on a fake fetch: Checkr signature, request shapes and production refusal; HireRight refusal; DocuSign JWT verified with the public key, envelope body, token reuse and the 15 minute guard; routes for the catalog, ceilings, the pre-acceptance refusal, step validation and the built-in path's missing envelope |
| `tests/scenarios/gp18-screening.test.ts` | GP18 screening half: refused before acceptance; agent call is an R4 proposal at the DB price (changed in the test to prove the source); approval places the order; consent on the simulated apply page; clear through the signed webhook completes `background_check`; redelivery is a duplicate and a re-serialized body is rejected; consider opens the human-only review, blocked task, no record text in any agent result or run step, every human-only command refused for the agent and absent from tool specs; pre-adverse, waiting period, final step; registry check |
| `e2e/gp18-screening.spec.ts` | Browser: the accepted offer's Order button in Hiring (Invited, Simulated, 3,500 cents), the labeled apply page in the portal (disclosure, rights, typed authorization), clock advanced one business day, Hiring reads Clear. Passed with GP6 and GP7 on ports 4670 and 4671 |
| `tests/scenarios/gp18-envelope.test.ts` | GP18 envelope half with `WEFT_ESIGN=docusign`: one envelope with both documents, built-in signing refused, fresh link, completion accepts once with evidence (idempotent re-apply), decline sets `declined`, polls never under 20 minutes apart, void voids the envelope |

```
pnpm --filter @weft/sim exec vitest run test/vendors
pnpm --filter @weft/api exec vitest run test/screening.test.ts
pnpm --filter @weft/tests exec vitest run scenarios/gp18-screening.test.ts scenarios/gp18-envelope.test.ts
WEFT_E2E_WEB_PORT=4670 WEFT_E2E_API_PORT=4671 npx playwright test e2e/gp6-offer-portal.spec.ts e2e/gp7-new-hire-checklist.spec.ts e2e/gp18-screening.spec.ts
```

Round 1 results on this branch: `pnpm test` 658 passed (126 files), `pnpm typecheck` clean, `lint:prose`, `lint:brand` and
`brand:overlap` ok, e2e GP6, GP7 and GP18 passed. `pnpm build` and `pnpm demo` were not run in round 1.

## Contract changes and requests

- Commit `contract: two portal screening route rows` adds `GET /v1/portal/screening` and `POST /v1/portal/screening/consent` (ui_only) to the screening route file in `packages/contracts/src/api.ts`. Additive; no row changed.
- New ext file `packages/contracts/src/ext/w3-integrations-screening-esign.ts` (DTOs, apply inputs, refusal codes, poll constants, simulator controls). Request: re-export it from the w3 testids barrel so callers stop importing it by relative path.
- Request (w3-integrations-hr): the generic `POST /v1/integrations/:vendor/webhook` should call the same steps as `ingestVendorDelivery` (or `ingestVendorDelivery` itself) for checkr, hireright and docusign; the apply inputs are `W3ScreeningApplyInput` and `W3EsignApplyInput`.
- Request (t3-governance): `svc_scheduler` is not on the allowlist for `screening.apply_vendor_event` or `documents.apply_esign_event`, so the poll fallback runs them as `svc_events`. Either add them to `svc_scheduler` or confirm `svc_events` for polls.
- Request (inbox owner): list `screening_orders` with `status = complete_review` and adjudication none or pre_adverse as a human-only Inbox card linking to Hiring. Today the review shows in Hiring and as the blocked checklist task.
- Request (people view owner): a label for the `background_check` task kind ("Background check") in `people-view.tsx`.

## Left

See `.scratch/w3-integrations-screening-esign/left.md` (copied below).

- Portal embedded signing redirect in `portal-view.tsx`: when `POST /v1/portal/esign/url` answers, the sign button should redirect the full page there; plus the simulated signing page (`?esign=`) in the portal section with Sign and Decline, which needs one more route row for the simulator's finish step.
- `documents.resend_envelope` (R3, planned) is not built.
- `rt_screening_follow_up` routine (propose `screening.order` on `offer.accepted`, nudge consent) with a scripted scenario; GP18 drives the agent call through a routine run handle directly.
- HireRight in the Hiring UI: `WEFT_SCREENING=hireright` selects it, but there is no UI switch.
- CA dispute extension is modeled in the simulator (5 business days) but Weft's final-step gate uses 7 days from pre-adverse without adding the extension.
- The Integrations screen cards for checkr, hireright and docusign come from w3-integrations-hr; the "Simulated, API shape not published" label should show on the HireRight card.
