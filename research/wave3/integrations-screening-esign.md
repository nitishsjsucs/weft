# Wave 3 integrations: background screening (Checkr, HireRight) and e-signature (DocuSign)

Research for the wave 3 architect and builders, written 2026-10-16. Scope: the vendor API surface Weft needs, whether a free sandbox exists and exactly how Nitish gets it, the terms that bind an open-source connector, the specs a simulator can follow, the compliance rules a screening flow must model, and a Weft design (one screening connector, one e-signature connector, webhooks, agent permissions). This is research, not legal advice; the compliance section states what the cited texts say so the simulator can model it, and a real deployment needs counsel.

Verification legend, used on every fact:

- **[C] checked**: I verified it directly this session (downloaded and parsed the file, made the HTTP request, read the code in this repo).
- **[V] vendor states**: I read it in the vendor's own docs or terms this session; it is the vendor's claim about its service and I could not test it.
- **[L] law or regulator**: I read it in the statute or the regulator's own page this session.
- **[3P] third party**: a secondary source (law firm, integrator help page, search summary); weaker.
- **[U] unverified**: inferred, or the source was unreadable; confirm before relying on it.

Source tags are listed with URLs in section 9.

---

## 0. Decisions in one screen

1. **DocuSign is the only one of the three Nitish can wire for free, today.** A free developer account gives a full eSignature REST API v2.1 in an isolated demo environment; signatures there are not legally binding [V DS-ACCOUNT]. Build the real DocuSign adapter (JWT grant, embedded signing, Connect HMAC) behind `WEFT_ESIGN=docusign`, live-guarded like the OpenAI provider.
2. **Checkr and HireRight get simulators only in wave 3, plus a Checkr adapter written against the published spec but never run live.** Checkr staging is free but "can only be created using a production account that has already been authenticated", and credentialing needs a legal business, EIN and articles of incorporation [V CK-API]; the partner route needs Business Development approval [V CK-PARTNERS]. HireRight publishes no public API docs or sandbox; access comes through a customer contract, a services modification and an assigned Technical Consultant [V HR-CONNECT] [3P HR-FOUNTAIN].
3. **One `ScreeningConnector` interface** (sim, checkr, hireright) with a normalized status model; **one `ESignConnector` interface** (builtin, docusign). The existing click-to-sign (`documents.sign`, sha256 plus typed name) stays the default and the fallback whenever DocuSign is not configured or fails [C `packages/core/src/portal/forms.ts`].
4. **Vendor-hosted consent only.** Real adapters use the vendor's hosted candidate flow (Checkr invitations; HireRight's applicant forms), so the CRA presents the FCRA disclosure, authorization and summary of rights. Weft never builds a self-hosted consent flow for a real CRA: Checkr says that path makes the customer responsible for all disclosure and consent forms and needs Partner Manager review [V CK-API] [V CK-PARTNERS]. The simulator renders its own clearly labeled "CRA apply page (simulated)" that walks the same steps so the demo shows them.
5. **One timing rule everywhere: no screening before the offer is accepted.** Weft's offer acceptance (signing the offer letter) is the conditional offer. This satisfies the strictest of Weft's four work locations (California, New York City, Austin, Colorado) with a single check [L CA-FCA-FS] [L NYC-FCA] [3P AUSTIN] [3P CO-C2C].
6. **Ordering a check is R4 (money commitment, regulated), always a human approval, never autoAllow**, with the package price computed from the DB catalog and a new ceiling. Adverse action is **human-only**: no pre-adverse, final adverse, engage or report-detail command is on any model surface (harness 5.4 already removes `access: "human_only"` commands from the model) [C research/harness.md 5.4].
7. **The agent never sees record content.** Screening reads return status, result (`clear` or `consider`), ETA and timestamps; adverse item text, charges and dispositions stay in a human-only view. Vendor webhook payloads are external provenance and taint the run [C research/harness.md 6.2].
8. **Webhooks land in one inbound route per vendor, verified by HMAC on the raw body, deduplicated, then applied by a system principal.** No agent run starts from a webhook directly. Because a local Weft has no public HTTPS URL, every flow also works by polling within the vendors' limits (DocuSign: at most one status GET per envelope per 15 minutes [V DS-LIMITS]).
9. **One DocuSign envelope per offer** carrying the offer letter and the confidentiality agreement, embedded signing from the new-hire portal, `envelope-completed` accepts the offer. Weft's `expires_on` maps to envelope `expirations.expireAfter`; `documents.void_offer` voids the envelope.
10. **No vendor spec files are committed.** DocuSign's OpenAPI repo is MIT [C DS-OPENAPI] and could be vendored, but builders should hand-write Zod schemas for the subset used and cite the spec; Checkr's spec is marked "License: Proprietary" [C CK-OPENAPI], so follow its shapes, never copy the file or its prose.

---

## 1. What Nitish must do himself

Nothing below may be done by an agent (no sign-ups, no terms acceptance, no credentials entered on any site).

| Vendor | Free path? | Steps for Nitish | What goes in `~/Developer/projects/.weft.secrets.env` |
|---|---|---|---|
| DocuSign | **Yes**: free developer account, demo environment, not legally binding [V DS-ACCOUNT] | 1. Go to developers.docusign.com, choose Developer Account, then Create Account (a personal email is allowed [V DS-ACCOUNT]). 2. Open Apps and Keys (`https://admindemo.docusign.com/authenticate?goTo=appsAndKeys` [C DS-PAGES]), add an app, copy its Integration Key, generate an RSA key pair (max 5 per app [V DS-JWT-TOKEN]) and save the private key as a file outside every repo, add redirect URI `http://localhost/` (consent only; the JWT flow ignores the returned code [V DS-JWT-TOKEN]). 3. Copy the "User ID" (API username GUID) and "API Account ID" from the same page. 4. Grant consent once by opening `https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<INTEGRATION_KEY>&redirect_uri=http://localhost/` and accepting [V DS-JWT-TOKEN]. 5. Optional, for webhooks: Admin, Connect, Connect Keys, Add Secret Key; copy it at once (shown only on creation) [V DS-HMAC-SETUP]. | `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_PRIVATE_KEY_FILE` (path to the PEM, not the PEM itself), optional `DOCUSIGN_CONNECT_HMAC_KEY`. Fixed defaults in code: OAuth host `account-d.docusign.com`, base URI from `/oauth/userinfo`. |
| Checkr | **Not realistically**: staging is free but only for an authenticated production account or an approved partner [V CK-API] [V CK-PARTNERS]; self-serve production is paid per report (Basic from $29.99 per a 2026-10-05 snapshot) [3P CK-PRICE] | Nothing required for wave 3. Only if he wants live later: (a) as a customer, credential a real business with Checkr (legal name tied to an EIN, state and articles of incorporation [V CK-API]), then request a staging account through the Help Center article the docs link, then create a Secret key under Account Settings, Developer Settings [V CK-API]; or (b) as a partner, apply at `https://checkr.com/become-a-partner`, then pass security review, compliance review and a roughly 30 minute demo with a Partner Manager before production [V CK-PARTNERS]. | Later only: `CHECKR_API_KEY`, `CHECKR_ENV=staging` (adapter refuses `production` unless `WEFT_LIVE_CHECKR=1`). Partner mode: `CHECKR_CLIENT_ID`, `CHECKR_CLIENT_SECRET`. |
| HireRight | **No**: no public sandbox found [3P HR-APIEVANGELIST] [3P HR-APITRACKER] | Nothing for wave 3. Live needs a HireRight customer contract, a "Modification of Services" adding the integration, and an assigned Technical Consultant (8 to 10 business days after request per one integrator) who supplies an API key and an integration settings guide [3P HR-FOUNTAIN]. | None. Reserve `HIRERIGHT_API_KEY` but ship no live adapter. |

