# Track w3-integrations-screening-esign: Checkr, HireRight and DocuSign

Branch `track/w3-integrations-screening-esign`, cut from main at `35b385f` (wave 3 plan and scaffold). Rounds 1 and 2
are done. Everything runs on the simulators; no vendor was called, no account was created and no credential was entered.

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
| Web | `apps/web/src/components/app/screening/offer-screening.tsx`, `hiring-view.tsx`, `apps/web/src/components/portal/screening/section.tsx` | Hiring: each accepted offer shows its check (status badge, the screening company by name, a Simulated badge that reads "Simulated, API shape not published" for HireRight, package, price, ETA) with Order and the person-only steps. Portal: the order status and, while simulated, the labeled "Screening company apply page (simulated)" (disclosure, summary of rights, typed authorization) |
| Embedded signing | `apps/web/src/components/portal/screening/esign.tsx`, `portal-view.tsx`, `POST /v1/portal/esign/finish` | Only with `WEFT_ESIGN=docusign`. The portal's sign button posts the built-in signature exactly as before; when it is refused with `DOMAIN_ESIGN_ENVELOPE` it asks `POST /v1/portal/esign/url` for a fresh one-time link and sends the whole page there (never a frame). With the simulator that link is the "E-signature provider signing page (simulated)" (`/portal?esign=...&return=...`) with Sign both documents and Decline. Finish is checked against the signer's own envelope, the simulator records it, and its signed Connect message is verified, deduped and applied before the response, so the redirect back (`esign_return=1`, same-site portal paths only) already shows the offer accepted or declined |
| Routine | `packages/routines/src/wave3/screening.ts` | `rt_screening_follow_up` (disabled, event `offer.accepted`, 4 tools, approve autonomy): the `screening_follow_up` precheck reads `screening.get_status` and `screening.list_packages`, skips when the offer already has an open check, when the event has no offer, or when no package exists, and derives one `screening.order` call; the model proposes it as R4 at the catalog price. Checklist `proposal_exists:screening.order:{offer_id}`. The precheck is registered; the routine joins `PREBUILT` at the wave 3 merge (the engine test that pins the routine ids is owned elsewhere), and its script ships as `scenarios/rt_screening_follow_up.json` then (the test pins it today) |
| Dispute extension | `finalNotAllowedBefore`, `disputesSince`, `addBusinessDaysPt` in `screening/orders.ts` | The final adverse step waits 7 days from pre-adverse plus 5 business days for each time the order entered `disputed` since then (California's extension, applied everywhere like the other strictest-rule choices), counted from the order's `screening.status_changed` events. While disputed it is refused with `DOMAIN_SCREENING_TIMER_PAUSED` |

## Tests

| Test | Covers |
|---|---|
| `packages/sim/test/vendors/checkr.test.ts` | Hex HMAC vector on raw bytes (re-serialized and padded bodies fail), the state machine and timers, outbox retries, consider with record text only in `listAdverseItems`, pre-adverse and the scheduled post notice, expire, suspended, dispute, cancel, missing state |
| `packages/sim/test/vendors/hireright.test.ts` | Label, state machine, signed normalized events |
| `packages/sim/test/vendors/docusign.test.ts` | Base64 Connect vector (any `-N` header, re-serialized and CRLF bodies fail), JSON SIM parser, envelope send, signing link rules, completion, decline, void, fault |
| `apps/api/test/screening.test.ts` | Real adapters on a fake fetch: Checkr signature, request shapes and production refusal; HireRight refusal; DocuSign JWT verified with the public key, envelope body, token reuse and the 15 minute guard; routes for the catalog, ceilings, the pre-acceptance refusal, step validation and the built-in path's missing envelope |
| `tests/scenarios/gp18-screening.test.ts` | GP18 screening half: refused before acceptance; agent call is an R4 proposal at the DB price (changed in the test to prove the source); approval places the order; consent on the simulated apply page; clear through the signed webhook completes `background_check`; redelivery is a duplicate and a re-serialized body is rejected; consider opens the human-only review, blocked task, no record text in any agent result or run step, every human-only command refused for the agent and absent from tool specs; pre-adverse, waiting period, final step; registry check |
| `e2e/gp18-screening.spec.ts` | Browser: the accepted offer's Order button in Hiring (Invited, Simulated, 3,500 cents), the labeled apply page in the portal (disclosure, rights, typed authorization), clock advanced one business day, Hiring reads Clear. Passed with GP6 and GP7 on ports 4670 and 4671 |
| `tests/scenarios/gp18-envelope.test.ts` | GP18 envelope half with `WEFT_ESIGN=docusign`: one envelope with both documents, built-in signing refused, fresh link, completion accepts once with evidence (idempotent re-apply), decline sets `declined`, polls never under 20 minutes apart, void voids the envelope; the simulated signing page's finish route (only the envelope's signer, known outcomes only, accepted before the response, a second finish refused, decline) |
| `tests/scenarios/gp18-follow-up.test.ts` | `rt_screening_follow_up`: ships disabled with no human-only tool; on `offer.accepted` the scripted model proposes `screening.order` as R4 at the catalog price and nothing is ordered until Vic approves; the run waits for approval and finishes once approved; the precheck skips an offer with an open order and an event without an offer |
| `tests/scenarios/gp18-dispute.test.ts` | Business-day math; a CA hire's consider result, pre-adverse, the candidate's dispute pauses the final step, the dispute finishes after 5 business days, the final step stays refused until 7 days plus 5 business days, then succeeds; the offer is never ended automatically |
| `e2e/gp18-screening.spec.ts`, second test | Under `WEFT_ESIGN=docusign` only: the portal's sign button redirects the full page to the simulated signing page, Sign completes the envelope, and the portal comes back with both signing tasks done and the offer accepted. It skips under built-in signing, and the first test skips under `WEFT_ESIGN=docusign` |