Settings Nitish would also choose in the Weft UI (no external action): which screening package maps to which job level, and whether DocuSign or built-in signing is the default.

---

## 2. Checkr

### 2.1 Access and environments

- Hosts: production `https://api.checkr.com/v1`, staging `https://api.checkr-staging.com/v1` [V CK-API]; the OpenAPI `servers` block lists only production [C CK-OPENAPI].
- Credentialing comes first: "Before gaining a Checkr staging or production account, you must first work with a Checkr Account Executive or Customer Success representative to create and credential your account." It establishes permissible purpose (legal business name tied to an EIN, state of incorporation, articles of incorporation, EIN) and confirms a compliant candidate UI workflow [V CK-API].
- Staging: "Staging accounts can only be created using a production account that has already been authenticated"; requested through a Help Center article; the admin gets a temporary password by email; create a Secret key in Developer Settings; staging requests "are free and return fake data"; mocked candidates must be entered exactly as in Checkr's mock data document or the report "will remain in pending status indefinitely"; staging does not support post adverse action, invitations do not expire, no invoices or analytics [V CK-API].
- Production keys are not enabled for Reports until `clients@checkr.com` enables live requests [V CK-API].
- Self-serve paid tiers exist (Basic from $29.99, Essential $59.99, Complete $94.99 per report, plus pass-through court fees) [3P CK-PRICE].
- The reference product lists Checkr as a live integration for background checks during onboarding [C research/wave3/agent-parity.md section 6] [C research/product.md line 149].

### 2.2 Auth, limits, idempotency

- HTTP Basic with the secret key as username and an empty password [V CK-API]. Publishable keys only create Candidates from Checkr's JS [V CK-API].
- Rate limit "1200 requests per minute across all endpoints", HTTP 429 over it, headers `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`; backoff 2, 5, 10, 30 s suggested [V CK-API].
- `Idempotency-Key` header on POST; keys expire after 24 hours [V CK-API].
- Duplicate guards: no more than 3 reports per candidate and 2 duplicate candidates per 24 hours [V CK-API].

### 2.3 Resources Weft uses

| Call | Purpose in Weft | Key fields |
|---|---|---|
| `GET /v1/packages` | Populate the package picker; the price feeds `amountCents` | `slug`, `name`, `price`, `screenings[{type, subtype}]`, `apply_url` [V CK-API] |
| `POST /v1/candidates` | Create the subject. For the invitation flow only `email` is strictly required [V CK-API] | `first_name`, `last_name`, `email`, `work_locations[]`; Weft never sends SSN or DOB (the hosted flow collects them) |
| `POST /v1/invitations` | Order through the Checkr-Hosted Apply Flow | required `candidate_id`, `package`; `work_locations[{country, state, city}]` (state required for US; Checkr uses it "to apply the appropriate state- and city-based fair hiring laws, disclosures, and adverse action procedures"); `node` only on hierarchy accounts [V CK-API]. Response has `invitation_url`, `status`, `expires_at`, `report_id` [V CK-API] |
| `DELETE /v1/invitations/{id}` | Cancel an unconsented order | |
| `GET /v1/reports/{id}` | Poll fallback and re-fetch after any `report.*` event | `status`, `result`, `assessment`, `adjudication`, `completed_at`, `includes_canceled` [C CK-OPENAPI] |
| `GET /v1/reports/{id}/eta` | ETA chip on the checklist | (endpoint listed [V CK-API]) |
| `GET /v1/reports/{report_id}/adverse_items` | Human-only adverse action screen | only when report is `consider` and no active adverse action [V CK-API] |
| `POST /v1/reports/{report_id}/adverse_actions` | Human-only: start pre-adverse | required `adverse_item_ids[]`; `post_notice_scheduled_at` "Default is 7 days after creation"; `medium`; `context` [V CK-API] |
| `DELETE /v1/adverse_actions/{id}` | Human-only: cancel (candidate engaged after all) | |
| `GET /v1/account` | Connection check (`authorized: true`) | [V CK-PARTNERS] |
| Webhooks (Dashboard or `POST /v1/webhooks`) | Status push | see 2.5 |

- Invitations are valid 7 days with a reminder every 24 hours, and expire at 11:59:59 pm PDT [V CK-API]. Once completed, a Report is created automatically [V CK-API].
- Employment and education verifications and credit checks cannot be started with `/reports`; they need `/invitations` [V CK-API]. One more reason to use invitations only.

### 2.4 Status vocabularies (parsed from the published spec)

All [C CK-OPENAPI], parsed from the downloaded `openapi.yaml`:

- Report `status`: `pending`, `complete`, `suspended`, `dispute`, `canceled` ("`complete` if at least one screening was completed").
- Report `result`: `clear`, `consider` (nullable).
- Report `assessment` (Assess-enabled accounts only): `eligible`, `review`, `escalated` (nullable).
- Report `adjudication`: `engaged`, `pre_adverse_action`, `post_adverse_action` (nullable).
- Invitation `status`: `pending`, `completed`, `expired`.
- Adverse action `status`: `pending`, `complete`, `dispute`, `canceled`; object fields `post_notice_scheduled_at`, `post_notice_ready_at`, `canceled_at`, `adverse_items[{id, text, assessment}]`, `individualized_assessment_engaged`, `delivery{state, reason}`, `events[]` [V CK-API].
- Checkr states it "does not make this determination on the customer's behalf" for clear or consider reports [V CK-API].

### 2.5 Webhooks

- Event types [V CK-API]: `candidate.created`, `candidate.id_required`, `candidate.driver_abstract_required`, `candidate.driver_license_required`, `candidate.updated`, `candidate.pre_adverse_action`, `candidate.post_adverse_action`; `invitation.created`, `invitation.completed`, `invitation.expired`, `invitation.deleted`; `verification.created`, `verification.completed`, `verification.processed`; `report.created`, `report.updated`, `report.canceled`, `report.upgraded`, `report.completed`, `report.suspended`, `report.resumed`, `report.paused`, `report.disputed`, `report.dispute_completed`, `report.pre_adverse_action`, `report.post_adverse_action`, `report.engaged`; `adverse_action.created`, `adverse_action.completed`, `adverse_action.paused`, `adverse_action.resumed`, `adverse_action.canceled`, `adverse_action.notice_not_delivered`; `package.created`, `package.updated`, `package.deleted`. Partner apps also get `account.credentialed` and `token.deauthorized` [V CK-PARTNERS].
- Envelope fields: `id`, `object`, `type`, `created_at`, `webhook_url`, `data` (the object), `include_object` [V CK-API].
- Signature: header `X-Checkr-Signature`, HMAC-SHA256 keyed with the account's API key (customer) or the partner app's `client_secret` (partner), computed over the compact JSON body; example `printf "$compact_json" | openssl sha256 -hmac ...`, so a hex digest [V CK-API] [V CK-PARTNERS]. Accounts with no API key get a placeholder string in the header [V CK-API]. Verify over the raw bytes as received; do not re-serialize.
- Delivery: HTTPS only (Basic auth in the URL allowed) or AWS SNS; return 2xx to acknowledge receipt only; retries "every minute for 10 minutes, then every hour for 24 hours"; "A maximum of two webhook URLs may be configured"; a URL that fails 100% for 60 days is removed; User-Agent prefix `Checkr-Webhook/` [V CK-API].
- Ordering is not guaranteed (`report.completed` may arrive after `report.engaged`): fetch the report and read its current fields [V CK-API]. Checkr recommends a dedupe safety net for repeated `report.completed` and an alert when none arrives within N days [V CK-API].
- Checkr pauses (no longer cancels) an adverse action while a candidate dispute is investigated and resumes it if the report is unchanged [3P CK-PAUSE, a Checkr announcement surfaced by search].