```
pnpm --filter @weft/sim exec vitest run test/vendors
pnpm --filter @weft/api exec vitest run test/screening.test.ts
pnpm --filter @weft/tests exec vitest run scenarios/gp18
# e2e: built-in signing (GP6, GP7 unchanged; GP18 screening), then the envelope path
WEFT_E2E_DATA_DIR=.data-e2e-w3se WEFT_E2E_WEB_PORT=4720 WEFT_E2E_API_PORT=4721 npx playwright test e2e/gp6-offer-portal.spec.ts e2e/gp7-new-hire-checklist.spec.ts e2e/gp18-screening.spec.ts
WEFT_ESIGN=docusign WEFT_E2E_DATA_DIR=.data-e2e-w3se WEFT_E2E_WEB_PORT=4720 WEFT_E2E_API_PORT=4721 npx playwright test e2e/gp18-screening.spec.ts
```

To try it by hand: `WEFT_ESIGN=docusign` (optional) and `WEFT_SCREENING=hireright` (optional) in the API's environment,
then Hiring, an accepted offer, Order background check; the new hire's portal shows the simulated apply page; advance the
sim clock one business day. Faults `checkr.consider`, `checkr.suspended`, `checkr.dispute`, `checkr.expire` and
`esign.send` arm through the `sim_faults` table, as the GP18 scenarios do.

Round 2 results on this branch: `pnpm test` 665 passed (128 files), `pnpm typecheck` 16 of 16, `lint:prose`, `lint:brand`
and `brand:overlap` ok, `pnpm build` ok, `pnpm demo` GP1 to GP12 ok with the audit chain verified. e2e on 4720 and 4721:
GP6, GP7 and GP18 (screening) passed under built-in signing; GP18 (envelope) passed under `WEFT_ESIGN=docusign`.

## Real versus simulated

| Vendor | Simulated (default) | Real adapter | What turns the real one on |
|---|---|---|---|
| Checkr | Full simulator in Checkr's field names, enums, webhook signature and retry schedule; labeled Sandbox in Hiring and the portal | Written to the published API; staging by default; tested only against a fake fetch; never run live | `CHECKR_API_KEY` and the webhook key in `~/Developer/projects/.weft.secrets.env` (read through `WEFT_SECRETS_FILE`), and for production also `CHECKR_ENV=production` with `WEFT_LIVE_CHECKR=1`. Staging requests are free, but a staging account needs a credentialed production account or partner approval first (research/wave3/integrations-screening-esign.md), so there is no practical free path today |
| HireRight | The same engine with Weft's own event shape, labeled "Simulated, API shape not published" | Always refuses `INTEGRATION_NOT_AVAILABLE`: the API is partner-only and its shapes are not public | Nothing today; a partner agreement would come first |
| DocuSign | Envelopes, embedded signer, recipient view, void, download, Connect JSON SIM messages with the base64 HMAC; the signing page is the portal's simulated page | RS256 JWT grant, one envelope per offer, recipient view, void, download, Connect HMAC, a 15 minute per-envelope status guard; never run live | `WEFT_ESIGN=docusign` selects envelopes at all; the real adapter also needs `WEFT_LIVE_DOCUSIGN=1` and the integration key, user id, account and RSA key in the secrets file. DocuSign's free developer account (demo environment, not legally binding) is the one free path; Nitish opens it himself |