### 2.6 Hosted apply flow versus self-hosted (who carries FCRA duties)

- Hosted: "Checkr will also present disclosures and authorizations to the candidate, and enable eSignature to capture consent"; "Checkr is facilitating your obligations"; review the template disclosure language first [V CK-API].
- Self-hosted: the customer "is responsible for presenting and capturing all legal disclosure and consent forms and maintaining ongoing compliance with FCRA and state/locality regulations"; required screens include a standalone disclosure ("MUST be on its own page with no extraneous information"), the FCRA summary of rights, state-specific disclosures (California needs its own), an ESIGN-compliant authorization, and uploading the authorization to `POST /v1/candidates/{id}/documents` with type `consent` [V CK-API]. Partners on this path need Partner Manager review [V CK-PARTNERS].
- Checkr's recommended e-signature evidence for authorization: identify the candidate by login, typed name in a signature box, and store date, time, IP address and signed name so a PDF can be reproduced on demand [V CK-API]. Weft's built-in signature row stores signer principal, typed name, `signed_at`, document sha256 and action seq but no IP address or user agent [C forms.ts]; add those to the e-sign ext table if Weft ever hosts consent.

### 2.7 Partner model (for a hosted Weft later)

- Partner app in the Partner Dashboard yields `client_id` and `client_secret`; customers connect at `https://partners.checkr.com/authorize/{client_id}` (staging `https://partners.checkrhq-staging.net/authorize/{client_id}`, with `/signup` and `/signin` variants); exchange the single-use code (5 minute life) at `https://api.checkr.com/oauth/tokens` for a non-expiring, revocable `access_token` plus `checkr_account_id`; revoke with `POST https://api.checkr.com/oauth/deauthorize` [V CK-PARTNERS].
- Partner UI requirements: show the connected state, place the Connect link in at least two places, read packages from the customer account, send work locations with invitations [V CK-PARTNERS].
- Customers own adverse action; Checkr recommends directing customers to its Dashboard to adjudicate [V CK-PARTNERS]. This matches decision 6.

### 2.8 Terms that bind a connector (Checkr Services Agreement)

All [V CK-TERMS]:

- §2.3: use the Platform "via the Checkr API in compliance with its accompanying Documentation".
- §2.4(b): no use "for the benefit of any third party without Checkr's prior written permission"; §2.4(c): no copying, distributing, sublicensing, reverse engineering, derivative works, or building a competitive product.
- **§2.4(d): the customer shall not "use any agents, robots, scripts, spiders, or other automated means to access or manage the Platform."** Read together with §2.3, documented API calls are permitted, but an AI agent operating the account is exactly the kind of use to keep away from. Weft's design keeps the model off the vendor entirely: the agent proposes, a human approves, and server code issues one documented API call. Nitish should get Checkr's written confirmation before any live use [U on how Checkr reads §2.4(d) for this pattern].
- §2.5: keep API keys secret and do not "publish or share them with any unauthorized persons, including Your service providers, except as approved by Checkr in writing." For self-hosted Weft the operator's own key stays in the operator's own install; a hosted multi-tenant Weft must use the partner OAuth model instead.
- §3.5(a): before requesting an employment report, a clear and conspicuous standalone written disclosure and written authorization; §3.5(b): before adverse action, a copy of the report and the consumer's rights in the CFPB-approved format. §3.1(d): adverse action decisions only in compliance with law.
- §13.4: neither party may use the other's name, trademark or logos without consent. Weft uses the name only nominatively ("Connect Checkr") and no logo.

### 2.9 Spec for the simulator

- Checkr publishes an OAS3 bundle at `https://api.redocly.com/registry/bundle/checkr/Checkr%20Public%20API/v1/openapi.yaml` (HTTP 200, 576,314 bytes, 121 operations, `license: Proprietary`) [C CK-OPENAPI]. Follow its field names and enums for the subset in 2.3; do not commit the file or its descriptions.

---

## 3. HireRight

- Product page: the "HireRight Connect API" lets customers and partners "order HireRight screening services from within your preferred interface", "receive real-time alerts as orders progress", access reports through single sign-on, raw data and PDF, and promises "API documentation, best practice guides, and technical consultation" [V HR-CONNECT]. The suite lists a Background Check API (request and track orders, push status updates, report via SSO, raw data or PDF), an I-9 API, a Monitoring Rosters and Alerts API and others [V HR-CONNECT].
- No public developer portal, reference or sandbox was found; the API is described as partner and contract based [3P HR-APIEVANGELIST] [3P HR-STITCHFLOW]; API Tracker lists placeholders with no URLs [3P HR-APITRACKER].
- Access path seen in integrator docs: existing customers execute a "Modification of Services (MOD)"; new customers add the integration with a Sales Executive; a Technical Consultant is assigned "8-10 business days from the date of the request" and provides an API key and an "Integration Settings Guide" [3P HR-FOUNTAIN]. Greenhouse's integration is enabled through the HireRight account manager and status is viewed by opening HireRight [3P HR-GREENHOUSE]. Beeline requires "an existing contract and account with HireRight" [3P HR-BEELINE].
- Candidate flow seen in one integrator: the applicant creates a HireRight account and completes HireRight's forms; statuses include waiting for the client to submit, waiting for the applicant to start or finish forms, in progress, completed with an adjudication outcome (client review required, potential conflict, meets or does not meet company standards), canceled, expired, consent declined, error [3P HR-FOUNTAIN].
- **Design consequence.** There is no published wire format to follow, so a "HireRight (sim)" cannot honestly claim vendor shapes. Ship it as an adapter of Weft's normalized model with the integrator-documented status vocabulary mapped in, labeled "Simulated, API shape not published", and leave the live adapter as a stub that refuses with `INTEGRATION_NOT_AVAILABLE` and a pointer to section 1.

---

## 4. DocuSign eSignature

### 4.1 Free developer account and demo environment

- "A Docusign developer account (sometimes referred to as a demo account) enables you to develop and test your app in the developer environment (sometimes referred to as the demo environment), which is isolated from the production environment"; it is described as "a free sandbox environment"; "you cannot obtain official, legally binding signatures using envelopes sent from that account"; a personal email is allowed [V DS-ACCOUNT].
- Demo hosts: OAuth `account-d.docusign.com`, REST `https://demo.docusign.net/restapi`, admin `admindemo.docusign.com` [V DS-JWT-TOKEN] [C DS-PAGES, URLs in the page data].
- Burst limit in the developer environment: 200 calls per 30 seconds per account (500 in production) [V DS-LIMITS]. Hourly per-account limit is reported in `X-RateLimit-Limit` [V DS-LIMITS]. The paid QA sandbox plan terms cap 1,000 envelopes per month, 3,000 API calls per hour, 50 MB per user and 30 days of metadata retention [V DS-TERMS §5]; those numbers are for purchased QA sandboxes, and whether the free developer account has the same caps is [U]. Treat demo data as disposable (a community moderator also reports about 30 day deletion [3P DS-COMMUNITY]).

### 4.2 Auth

- **JWT Grant (recommended for Weft):** a service integration that impersonates one consenting user (for example an HR alias) without the user present; "The JWT Grant flow does not grant a refresh token"; tokens last one hour; renew about 15 minutes early [V DS-JWT] [V DS-JWT-TOKEN].
- Assertion: `alg RS256`, `iss` = integration key, `sub` = user ID, `aud` = `account-d.docusign.com` (demo) or `account.docusign.com`, `iat`, `exp`, `scope` = `signature impersonation`; POST to `https://account-d.docusign.com/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion` [V DS-JWT-TOKEN].
- Then `GET /oauth/userinfo` returns the user's accounts with `account_id` and `base_uri`; call the API at that base URI [V DS-JWT-TOKEN].
- Consent once per user and scope set through `/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=...&redirect_uri=...` [V DS-JWT-TOKEN]. `signature` is "Required to call most eSignature REST API endpoints"; `impersonation` is for JWT [V DS-SCOPES].
- Authorization Code Grant is the alternative for per-user apps (refresh tokens typically 30 days) [V DS-SCOPES]. Not needed for a single-company self-hosted install.
- Secret handling: the RSA private key file lives outside the repos; the adapter reads its path from `DOCUSIGN_PRIVATE_KEY_FILE` via `loadSecret` (reads the file on every call, never sets `process.env`) [C packages/agent/src/secrets.ts].

### 4.3 Endpoints Weft uses

All paths and operation ids [C DS-OPENAPI], under `{base_uri}/restapi`:

| Call | Operation | Weft use |
|---|---|---|
| `POST /v2.1/accounts/{accountId}/envelopes` | `Envelopes_PostEnvelopes` | Send the offer packet: `status: "sent"`, `emailSubject`, `documents[]`, `recipients.signers[]` with `clientUserId` (embedded), `notification.expirations{expireEnabled, expireAfter}`, optional `eventNotification` (envelope-level webhook), `customFields` carrying the Weft offer id |
| `POST .../envelopes/{envelopeId}/views/recipient` | `Views_PostEnvelopeRecipientView` | Embedded signing URL for the portal: `returnUrl`, `authenticationMethod` (Weft uses `None` in demo, `Password` or `SingleSignOn_Other` when Weft auth is real), `email`, `userName`, `clientUserId`, optional `frameAncestors`, `messageOrigins` |
| `GET .../envelopes/{envelopeId}` | | Status poll (rate-limited, 4.6) |
| `PUT .../envelopes/{envelopeId}` | | Void: `status: "voided"`, `voidedReason` (truncated to 200 characters) |
| `GET .../envelopes/{envelopeId}/documents/{documentId}` | `Documents_GetDocument` | Download `combined` and `certificate` PDFs on completion; store their sha256 |
| `GET .../envelopes/{envelopeId}/recipients` | | Recipient status detail |
| `GET .../envelopes/{envelopeId}/audit_events` | | Evidence panel (human view) |
| `PUT .../envelopes/{envelopeId}/notification` | | Change expiry when the offer's `expires_on` changes |
| `GET/POST /v2.1/accounts/{accountId}/templates` | | Optional: use a company's own DocuSign template with `templateId` and `templateRoles[{roleName, name, email, clientUserId}]` |
| `GET/POST/PUT /v2.1/accounts/{accountId}/connect` | | Account-level Connect configuration (optional) |

- Tabs: `signHereTabs`, `dateSignedTabs`, `fullNameTabs`, `textTabs` and more; `signHere` supports `anchorString` [C DS-OPENAPI]. Weft's templates emit anchor strings (for example `/weft-sign-1/` rendered in white) so no coordinates are needed.
- Document format for Weft's plain-text letters: send PDF rendered by Weft (most portable) [U whether `.txt` is accepted as-is; not checked].

### 4.4 Status vocabularies

All [C DS-OPENAPI]:

- Envelope status: create with `created` (draft) or `sent`; later `delivered`, `signed`, `completed`, `declined`, `voided`.
- Recipient status: `created`, `sent`, `delivered` (viewed in the signing site), `signed` (transient), `declined`, `completed`, and more.
- Embedded return: DocuSign redirects to `returnUrl` with an `event` query parameter: `signing_complete`, `cancel` (includes Finish Later), `decline`, `exception`, `session_timeout`, `ttl_expired`, `viewing_complete`, `access_code_failed`, `id_check_failed`, `fax_pending` [C DS-OPENAPI, `recipientViewRequest.returnUrl` description]. `returnUrl` max 470 characters.

### 4.5 Embedded signing rules

- A recipient is embedded when `clientUserId` is set (unique within the envelope); generate the URL with the same name, email and `clientUserId` [V DS-EMBEDDED].
- "signing links expire after 300 seconds (five minutes) and are one-time use only", so generate a fresh URL each time the hire clicks Sign [V DS-EMBEDDED].
- iframes are supported only for some authentication options; mobile signers need full-screen iframes [V DS-EMBEDDED]. Weft should redirect (full page) rather than iframe.
- Treat the `returnUrl` event as a hint, not proof: confirm with one envelope GET or the Connect message before accepting the offer (a forged redirect to `?event=signing_complete` must not accept an offer).

### 4.6 Connect webhooks and the polling rule

- Levels: account-level custom configurations, user-level (recipient) configurations, envelope-level (`eventNotification` on the envelope), organization-level [V DS-CONNECT].
- The listener must be on the public internet over HTTPS [V DS-CONNECT].
- Format: JSON SIM is recommended for all apps; each message has `event`, `uri`, `retryCount`, `configurationId`, `apiVersion`, `generatedDateTime`, `data{accountId, userId, envelopeId, recipientId, envelopeSummary?}` [V DS-SIM].
- Event names seen in the SIM model: `envelope-created`, `envelope-sent`, `envelope-resent`, `envelope-delivered`, `envelope-completed`, `envelope-declined`, `envelope-voided`, `envelope-corrected`, `envelope-purge`, `envelope-deleted`, `envelope-discard`, `envelope-reminder-sent`; `recipient-sent`, `recipient-resent`, `recipient-delivered`, `recipient-completed`, `recipient-declined`, `recipient-authenticationfailed`, `recipient-autoresponded`, `recipient-delegate`, `recipient-reassign`, `recipient-finish-later`; `template-created`, `template-modified`, `template-deleted` [C, extracted from DS-SIM page data].
- HMAC: one header per defined key, `X-DocuSign-Signature-1`, `-2` and so on (up to 100 keys), each the HMAC-SHA256 of the raw body "including line ends", base64 encoded; one match is enough; keys are created in the UI only, not via API [V DS-HMAC] [V DS-HMAC-VALIDATE] [V DS-HMAC-SETUP]. Envelope-level configs set `includeHMAC: true` and `requireAcknowledgment: true` [C DS-OPENAPI `eventNotification`].
- Retries after failure: 5 min, 10 min, 20 min, 40 min, 1 h, 2 h, 1 day [V DS-SIM].
- **Polling:** "Docusign strictly limits polling, preventing you from checking status more than once every 15 minutes per envelope"; apps that violate it fail Go-Live review; the docs suggest polling at 20 minute intervals [V DS-CONNECT] [V DS-LIMITS]. Per envelope, also keep creation, send and updates to about five calls [V DS-LIMITS].

### 4.7 Go-Live and terms that bind an open-source connector