Without `WEFT_ESIGN=docusign` the built-in click-to-sign path is untouched, which is what GP6 and GP7 run.

## Observations

- A scheduler tick that runs while the app's own background routine and agent runs are writing can fail its
  `integrations.poll` step with `SQLITE_BUSY` (seen in a scenario that jumped the sim clock a week with routines on).
  The step is idempotent and the next tick retries it, so nothing is lost, but the dispute scenario turns routines off
  and runs its ticks on the app's tick chain to stay deterministic. This is the same family as the known w2-reliability
  item about draining background runs on close.

## Contract changes and requests

- Commit `contract: two portal screening route rows` adds `GET /v1/portal/screening` and `POST /v1/portal/screening/consent` (ui_only) to the screening route file in `packages/contracts/src/api.ts`. Additive; no row changed.
- Commit `contract: portal route row for the simulated signing page's finish step` (round 2) adds `POST /v1/portal/esign/finish` (ui_only, `{ envelopeId, outcome: 'signed' | 'declined' }`, simulated signing page only). Additive; no row changed.
- Merge request (routines owner): spread `RT_SCREENING_FOLLOW_UP` into `routines` in `packages/routines/src/wave3/screening.ts` and add `rt_screening_follow_up` to the ids pinned in `packages/routines/test/engine.test.ts`; add `scenarios/rt_screening_follow_up.json` with the script pinned in `tests/scenarios/gp18-follow-up.test.ts`.
- New ext file `packages/contracts/src/ext/w3-integrations-screening-esign.ts` (DTOs, apply inputs, refusal codes, poll constants, simulator controls). Request: re-export it from the w3 testids barrel so callers stop importing it by relative path.
- Request (w3-integrations-hr): the generic `POST /v1/integrations/:vendor/webhook` should call the same steps as `ingestVendorDelivery` (or `ingestVendorDelivery` itself) for checkr, hireright and docusign; the apply inputs are `W3ScreeningApplyInput` and `W3EsignApplyInput`.
- Request (t3-governance): `svc_scheduler` is not on the allowlist for `screening.apply_vendor_event` or `documents.apply_esign_event`, so the poll fallback runs them as `svc_events`. Either add them to `svc_scheduler` or confirm `svc_events` for polls.
- Request (inbox owner): list `screening_orders` with `status = complete_review` and adjudication none or pre_adverse as a human-only Inbox card linking to Hiring. Today the review shows in Hiring and as the blocked checklist task.
- Request (people view owner): a label for the `background_check` task kind ("Background check") in `people-view.tsx`.

## Left

Also in `.scratch/w3-integrations-screening-esign/left.md`.

- `documents.resend_envelope` (R3, planned) is not built; today a voided or expired envelope means a new offer.
- `rt_screening_follow_up` joins `PREBUILT` and gets its repo script at the wave 3 merge (see the merge request above).
  Its consent nudge (remind a hire whose invitation is still pending after a few days) is not built.
- No UI switch for the screening company: `WEFT_SCREENING=hireright` selects HireRight and Hiring now names it, but the
  choice lives in the environment, not in Settings.
- The Integrations screen cards for checkr, hireright and docusign come from w3-integrations-hr; the "Simulated, API
  shape not published" label should show on the HireRight card there too.
- Inbox card for `complete_review` orders (inbox owner) and a `background_check` label in `people-view.tsx` (people
  owner), both requested above.
- The envelope e2e needs its own Playwright run with `WEFT_ESIGN=docusign`; `pnpm e2e` runs only the built-in path.