- Go-Live promotes (copies) the integration key to production; secrets and redirect URIs must be configured again; production needs "A paid production account" and an integration classification: private custom, third-party key, public (partner program) or embedded (ISV Embed licensing) [V DS-GOLIVE]. A self-hosted Weft where each company brings its own key is the "private custom integration" case [U on DocuSign's view of that classification for open-source software].
- Developer Terms (last updated June 5, 2024) [V DS-TERMS]: §3.2 the API license is "internal (all others, including any affiliates, must obtain their own license and Integration Key)", so every Weft operator creates their own key and Weft never ships one; §3.5 no "Commercially Distribute" without a separate agreement, defined as distribution that "requires the payment of fees of any kind" including freemium (Weft is Apache-2.0 and free; a paid hosted Weft would need a DocuSign agreement); §3.7 open-source licenses control where they conflict; §3.8 name and logo only under the Brand Asset License; §8 no making Integration Keys available to others; §15.2 the Integration Key is not assignable.
- The OpenAPI specs are MIT licensed ("Copyright (c) 2017- DocuSign, Inc.") [C DS-OPENAPI LICENSE], 213 paths in `esignature.rest.swagger-v2.1.json`, last pushed 2026-08-31 [C].

---

## 5. Compliance rules the screening flow must model

### 5.1 Federal FCRA

- **Disclosure and authorization before the report:** "a clear and conspicuous disclosure has been made in writing to the consumer at any time before the report is procured", in a document that consists solely of the disclosure, and "the consumer has authorized in writing" [L FCRA-1681b(b)(2)(A)]. The FTC says the notice must be "in writing and in a stand-alone format" and not inside an application [L FTC-EMP].
- **Certification by the employer to the CRA** that it complied and will comply with the adverse action steps [L FCRA-1681b(b)(1)].
- **Pre-adverse action:** "before taking any adverse action based in whole or in part on the report", give the consumer a copy of the report and a written description of their rights [L FCRA-1681b(b)(3)(A)]; the FTC names the document "A Summary of Your Rights Under the Fair Credit Reporting Act" [L FTC-EMP].
- **Waiting period:** no fixed number in the statute or the FTC page, which says only that notice is given in advance [L FTC-EMP]. Practice is about five business days [3P CK-BLOG] [3P CFS-MONITOR]; Checkr defaults the post notice to 7 days after creation [V CK-API].
- **Adverse action notice contents** [L FCRA-1681m(a)]: notice of the action; the CRA's name, address and phone (toll-free if nationwide); a statement that the CRA did not make the decision and cannot give the reasons; the right to a free copy within 60 days; the right to dispute accuracy or completeness with the CRA. Oral, written or electronic [L FTC-EMP].
- **Investigative consumer reports** (interviews, for example reference checks): separate written notice and the right to request more disclosure [L FTC-EMP, citing 15 U.S.C. 1681d]. Weft packages exclude these in wave 3.
- **Disposal:** "securely dispose of the report and any information you gathered from it" so it "can't be read or reconstructed" [L FTC-EMP].

### 5.2 Fair chance timing at Weft's work locations

Weft's seeded workplaces are Oakland CA, Brooklyn NY (New York City), Austin TX and Remote US; offers can be in CA, NY, TX or CO [C packages/seed/src/company.ts lines 11 to 14] [C packages/core/src/portal/offers.ts `OFFER_STATES`].

| Location | Rule | When a check may run | Response window after the preliminary notice | Source |
|---|---|---|---|---|
| California (statewide, 5+ employees) | Fair Chance Act, Gov. Code 12952, effective 2018-01-01 | Only after a conditional offer | At least 5 business days; 5 more if the applicant disputes accuracy and is getting evidence; final notice must include the right to complain to the Civil Rights Department | [L CA-FCA-FS] for coverage and timing of the Act; response windows [3P SEYFARTH-CA] (the statute page returned 403 to me) |
| New York City (4+ employees; Brooklyn) | Fair Chance Act, amended by Local Law 4 of 2021 effective 2021-07-29 (covers current employees and pending cases) | Only after a conditional offer, and only after the employer has favorably evaluated non-criminal information first ("first receive the non-criminal information, evaluate it") | "a reasonable period of at least five business days"; the employer must give a copy of the inquiry and a written Article 23-A analysis (the Fair Chance Notice) | [L NYC-FCA]; the 2016 guidance said 3 business days and is superseded [L NYC-GUIDANCE-2016] |
| New York State | Correction Law Article 23-A: a conviction bars employment only on a direct relationship or an unreasonable risk, weighed on eight factors | (no statewide private ban-the-box found in this pass [U]) | | [L NYC-GUIDANCE-2016] (restates Article 23-A) |
| Austin, TX (15+ employees in Austin) | Fair Chance Hiring ordinance, City Code ch. 4-15 (2016): no criminal history inquiry or report until a conditional offer; withdrawal needs an individualized assessment | After a conditional offer | Not specified in the sources read | [3P AUSTIN]. **Status uncertain**: Texas HB 2127 (effective 2023-09-01) was reported to preempt it; litigation outcome not found [3P TX-HB2127] |
| Colorado (statewide) | Chance to Compete Act, C.R.S. 8-2-130: no criminal history question on the initial application, no "no records" ads | After the initial application; state guidance INFO #9C (2026-04-08) is reported to say checks may run after a conditional offer | Not specified | [3P CO-C2C] |

### 5.3 What the individualized assessment must weigh (for the human screen, never the agent)

- EEOC-style factors: nature and gravity of the offense, time elapsed, nature of the job (the same three appear in Austin's ordinance) [3P AUSTIN].
- New York Article 23-A: eight factors including time elapsed, age at the time, rehabilitation evidence and the employer's legitimate interests; a certificate of relief or good conduct "shall create a presumption of rehabilitation"; boilerplate denials violate the NYC law [L NYC-GUIDANCE-2016].
- California's 2025 automated-decision system regulations treat considering criminal history through "an automated-decision system" as within the prohibited consideration rules; the final text was approved 2025-03-21 [3P CA-ADS]; effective date [U]. This is the strongest reason the agent must not score, rank or summarize records.

### 5.4 The state machine Weft encodes

The simulator enforces it; real adapters enforce the Weft-side gates and let the CRA run its own timers.

1. `screening.order` is refused with `DOMAIN_SCREENING_BEFORE_OFFER` unless the offer is `accepted` (the conditional offer) and the worker exists. One rule for every state.
2. Work location is required (`country`, `state`, optional `city`) and passed to the vendor, because Checkr applies local law from it [V CK-API].
3. Consent: the vendor-hosted page (or the simulated CRA page) shows a standalone disclosure, the FCRA summary of rights, any state disclosure, then an authorization signature. Weft records only `consented_at` and the vendor's order id.
4. New York City orders run in two phases: a non-criminal package, a human "proceed to criminal check" approval, then the criminal package [L NYC-FCA].
5. Result `clear` marks the checklist task done. Result `consider` (or `assessment: review | escalated`) creates a human-only Inbox item "Review required" with no agent text.
6. Pre-adverse (human-only): copy of report plus summary of rights (vendor sends them), plus for CA the preliminary notice naming the convictions and the right to respond, and for NYC the Fair Chance Notice with the Article 23-A analysis. The offer's position stays open.
7. Waiting: final notice no earlier than max(7 calendar days, the jurisdiction's business-day minimum) on the sim clock (live: the vendor's `post_notice_scheduled_at`). A dispute adds the CA extension of 5 business days and pauses the timer until `report.dispute_completed`.
8. Final adverse (human-only): the 1681m(a) contents plus, in CA, the right to file with the Civil Rights Department. Then the worker's onboarding is ended through the existing void or offboarding path, never automatically.
9. Records: report detail is visible only to principals with a new `screening:review` grant; Weft stores no SSN, DOB or record text in its own tables for live adapters; sim data is synthetic.

---

## 6. Weft design

### 6.1 Where it plugs into today's code

- `documents.send_offer` (R2, approval always) writes the offer letter and confidentiality agreement as documents, creates the portal persona and emails the invite [C packages/core/src/portal/offers.ts].
- `documents.sign` (human only, R2) recomputes the document sha256, refuses `STALE_SUBJECT` on mismatch, writes a `signatures` row (signer, typed name, `signed_at`, sha256, action seq), and signing the offer letter accepts the offer and creates the worker as onboarding [C packages/core/src/portal/forms.ts].
- Offer transitions have no `declined` state: `draft -> sent | voided`, `sent -> viewed | voided | expired`, `viewed -> accepted | voided | expired` [C packages/contracts/src/wave2.ts].
- Onboarding task kinds have no background check task [C packages/contracts/src/enums.ts line 17].
- Contracts are frozen; additions go in `packages/contracts/src/ext/<track-id>.ts` with a note in `.scratch/contract-requests/` [C AGENTS.md rule 7].
- Simulators live in `packages/sim`, write only `sim_*` tables, read the sim clock and check the fault injector [C docs/simulators.md] [C packages/sim/src/index.ts].
- SPEC listed e-signature and background checks as out of scope for P0 [C SPEC.md line 60]; wave 3 lifts that for these two connectors only.

### 6.2 Screening connector

```ts
// packages/contracts/src/ext/w3-screening.ts (additive). Design sketch, not code to paste.
type ScreeningProvider = "sim" | "checkr" | "hireright";
type ScreeningMode = "simulated" | "sandbox" | "live";
type ScreeningStatus =
  | "invited" | "consented" | "in_progress" | "suspended" | "disputed"
  | "complete_clear" | "complete_review" | "canceled" | "expired";
type Adjudication = "none" | "engaged" | "pre_adverse" | "post_adverse";

interface ScreeningConnector {
  provider: ScreeningProvider; mode: ScreeningMode;
  listPackages(): Promise<{ slug: string; name: string; priceCents: number; screenings: string[]; phase: "full" | "non_criminal" | "criminal" }[]>;
  createOrder(i: { orderId: string; candidate: { first: string; last: string; email: string };
    packageSlug: string; workLocation: { country: string; state: string; city?: string } }):
    Promise<{ vendorCandidateId: string; vendorOrderId: string; applyUrl: string; status: ScreeningStatus }>;
  getOrder(vendorOrderId: string): Promise<ScreeningSnapshot>;      // poll fallback, also used after every webhook
  cancelOrder(vendorOrderId: string): Promise<void>;
  verifyWebhook(headers: Record<string, string>, rawBody: Uint8Array): boolean;
  parseWebhook(rawBody: Uint8Array): { dedupeKey: string; vendorOrderId: string; kind: string }[];
  // human-only path; never reachable from a model surface
  listAdverseItems(vendorReportId: string): Promise<{ id: string; text: string }[]>;
  startPreAdverse(vendorReportId: string, itemIds: string[], postNoticeAt: string): Promise<{ vendorAdverseId: string }>;
  cancelAdverse(vendorAdverseId: string): Promise<void>;
}
interface ScreeningSnapshot { status: ScreeningStatus; result: "clear" | "consider" | null;
  adjudication: Adjudication; etaOn: string | null; completedAt: string | null; vendorReportId: string | null }
```

Checkr mapping: `invitation.created -> invited`; `invitation.completed -> consented` (report auto-created); report `pending -> in_progress`; `suspended -> suspended`; `dispute -> disputed`; `complete + clear -> complete_clear`; `complete + consider -> complete_review`; `canceled -> canceled`; `invitation.expired -> expired`; `report.engaged -> engaged`; `adverse_action.created -> pre_adverse`; `adverse_action.completed -> post_adverse`; `adverse_action.paused | resumed` toggle a `timer_paused` flag [V CK-API] [C CK-OPENAPI].

HireRight (sim only) mapping from the integrator vocabulary: waiting on applicant forms -> `invited`; in progress -> `in_progress`; meets standards -> `complete_clear`; client review required or potential conflict or does not meet -> `complete_review`; consent declined, canceled, expired -> `canceled` or `expired` [3P HR-FOUNTAIN].

Selection: `WEFT_SCREENING=sim` (default), `checkr` (needs `CHECKR_API_KEY`, refuses production unless `WEFT_LIVE_CHECKR=1`), `hireright` (always refuses live). The Integrations page shows each connector with a "Simulated" badge unless real credentials loaded, mirroring the provider badge convention.

### 6.3 Screening simulator (`packages/sim/src/screening.ts`)

- Tables: `sim_screening_candidates`, `sim_screening_orders`, `sim_screening_events` (outbound webhook log), `sim_screening_packages` (seeded: "Standard (sim)" $35.00, "Standard plus MVR (sim)" $55.00, "NYC non-criminal (sim)" and "NYC criminal (sim)"; prices synthetic).
- Checkr-shaped JSON for invitations, reports and adverse actions using the field names and enums in 2.3 and 2.4; ids like `sim_rpt_000123`.
- Behavior on the sim clock: invitation pending until the persona completes the simulated CRA page (`/portal/screening/<order>` labeled "CRA apply page (simulated)"); then `in_progress` for 1 business day, then complete. Outcome is deterministic from a seeded rule (default `clear`) and the fault injector: `screening.consider` (complete with one synthetic, obviously fictional item), `screening.suspended` (needs info), `screening.dispute`, `screening.expire` (invitation expires after 7 days, as Checkr's default).
- Emits Checkr-format webhook bodies into the same inbound route with a valid `X-Checkr-Signature` computed from a sim secret, so the real verification code path is exercised by every e2e run.
- Enforces 5.4 timers: refuses a final notice before the waiting period; pauses on dispute.

### 6.4 E-signature connector

```ts
// packages/contracts/src/ext/w3-esign.ts (additive). Design sketch.
type ESignProvider = "builtin" | "docusign";
interface ESignConnector {
  provider: ESignProvider; mode: "builtin" | "sandbox" | "live";
  send(i: { packetId: string; offerId: string; documents: { weftDocId: string; title: string; pdf: Uint8Array; sha256: string }[];
    signer: { name: string; email: string; clientUserId: string }; expiresOn: string | null }):
    Promise<{ envelopeId: string; status: "sent" }>;
  signingUrl(envelopeId: string, signer: { name: string; email: string; clientUserId: string }, returnUrl: string):
    Promise<{ url: string; expiresAt: string }>;                       // DocuSign: 300 s, single use
  status(envelopeId: string): Promise<{ status: "sent" | "delivered" | "completed" | "declined" | "voided"; recipients: { clientUserId: string; status: string }[] }>;
  void(envelopeId: string, reason: string): Promise<void>;
  download(envelopeId: string, which: "combined" | "certificate"): Promise<Uint8Array>;
  verifyWebhook(headers: Record<string, string>, rawBody: Uint8Array): boolean;
  parseWebhook(rawBody: Uint8Array): { dedupeKey: string; envelopeId: string; event: string }[];
}
```

- `builtin` wraps today's path unchanged: `signingUrl` returns the portal document page; completion is `documents.sign`. It is the default, the fallback when `send` fails (fault `esign.send`), and the only path in `pnpm demo` and the golden paths so existing tests and GP6 stay byte-identical.
- New ext table `esign_envelopes (id, company_id, offer_id, provider, envelope_id, status, sent_at, delivered_at, completed_at, voided_at, last_polled_at, combined_sha256, certificate_sha256, decline_reason_tainted)` and an ext column set on signatures through a side table `signature_evidence (signature_id, provider, envelope_id, ip, user_agent)`.
- A DocuSign-shaped simulator (`packages/sim/src/esign.ts`) is optional; the builtin path already covers offline use, so build it only if the e2e suite needs to exercise the Connect parser without network (recommended: yes, a minimal one that emits JSON SIM bodies with a valid `X-DocuSign-Signature-1`).

### 6.5 Offer lifecycle mapped to a DocuSign envelope

| Weft step | DocuSign | Notes |
|---|---|---|
| `documents.send_offer` approved | `POST envelopes` with both documents, `status: "sent"`, one signer with `clientUserId = persona principal id`, `expirations{expireEnabled: true, expireAfter: days to expires_on}`, `customFields` = offer id, envelope `eventNotification` only when a public URL is configured | One envelope per offer (one signing session, one billable envelope in production). Weft's email simulator still sends the portal invite; embedded recipients use the portal link |
| Hire clicks Sign in the portal | `POST views/recipient` with `returnUrl = <web>/portal/esign/return?offer=...`, full-page redirect | URL regenerated on every click (300 s, single use) [V DS-EMBEDDED] |
| `documents.view_offer` | `recipient-delivered` | System command `documents.apply_esign_event` as `svc_events` |
| Offer accepted, both documents signed | `envelope-completed` (or a confirming GET after `?event=signing_complete`) | Download `combined` and `certificate`, store sha256, write two `signatures` rows with provider evidence, then the existing `acceptOffer` logic; idempotent on the envelope id |
| Candidate declines | `envelope-declined` | No `declined` lifecycle exists; add one through the ext (`viewed -> declined`, final) with the decline reason stored as tainted text, or map to `voided` with reason "declined by candidate". Recommend the ext state |
| `documents.void_offer` approved | `PUT envelope {status: "voided", voidedReason}` | Void reason is Weft template text, never model free text |
| `documents.expire_offers` | Envelope expires on its own; Weft also voids it to be sure | |

### 6.6 Flows the connectors power

1. **Offer and agreements:** as 6.5.
2. **Background check after acceptance:** the `offer.accepted` event (already emitted [C forms.ts]) lets the new-hire routine propose `screening.order` with the package mapped from the role. The approval card shows candidate, package, price from the DB, work location, provider and mode, and a fixed line "The screening company presents the disclosure and collects consent." On approval the executor calls `createOrder`; the candidate gets the vendor invite (sim: email simulator plus portal card).
3. **Results feed the checklist:** new task kind `background_check` (owner `agent` in the existing owner vocabulary; completes only through `screening.apply_vendor_event`, never `onboarding.complete_task`, which refuses it with `DOMAIN_SYSTEM_TASK`). Clear or human-engaged marks it done; review shows "Waiting on a person"; the first payroll is not blocked by default (company setting).
4. **Adverse action:** human-only Inbox flow per 5.4 steps 6 to 8.

### 6.7 Webhook handling

- Routes: `POST /v1/integrations/checkr/webhook`, `POST /v1/integrations/docusign/connect`. Public, no session; read the raw body before any JSON parsing; verify (Checkr: hex HMAC-SHA256 of the raw body with the API key or client secret; DocuSign: base64 HMAC-SHA256 against each `X-DocuSign-Signature-N`), constant-time compare; on failure return 401 and log the attempt without the body.
- Store in `integration_inbox (provider, dedupe_key unique, received_at, verified, raw_sha256, body_redacted, applied_at)`. Dedupe keys: Checkr event `id`; DocuSign `sha256(envelopeId + event + generatedDateTime)` (JSON SIM carries no event id [V DS-SIM]).
- Return 2xx immediately; the scheduler tick applies inbox rows through system commands (`screening.apply_vendor_event`, `documents.apply_esign_event`) on an exact `svc_events` allowlist, which audit-log like every other system write [C docs/simulators.md].
- Always re-fetch the object (Checkr report, DocuSign envelope) before changing state, because order is not guaranteed and bodies are untrusted [V CK-API].
- Taint: vendor-sourced text (adverse item text, decline reasons, void reasons, recipient names typed into DocuSign) is declared in `untrustedFields`; any run that reads them is tainted [C research/harness.md 6.2].
- **Local install has no public HTTPS URL.** Default to polling from the scheduler: Checkr report GET every 30 minutes while `in_progress` (far under 1,200 per minute); DocuSign envelope GET no more often than every 20 minutes per envelope, tracked in `last_polled_at`, plus one confirming GET after a `signing_complete` return that resets the timer. With a public URL (a tunnel Nitish runs himself, or the hosted Cloudflare twin), Weft registers envelope-level `eventNotification` with `includeHMAC: true` and `requireAcknowledgment: true`.

### 6.8 What the agent may do

| Command | Risk | Access | Agent call |
|---|---|---|---|
| `screening.list_packages`, `screening.get_status` | R0 | model | Execute; returns status, result, ETA, timestamps only |
| `screening.order` | **R4** (money commitment, FCRA regulated) | model | Propose always; `amountCents` = package price from `sim_screening_packages` or the cached vendor package list; ceilings `agent.screening_cents` per call and `agent.screening_day_cents` per day; refused before acceptance (`DOMAIN_SCREENING_BEFORE_OFFER`), when a non-canceled order exists, or with no work location |
| `screening.cancel` | R3 | model | Propose (no autoAllow) |
| `screening.proceed_to_criminal` (NYC phase 2) | R3 | **human_only** | Not on any model surface |
| `screening.review` (record detail), `screening.engage`, `screening.start_pre_adverse`, `screening.send_final_adverse`, `screening.cancel_adverse` | R2 to R4 | **human_only** | Not on any model surface |
| Nudge the candidate to finish consent | R3 | model | Existing `comms.send_message` (autoAllow untainted) |
| `documents.send_offer`, `documents.void_offer` | R2 (now also an external effect) | model | Propose always, unchanged |
| `documents.resend_envelope` | R3 | model | Propose |
| `documents.sign` | R2 | human_only | Unchanged; the agent never signs |
| `documents.get_envelope` | R0 | model | Execute; status and timestamps only |

A registry snapshot test (harness 5.4) pins these; a new test asserts no `screening.*` command whose name contains `adverse`, `engage` or `review` is on any model surface, and that `screening.get_status` output never contains adverse item text even when the sim plants one.

### 6.9 Config and secrets

`WEFT_SCREENING=sim|checkr|hireright`, `WEFT_ESIGN=builtin|docusign`, `WEFT_LIVE_CHECKR=1`, `WEFT_LIVE_DOCUSIGN=1` (tests refuse live calls the same way `LIVE_PROVIDER_IN_TEST` guards providers [C packages/agent/test/providers.test.ts]), `WEFT_PUBLIC_URL` (optional, enables webhooks). Secrets as in section 1, read only through `loadSecret` with `WEFT_SECRETS_FILE`, never logged; the Integrations page shows "key present" or "missing", never a value.

### 6.10 Contract additions and tests

- Ext files: `w3-screening.ts` (types above, `background_check` task kind, statuses, new refusal codes), `w3-esign.ts` (envelope DTO, `declined` lifecycle, evidence DTO). Contract request notes in `.scratch/contract-requests/`.
- Unit tests: HMAC verification for both vendors against fixed vectors (raw-body sensitive: a re-serialized body must fail); Checkr enum parsing from fixtures written by hand from 2.4; DocuSign SIM parser; dedupe; out-of-order events; DocuSign poll spacing never under 20 minutes per envelope.
- Scenarios: offer accepted, order proposed, approved, consent, clear, checklist done; consider path ends in a human-only Inbox item and the agent run shows no record text; NYC two-phase; CA dispute extends the timer; tainted run (adverse item text read) cannot auto-send anything.
- Live smoke (manual, Nitish's sandbox): one DocuSign demo envelope sent, signed embedded, completed, combined PDF sha256 stored. No Checkr or HireRight live smoke.

---

## 7. Open questions

1. Does Nitish want a public URL for webhooks (a tunnel he runs, or the hosted twin), or is polling acceptable for the DocuSign demo?
2. `declined` as a new offer state (ext) or mapped to voided?
3. Should a `consider` result block the start date or only flag it? (Default: flag only; company setting.)
4. Package-to-role mapping: one company default package, or per department?
5. Ask Checkr in writing how §2.4(d) applies to an approval-gated agent before any live use.

## 8. Not verified in this pass

- California Gov. Code 12952 text itself (leginfo returned 403; response windows come from a law-firm deck); the CA ADS regulations' effective date; Austin's ordinance status after Texas HB 2127; Colorado INFO #9C wording (seen only through a search summary).
- Whether the free DocuSign developer account carries the QA sandbox caps; whether Connect is enabled by default there; whether `.txt` documents are accepted.
- Every HireRight technical detail (no public docs).
- NYC Local Law 144 (automated employment decision tools) was not researched; keeping the agent out of adjudication is the design answer either way.

## 9. Sources

| Tag | URL or path |
|---|---|
| CK-API | https://docs.checkr.com/ (downloaded and converted to text this session) |
| CK-OPENAPI | https://api.redocly.com/registry/bundle/checkr/Checkr%20Public%20API/v1/openapi.yaml (downloaded and parsed) |
| CK-PARTNERS | https://docs.checkr.com/partners/ |
| CK-TERMS | https://checkr.com/legal/customer-agreement (downloaded and converted to text) |
| CK-PRICE | https://www.noon.ai/blog/articles/348-checkr-pricing-2026 (third party) |
| CK-BLOG | https://checkr.com/blog/basics-of-adverse-action |
| CK-PAUSE | https://updates.checkr.com/announcements/ann_XOac3i4CZRefQ (seen via search summary only) |
| CFS-MONITOR | https://www.consumerfinancialserviceslawmonitor.com/2015/05/district-court-holds-that-mailing-pre-adverse-and-adverse-action-letters-five-business-days-apart-is-plausible-fcra-claim-when-it-conflicts-with-content-of-pre-adverse-action-letter/ |
| HR-CONNECT | https://www.hireright.com/services/hireright-connect-api (downloaded) |
| HR-FOUNTAIN | https://support.fountain.com/en/articles/9899726-hireright |
| HR-GREENHOUSE | https://support.greenhouse.io/hc/en-us/articles/203801419-HireRight-integration |
| HR-BEELINE | https://hub.beeline.com/hireright-integration-334/hireright-integrations-overview-338 |
| HR-APIEVANGELIST | https://providers.apievangelist.com/providers/hireright/ (search summary) |
| HR-STITCHFLOW | https://www.stitchflow.com/user-management/hireright/api (search summary) |
| HR-APITRACKER | https://apitracker.io/a/hireright |
| DS-OPENAPI | https://github.com/docusign/OpenAPI-Specifications (`esignature.rest.swagger-v2.1.json`, `LICENSE`; downloaded and parsed; repo license MIT via GitHub API) |
| DS-PAGES | developers.docusign.com page-data JSON (Gatsby) for the pages below, fetched as `https://developers.docusign.com/page-data/<path>/page-data.json` |
| DS-ACCOUNT | https://developers.docusign.com/platform/account/ |
| DS-JWT | https://developers.docusign.com/platform/auth/jwt/ |
| DS-JWT-TOKEN | https://developers.docusign.com/platform/auth/jwt-get-token/ |
| DS-SCOPES | https://developers.docusign.com/platform/auth/reference/scopes/ |
| DS-EMBEDDED | https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/embedded-signing/ |
| DS-CONNECT | https://developers.docusign.com/platform/webhooks/connect/ |
| DS-SIM | https://developers.docusign.com/platform/webhooks/connect/json-sim-event-model/ |
| DS-HMAC | https://developers.docusign.com/platform/webhooks/connect/hmac/ |
| DS-HMAC-SETUP | https://developers.docusign.com/platform/webhooks/connect/setting-up-hmac/ |
| DS-HMAC-VALIDATE | https://developers.docusign.com/platform/webhooks/connect/validate/ |
| DS-LIMITS | https://developers.docusign.com/docs/esign-rest-api/esign101/rules-and-limits/ |
| DS-GOLIVE | https://developers.docusign.com/platform/go-live/ |
| DS-TERMS | https://www.docusign.com/legal/terms-and-conditions/developers (last updated 2024-06-05; downloaded) |
| DS-COMMUNITY | https://community.docusign.com/esignature-111/storinng-docs-4583 |
| FCRA-1681b | https://www.law.cornell.edu/uscode/text/15/1681b |
| FCRA-1681m | https://www.law.cornell.edu/uscode/text/15/1681m |
| FTC-EMP | https://www.ftc.gov/business-guidance/resources/using-consumer-reports-what-employers-need-know |
| CA-FCA-FS | https://calcivilrights.ca.gov/fair-chance-act/ |
| SEYFARTH-CA | https://www.seyfarth.com/dir_docs/publications/Deck-CaliforniaBackgroundCheckandCannabisUpdate.pdf (search summary) |
| CA-ADS | https://ogletree.com/insights-resources/blog-posts/california-civil-rights-department-unveils-new-proposed-regulations-on-employers-use-of-ai-and-automated-systems/ and https://calcivilrights.ca.gov/2024/05/17/civil-rights-council-releases-proposed-regulations-to-protect-against-employment-discrimination-in-automated-decision-making-systems/ (search summary) |
| NYC-FCA | https://www.nyc.gov/site/cchr/law/fair-chance-act.page |
| NYC-GUIDANCE-2016 | https://www.nyc.gov/site/cchr/media/fair-chance-legalguidance.page (revised 2016-03-11, partly superseded) |
| AUSTIN | https://www.austintexas.gov/sites/default/files/files/FCH_Overview-Fact_Sheet_for_Job_Seekers.pdf and https://www.accurate.com/blog/austin-becomes-the-first-city-in-texas-to-ban-the-box-for-private-employers (search summary) |
| TX-HB2127 | https://www.littler.com/news-analysis/asap/texas-governor-signs-preemption-bill-crown-act-and-other-legislation-law and https://disa.com/news/texas-rolls-back-fair-chance-hiring-implications-for-austin-and-beyond/ (search summary) |
| CO-C2C | https://www.littler.com/news-analysis/asap/colorado-limits-inquiries-about-applicants-criminal-history and https://ezel.ai/labor-guidance/co/info-9c (search summary) |
| Repo files | `packages/core/src/portal/offers.ts`, `packages/core/src/portal/forms.ts`, `packages/contracts/src/wave2.ts`, `packages/contracts/src/enums.ts`, `packages/agent/src/secrets.ts`, `packages/sim/src/index.ts`, `packages/seed/src/company.ts`, `docs/simulators.md`, `research/harness.md` sections 5.4 and 6.2, `research/product.md`, `research/wave3/agent-parity.md`, `SPEC.md`, `AGENTS.md` |
