# Wave 3 research: Greenhouse and Workday integrations

Researched 2026-10-16 for wave 3 goal 3 (integrations Cloudflare uses). Scope here is Greenhouse and Workday only; HireRight, Checkr and DocuSign are covered in a separate file. Nothing in this file is application code. Nothing was committed.

How to read the tags:

- **[V]** I verified it myself: a live read-only GET on a public endpoint, or a public spec file I downloaded and parsed (scratch copies only, outside the repo, nothing from them is committed).
- **[S]** The vendor states it in its own docs. I read the page; I did not test it against a real tenant.
- **[3P]** A third party states it (integration vendors, forums). Treat as unconfirmed.
- **[I]** My inference or recommendation.

No model calls were made for this research ($0.00 spent).

---

## 0. The answer in ten lines

1. **Greenhouse Harvest v1 and v2 are gone.** Greenhouse's docs say v1/v2 "will be removed on August 31, 2026" [S, https://docs.greenhouse.io/harvest.html]. Today is 2026-10-16, so build only against **Harvest v3** (`https://harvest.greenhouse.io/v3`, OAuth 2.0 bearer JWT, cursor paging) [S, https://harvestdocs.greenhouse.io/docs/authentication.md]. Older open-source Greenhouse connectors and blog posts that use Basic auth on `/v1/` are out of date.
2. **Greenhouse publishes a machine-readable OpenAPI 3.1.0 fragment on every v3 reference page.** A simulator can follow it exactly [V, `https://harvestdocs.greenhouse.io/reference/get_v3-offers.md` contains `"openapi": "3.1.0"`, servers `https://harvest.greenhouse.io`, 163 OAuth scopes].
3. **The Greenhouse Job Board API is public and works without auth.** I called it live for Cloudflare's board: 200, 438 jobs, about 400 KB, no rate-limit headers [V]. The shape is in section 1.6.
4. **No free Greenhouse developer sandbox exists for individuals.** Sandboxes are "Available to Pro subscription tier" customers [S, https://support.greenhouse.io/hc/en-us/articles/17053185557787-Use-a-sandbox]. Partner OAuth needs a signed partnership agreement [S, https://harvestdocs.greenhouse.io/docs/harvest-partner-oauth.md]. **So the free version of Greenhouse in Weft is the simulator, plus the real public job board.**
5. **Workday now has a free-to-join developer program with a personal development tenant (open access beta).** You sign up with a personal email at https://developer.workday.com [S, https://blog.workday.com/en-us/workday-open-developer-platform-generally-available.html]. You get 1 tenant at a time, and it "expires if you don't log in to it for 7 consecutive days" [S, https://developer.workday.com/doc/GUID-4f875963-a845-43b5-868a-0f77e6261eb7-enHYPHENus.md]. Workday does not state its cost, its sample data, or which APIs it supports. This is the only realistic real-mode path for Nitish.
6. **Workday publishes all SOAP WSDLs (v47.0 / 2026R2, 58 services) and all REST OpenAPI 2.0 specs publicly, no login.** I downloaded Human_Resources, Staffing, Absence_Management, Compensation and Payroll_Interface WSDLs, plus the absenceManagement v5, staffing v7, common v1, businessProcess v1 and compensation v3 OAS2 files [V]. The simulator can follow these.
7. **Workday has no generic outbound webhook.** Change detection is pull: SOAP `Get_Workers` with `Transaction_Log_Criteria_Data` (`Updated_From` / `Updated_Through`) [V, WSDL], or a RaaS custom report. Workday's tenant-configured outbound notifications exist [3P], but treat them as a "something changed" nudge, then pull.
8. **The right Workday role for Weft is "external payroll engine behind Workday HCM".** The `Payroll_Interface` web service exists exactly "for integration with external payroll systems". It has `Get_Payees`, `Get_External_Payroll_Inputs` and `Import_External_Payroll_Results` [V, WSDL]. When connected, Workday is the system of record for people, compensation and absence. Weft computes pay and writes results back through proposals.
9. **Recommended Weft flows:**
   - Greenhouse: `hire_candidate` webhook or poll, then a Weft offer draft as a proposal, then the existing wave 2 offer and onboarding flow.
   - Workday: worker sync, then the Weft people mirror. Time off reads come from Workday when connected. Weft Time Off is the native system of record otherwise.
10. **The agent reads freely and writes only through proposals.**
    - Every integration write is a proposal at R3 with `always`, so it is never auto-allowed.
    - Candidate-supplied fields are `untrustedFields`.
    - Webhook payloads are reduced to id-only events before anything else sees them, which matches SPEC 9.3.

---

## 1. Greenhouse

### 1.1 API surfaces relevant to Weft

| Surface | Base URL | Auth | Use for Weft | Source |
|---|---|---|---|---|
| Harvest v3 | `https://harvest.greenhouse.io/v3` | OAuth 2.0 bearer JWT | Candidates, applications, offers, jobs, departments, offices, users, mark hired | [S] https://harvestdocs.greenhouse.io/docs/authentication.md |
| Harvest v1/v2 | `https://harvest.greenhouse.io/v1/` | Basic (API key as username, blank password) | **Do not build.** "deprecated and will be removed on August 31, 2026" | [S] https://docs.greenhouse.io/harvest.html |
| Job Board API | `https://boards-api.greenhouse.io/v1/boards/{board_token}` | None for GET; Basic with Job Board API key for application POST | Public open roles; the simulator's candidate "apply" | [S] https://docs.greenhouse.io/job-board.html, [V] live GET |
| Webhooks | Customer configures in Greenhouse; v3 `/v3/webhooks` is "Greenhouse partners exclusive" | HMAC-SHA256 `Signature` header | `hire_candidate`, `offer_*` triggers | [S] https://docs.greenhouse.io/webhooks.html, [V] `post_v3-webhooks.md` title |
| Onboarding API (Greenhouse Onboarding product) | `https://onboarding-api.greenhouse.io/graphql` | Basic (Access Key / Secret Key), Super Admin creates | Only if a customer runs Greenhouse Onboarding; Weft has its own onboarding, so P2 | [S] https://docs.greenhouse.io/gho.html |

### 1.2 Harvest v3 auth

- **Custom (single-customer) integrations** [S, https://harvestdocs.greenhouse.io/docs/authentication.md]:
  - Use OAuth 2.0 **client credentials**: `POST https://auth.greenhouse.io/token`.
  - Send HTTP Basic `client_id:client_secret` and the body `grant_type=client_credentials` (form-encoded).
  - The response carries `access_token` and `expires_in` in seconds.
  - Renew on a 401 or before expiry.
  - Credentials come from Greenhouse > API Credentials > Create new API credentials > "Harvest V3 (OAuth)". Scopes are then configured there.
- **Partners** use the authorization code flow [S, https://harvestdocs.greenhouse.io/docs/harvest-partner-oauth.md]:
  - `https://auth.greenhouse.io/authorize?response_type=code&client_id&redirect_uri&scope&state`.
  - The code lives 1 minute, the access token 1 hour, the refresh token 14 days. Each refresh rotates both tokens.
  - Becoming a partner requires the form at https://www.greenhouse.com/integration-partner#apply-now and a signed agreement. After that, email partner-support@greenhouse.io with scopes, redirect URIs and a 128x128 logo.
  - Environments are "testing" (own sandbox) or "production".
- **`sub` claim (replaces v1 `On-Behalf-Of`)**:
  - Omit `sub` to act as the integration service user, which has org-wide access.
  - Set `sub` to a Site Admin's numeric user id to act as that user [S, OpenAPI `securitySchemes.bearer` in https://harvestdocs.greenhouse.io/reference/get_v3-offers.md].
  - Gotcha: if `sub` names a Site Admin without the advanced permission "See private notes, private fields, salary info, manage offers, request approval, and approve jobs/offers", the offer endpoints **return an empty list, not an error**, and writes return 403 [S, same page].
  - **Weft rule [I]:** the real adapter omits `sub` by default. In the connection test it reads one offer and warns "offers hidden by permissions" when candidates exist but offers come back empty.
- **Transition endpoint:** `https://harvest.greenhouse.io/auth/token` took the v1/v2 key [S]. It is irrelevant now that v1/v2 are removed.
- **Secret rotation:** old secrets stay valid for up to 1 week [S].

### 1.3 Harvest v3 rate limits and paging

- **Rate limit window** [S, https://harvestdocs.greenhouse.io/docs/api-rate-limiting.md]:
  - The window is fixed at 30 seconds. Token requests have a separate 60-second window.
  - No numeric quota is published; 75 appears only as an example header value.
  - Headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (UTC epoch).
  - Exceeding the limit returns 429 with `Retry-After` in seconds. Custom and partner integrations are limited separately.
- **Paging** [S, https://harvestdocs.greenhouse.io/docs/pagination.md]:
  - The cursor is opaque and comes from `Link: <...?cursor=...>; rel="next"` (RFC 5988). Only `next` is returned; there is no `prev` or `last`.
  - When `cursor` is present it must be the only query parameter. Filters go on the first request only.
  - `per_page` is 1 to 500, default 100. Results are ordered by `id` descending. A 422 means a malformed cursor or a cursor mixed with other params.
- **List responses are bare JSON arrays with no envelope** [S, get_v3-offers.md].
- **Simulator requirement [I]:**
  - Emit the same headers and Link format, and the 422 on cursor misuse.
  - Use a deterministic quota (75 per 30 s) so a fault `greenhouse.rateLimit` can force a 429 with `Retry-After: 3`.
- **Incremental sync** [S]: `updated_at[gte]` style object filters (`gte`, `lte`, `gt`, `lt`) exist on candidates, applications and offers. Offers also accept `resolved_at`, `starts_on` and `sent_on`.

### 1.4 Harvest v3 resources Weft needs (field lists from the v3 OpenAPI fragments)

All schemas below declare `additionalProperties: false` [S].

**Application** (`GET /v3/applications`, scope `harvest:applications:list`) [S, https://harvestdocs.greenhouse.io/reference/get_v3-applications.md]:

- Fields:
  - `id`, `created_at`, `updated_at`, `candidate_id`, `job_id` (null for jobless prospects), `job_post_id`
  - `stage_id`, `job_interview_stage_id`, `stage_name`, `status`, `prospect`, `needs_decision`
  - `rejected_at`, `rejection_reason_id`, `last_activity_at`, `source_id`, `referrer_id`, `recruiter_id`, `coordinator_id`, `agency_note_id`
  - `location_address`, `answers[] {question, answer}`, `prospective_job_ids[]`, `custom_fields`
- `status` in responses is `rejected | hired | converted | in_process`. The **filter** enum is `rejected | hired | converted | active`; note `active` vs `in_process`.
- Filters: `status`, `candidate_ids`, `job_ids` (max 50 each), `updated_at`, `created_at`, `last_activity_at`, `fields`.

**Candidate** (`GET /v3/candidates`, scope `harvest:candidates:list`) [S, https://harvestdocs.greenhouse.io/reference/get_v3-candidates.md]:

- Fields:
  - `id`, `created_at`, `updated_at`, `first_name`, `last_name`, `preferred_name`, `company`, `title`
  - `last_activity_at`, `private`, `can_email`, `time_zone`, `tags[]`, `linked_user_ids[]`
  - `phone_numbers[] {value,type}`, `addresses[] {value,type}`, `email_addresses[] {value,type}`, `website_addresses[]`, `social_media_addresses[] {value}`, `custom_fields`
- There are no `application_ids`; join through applications.
- Filters: `email` (case-insensitive, any address), `ids` (max 50), `updated_at`, `tag`.

**Offer** (`GET /v3/offers`, scope `harvest:offers:list`) [S, https://harvestdocs.greenhouse.io/reference/get_v3-offers.md]:

- Fields: `id`, `created_at`, `updated_at`, `version`, `application_id`, `job_id`, `candidate_id`, `opening_id`, `status` (`Created | Accepted | Rejected | Deprecated`), `starts_on`, `sent_on`, `resolved_at`, `custom_fields`.
- **Compensation lives in `custom_fields`**, which are configured per customer.
- Offers are **versioned**: changing the start date, the opening or a version-triggering field creates a new row with `version+1`. Use `current_only=true`.
- "combine `status=Accepted` with the `resolved_at` filter as a hire-date filter" [S].
- Writes:
  - `POST /v3/offers`: requires `application_id`; also takes `starts_on` and a `custom_fields[]` array.
  - `PATCH /v3/offers/{id}` replaces v1 `PATCH .../applications/{id}/offers/current_offer` [S, https://harvestdocs.greenhouse.io/docs/write-endpoint-migration-guide.md].

**Mark hired** (`POST /v3/applications/{id}/hire`, scope `harvest:applications:hire`) [S, https://harvestdocs.greenhouse.io/reference/post_v3-applications-id-hire.md]:

- Body: `start_date` (date-time), `opening_id` (required when the job has more than one open opening), `close_reason_id`.
- Returns 204 on success. It sets the application to `hired` and closes the opening.

**Other scopes Weft needs** [V, scope list in the OpenAPI fragment]: `harvest:jobs:list`, `harvest:departments:list`, `harvest:offices:list`, `harvest:users:list`, `harvest:openings:list`, `harvest:close_reasons:list`, `harvest:custom_fields:list`. Scopes are listed one per resource and action (163 total).

**Minimum read-only scope set for Weft real mode [I]:** `harvest:applications:list harvest:candidates:list harvest:offers:list harvest:jobs:list harvest:departments:list harvest:offices:list harvest:users:list harvest:custom_fields:list`. Add `harvest:applications:hire` only if Nitish enables write-back.

### 1.5 Greenhouse webhooks

All facts in this section are [S, https://docs.greenhouse.io/webhooks.html] unless marked.

- **Setup:** the customer configures a webhook with a name, an HTTPS endpoint, a secret key, and optional Basic auth or extra headers.
  - Reserved headers: Content-Type, Content-Length, Greenhouse-Event-ID, Authorization, User-Agent, Signature.
  - The v3 API that creates webhooks is "Greenhouse partners exclusive" [V, title of https://harvestdocs.greenhouse.io/reference/post_v3-webhooks.md].
  - **A customer (Nitish) sets webhooks up in the Greenhouse UI, not through the API.**
- **Endpoint ports:** the endpoint URL must use port 80, 443, 1880, 8081, 9090 or 54015 [S, post_v3-webhooks.md request schema].
  - Consequence [I]: a self-hosted Weft needs a public HTTPS URL on one of those ports (a tunnel or reverse proxy).
  - Local dev on 4070 cannot receive real deliveries; real mode on a laptop falls back to polling.
- **Signature:**
  - Header `Signature: sha256 <hexdigest>`, an HMAC-SHA256 with the secret over the **entire raw JSON body**.
  - Greenhouse escapes Unicode before signing (`<` becomes `<`), so verify against the raw bytes and never re-serialize.
  - Each delivery carries a unique `Greenhouse-Event-ID`, which is the idempotency key.
- **Retries:**
  - Up to 7 attempts over about 15 h. The waits are 0, 1m, 15m, 60m, 120m, 240m, 480m, for cumulative times of 0, 1m, 16m, 1h16m, 3h16m, 7h16m, 15h16m.
  - Retries are triggered by a timeout, a non-200 response or a network error.
  - v3 webhook creation takes `max_attempts` from 1 to 7 and `error_recipient_email` [S, post_v3-webhooks.md].
- **Ping:** saving a webhook sends a ping. If the ping fails, the webhook is left disabled and must be re-enabled manually.
- **Event `action` values relevant to Weft:**
  - `hire_candidate` fires when an offer is accepted through "Accept Offer" on the candidate's Private tab.
  - Also relevant: `unhire_candidate`, `offer_created`, `offer_approved`, `offer_updated`, `offer_deleted`, `candidate_stage_change`, `update_candidate`, `delete_candidate`, `merge_candidate`, `candidate_anonymized`, `job_created`, `job_updated`, `department_deleted`, `office_deleted`.
  - The full 29-value enum is in post_v3-webhooks.md [V].
  - There is **no `offer_accepted` event**; acceptance surfaces as `hire_candidate` plus `offer_updated`.
- **`hire_candidate` payload:** `{action, payload: {application: {...}}}`.
  - `application`: `id`, `opening`, `credited_to`, `source`, `url`, `candidate`, `job` (deprecated), `jobs[]`, `custom_fields`, `offer`.
  - `candidate`: `id`, `first_name`, `last_name`, `title`, `external_id`, `is_private`, `can_email`, `phone_numbers[]`, `email_addresses[]`, `addresses[]`, `educations`, `employments`, `recruiter`, `coordinator`, `attachments`, `custom_fields`.
  - `offer`: `id`, `version`, `created_at`, `sent_at`, `resolved_at`, `starts_at`, `custom_fields`. Example salary: `{"name":..., "type":"currency", "value":{"amount":80000,"unit":"USD"}}`.
  - `jobs[]`: `id`, `name`, `requisition_id`, `confidential`, `opened_at`, `closed_at`, `departments[] {id,name,external_id}`, `offices[] {id,name,location,external_id}`, `custom_fields`. `employment_type` sits in job custom fields as a string such as "Full-time".
  - Note: the webhook offer uses `sent_at` and `starts_at`, while Harvest v3 uses `sent_on` and `starts_on`. **The mapper must handle both.**
- **Payloads omit some data.** The docs tell you to fetch the rest from Harvest. Weft design [I]: treat the webhook as a nudge, verify the signature, then re-read application, offer and candidate from Harvest (real) or the simulator store (sim). Never trust the webhook body as the record.

### 1.6 Job Board API: live verification

I made two read-only GETs on 2026-10-16 at 19:57 UTC [V]. I stored no personal data; a job board holds none.

**Call 1:** `GET https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs?content=false`

- HTTP/2 200, `content-type: application/json`, 400,188 bytes, 0.28 s.
- Served through CloudFront. Headers: `etag` (weak), `cache-control: max-age=0, private, must-revalidate`, `vary: Origin, Accept-Encoding`. **No `X-RateLimit-*` headers.**
- Top level: `{ jobs: Job[], meta: { total: 438 } }`. There are 438 unique ids.
- Job fields:

| Field | Type | Observed |
|---|---|---|
| `id` | int | Job post id, used in `absolute_url` and for POST apply (7695702) |
| `internal_job_id` | int | Job id (null for prospect posts [S]) |
| `title` | string | |
| `company_name` | string | "Cloudflare" |
| `requisition_id` | string | Free text |
| `location` | `{name}` | Values like "Hybrid", "Distributed", "In-Office" (Cloudflare uses this field for work mode) |
| `absolute_url` | string | `https://boards.greenhouse.io/cloudflare/jobs/{id}?gh_jid={id}` |
| `updated_at`, `first_published` | string | ISO 8601 **with offset**, e.g. `2026-10-13T20:57:01-04:00` |
| `language` | string | "en" |
| `application_deadline` | null | Null on all 438 |
| `metadata` | `[{id,name,value,value_type}]` | `value` is a **string for `single_select` and an array for `multi_select`**. Cloudflare uses "Cost Center", "Job Posting Location", "Career Site Department" |
| `data_compliance` | `[{type:"gdpr", requires_consent, requires_processing_consent, requires_retention_consent, retention_period, demographic_data_consent_applies}]` | |

**Call 2:** `GET https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs/7695702?questions=true`

- 200, 20,623 bytes.
- Adds `content` (an HTML-escaped string), `departments[] {id,name,child_ids,parent_id}`, `offices[] {id,name,location,child_ids,parent_id}`, `questions[]`, `location_questions[]`, `compliance[]`, `demographic_questions` (null here) and three AI fields: `ai_disclaimer`, `include_ai_disclaimer`, `ai_opt_out_request_url`. The docs I read do not mention the AI fields [V].
- `questions[]` items are `{label, description, required, fields:[{name, type, values:[{label,value}]}]}`.
  - Field types seen: `input_text`, `input_file`, `textarea`, `multi_value_single_select`, `multi_value_multi_select`.
  - Standard names: `first_name`, `last_name`, `email`, `phone`, `resume` / `resume_text`, `cover_letter` / `cover_letter_text`.
  - Custom names: `question_<id>` (single) and `question_<id>[]` (multi).
- `location_questions` are `latitude`, `longitude` (`input_hidden`) and `location`.
- `compliance` has two `eeoc` blocks: `veteran_status`, `race`, `gender`.
- **Application submission** [S, https://docs.greenhouse.io/job-board.html]:
  - `POST https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}` with Basic auth (Job Board API key, Base64, no password), server-side only.
  - Body is multipart or JSON; base64 files go in `*_content` plus `*_content_filename`.
  - Required: `first_name`, `last_name`, `email`. "Validation for required fields must be done on the client side."
  - Attachments must be pdf, doc, docx, txt or rtf.
  - **Weft never calls this against a real board** [I]. It needs a key and creates real candidates in someone's ATS. The simulator implements the same route shape so the fictional Larkspur careers page can "apply".

**Test guidance [I]:**

- Commit a hand-written fixture that follows the shape above with fictional Larkspur roles. Do not commit Cloudflare's response.
- Add one opt-in smoke test (for example `WEFT_LIVE_PUBLIC=1`) that GETs a public board once and checks shape only. The default `pnpm test` never touches the network.

### 1.7 Greenhouse Onboarding API (P2 for Weft)

Facts are [S, https://docs.greenhouse.io/gho.html].

- GraphQL at `https://onboarding-api.greenhouse.io/graphql` with Basic auth (Access Key / Secret Key). Only Super Admins create keys, and a key cannot be scoped.
- Paging needs `first` or `last`, at most 25 per page. Every response is HTTP 200; failures carry an `errors` key with codes `Authentication | Validation | NotFound | Server | RateLimit`. Rate limiting is complexity-based (`rateLimit {cost, limit, remaining, resetAt}`).
- Mutations:
  - `addPendingHire(pendingHireInfo: AddPendingHireInput!)` requires `firstName`, `lastName`, `email`, `workCountryCode`.
  - `updateEmployeeProfile(id, employeeUpdates)`.
- The `employees` query filters on `updatedAt {after,before}` and `startDateFilter`. Many old argument names are deprecated in favor of `*Filter`.
- **Recommendation [I]: skip.** Weft is the onboarding product. If a customer runs Greenhouse Onboarding, the hire flows Recruiting > Weft directly.

### 1.8 Greenhouse: free version, terms, what Nitish must do

- **Free sandbox for an individual: none found.**
  - Sandbox requires the Pro tier [S, support article above].
  - The partner program requires an application and a signed agreement [S, harvest-partner-oauth.md].
  - A third-party aggregator says sandbox is "only available to paid Expert subscription" [3P, https://docs.unified.to/sandboxes]. That conflicts with "Pro"; trust Greenhouse.
- **Free real surface:** the public Job Board API (GET only). Weft real mode can show "Open roles from your Greenhouse board" for any board token, read-only, with no credentials.
- **Terms:**
  - I did not find a developer API license that forbids open-source connectors.
  - Customer data access runs under the customer's Master Subscription Agreement (https://www.greenhouse.com/master-subscription-agreement) [S, not read in full].
  - Partner integrations are governed by the partnership agreement [S].
  - Building an open-source client against published docs and having each customer supply their own credentials is the normal pattern [I].
  - Use the name only nominatively ("Connect Greenhouse"), with no logo.
- **What Nitish would do himself** (only if he wants real mode; the simulator needs nothing):
  1. Nothing for the job board: just pick a public board token to display.
  2. Without access to a Greenhouse Recruiting account (his own employer's, or a Pro-tier sandbox invitation), stop there. Real Harvest mode is not reachable for free.
  3. With an account: a Site Admin creates "Harvest V3 (OAuth)" credentials with the scope set in 1.4. Put `WEFT_GREENHOUSE_CLIENT_ID` and `WEFT_GREENHOUSE_CLIENT_SECRET` in `~/Developer/projects/.weft.secrets.env`.
  4. Optionally create a webhook for `hire_candidate` pointing at a public HTTPS tunnel on port 443. Put its secret in `WEFT_GREENHOUSE_WEBHOOK_SECRET`.

---

## 2. Workday

### 2.1 API surfaces relevant to Weft

| Surface | Endpoint shape | Use for Weft | Source |
|---|---|---|---|
| SOAP Workday Web Services (WWS) v47.0 (2026R2) | `https://{host}/ccx/service/{tenant}/{Service}/v47.0` [3P for the exact path] | Workers with change log, orgs, compensation, absence, payroll interface | [V] directory https://community.workday.com/sites/default/files/file-hosting/productionapi/index.html; WSDLs at `.../productionapi/{Service}/v47.0/{Service}.wsdl` |
| REST | `https://{tenantHostname}/api/{serviceName}/{version}/{tenant}` | Simple reads, request time off, business process events | [S] https://developer.workday.com/doc/GUID-85810465-bcfb-4fdf-a26d-55eaff3968a8-enHYPHENus.md; [V] OAS2 files from https://community.workday.com/sites/default/files/file-hosting/restapi/ |
| RaaS (custom report as web service) | Report-as-a-service URL with `format=` (CSV, GData, JSON, RSS, Simple XML, Workday XML) | Bulk worker or absence extracts with "updated since" prompts | [S] https://developer.workday.com/doc/hto1529968349582.md |
| Graph API, WQL | Extend and WQL REST | Not needed for v1 of the connector | [S] developer.workday.com llms.txt index |
| Outbound notifications | Tenant config; SOAP push to an external endpoint | Change nudge only | [3P] forum and education material (see 2.6) |

**Versions:**

- SOAP is v47.0, 2026R2 [V, the directory heading]. Directory notes: `Interview_Feedback__Do_Not_Use_` is "being retired in a future release" in favor of `Recruiting` [V].
- REST production versions [V, `services2026.41.json`]: Absence Management v5, Staffing v7, Common v1, Business Process v1, Compensation v3, Person v4, Recruiting v4, Time Tracking v7, Expense v1. Older versions are listed under `archivedServices`.

### 2.2 Workday auth

- **Developer-site API clients (Extend, Orchestrate, external integrations)** [S, https://developer.workday.com/doc/zwx1518028675482.md]:
  - Register under Console > API Clients > Create API Client, with redirect URI, CORS domains and functional-area scopes. You get a client id and secret.
  - Nondevelopment tenants must allowlist the client id (Company Administrator, "Modify Authorized Tenants").
- **Refresh grant** [S, https://developer.workday.com/doc/cqa1553122177664.md]:
  - `POST https://auth.api.workday.com/v1/token` with `grant_type=refresh_token`, `client_id`, `refresh_token`, and Basic `client_id:client_secret`.
  - Access-token lifetime "is tied to the session timeout configured for the user".
  - Refresh tokens expire at a timeout set at registration, counted from first authorization and **not extended on refresh**. They are also invalidated if the user is renamed or deactivated.
- **Classic tenant integrations** [3P]:
  - Run the task "Register API Client for Integrations", ideally with non-expiring refresh tokens.
  - Generate the refresh token under View API Clients > API Clients for Integrations > Manage Refresh Tokens for Integrations, bound to an **Integration System User (ISU)** with session timeout 0.
  - The token endpoint is shown on View API Clients, format `https://{host}/ccx/oauth2/{tenant}/token` [3P, https://nango.dev/docs/api-integrations/workday-refresh-token/connect; https://help.merge.dev/en/articles/9891389-workday-how-do-i-link-using-oauth].
- **Other flows:** Workday also documents client credentials, authorization code, PKCE and ISU flows [S, titles in https://developer.workday.com/llms.txt: "Authenticate Using the Client Credentials Grant Type", "Reference: Integration System User (ISU)"].
- **SOAP** classically uses WS-Security UsernameToken with `isu_user@tenant` [3P, common practice; not verified in a Workday doc this session].
- **Weft real adapter config [I]:** `WEFT_WORKDAY_HOST`, `WEFT_WORKDAY_TENANT`, `WEFT_WORKDAY_CLIENT_ID`, `WEFT_WORKDAY_CLIENT_SECRET`, `WEFT_WORKDAY_REFRESH_TOKEN`, optionally `WEFT_WORKDAY_TOKEN_URL` (taken from View API Clients). All of them live in the secrets file.

### 2.3 Workday operations Weft needs (from the published specs)

**SOAP `Human_Resources` / `Staffing` `Get_Workers`** [V, Human_Resources.wsdl v47.0]:

- `Worker_Request_Criteria` includes `Transaction_Log_Criteria_Data`. Its type `Transaction_Log_CriteriaType` holds `Transaction_Date_Range_Data` (`Updated_From`, `Updated_Through`, `Effective_From`, `Effective_Through`), `Transaction_Type_References` and `Subscriber_Reference`. Other criteria: `Organization_Reference`, `Exclude_Inactive_Workers`, `Exclude_Contingent_Workers`.
- `Response_Filter` has `As_Of_Effective_Date`, `As_Of_Entry_DateTime`, `Page`, `Count`.
- `Worker_Response_Group` flags (subset): `Include_Personal_Information`, `Include_Employment_Information`, `Include_Compensation`, `Include_Organizations`, `Include_Management_Chain_Data`, `Include_Transaction_Log_Data`, `Include_Benefit_Enrollments`, `Include_User_Account`, `Include_Background_Check_Data`.
- `Worker_Data` holds `Worker_ID`, `User_ID`, `Universal_ID`, `Personal_Data`, `Employment_Data`, `Compensation_Data`, `Organization_Data`, `Management_Chain_Data`, `Transaction_Log_Entry_Data`, and more.
- Compensation: `Employee_Base_Pay_Plan_Assignment_Data` has `Compensation_Plan_Reference`, `Amount`, `Currency_Reference`, `Frequency_Reference`, `Assignment_Effective_Date`.
- **This is the incremental worker sync primitive** [I]. Poll with `Updated_From = lastCursor`, `Updated_Through = now`, and `Include_Transaction_Log_Data`.

**Other SOAP operations** [V, operation lists]:

- Staffing writes: `Hire_Employee`, `Change_Job`, `Terminate_Employee` (as `Import_Terminate_Employee` in Staffing), `Put_Applicant`, `Get_Positions`.
- Human_Resources reads: `Get_Organizations`, `Get_Locations`, `Get_Job_Profiles`, `Get_Holiday_Calendars`.
- Human_Resources write: `Change_Background_Check_Status`, which matters for the HireRight and Checkr file.

**SOAP `Absence_Management`** [V, Absence_Management.wsdl v47.0]:

- Operations: `Enter_Time_Off`, `Adjust_Time_Off`, `Get_Time_Off_Plan_Balances`, `Request_Leave_of_Absence`, `Request_Return_from_Leave_of_Absence`, `Import_Time_Off_Request_Event_Batch`, `Get_Absence_Inputs`, `Put_Absence_Input`, `Put_Override_Balance`.
- `Enter_Time_Off_Data` takes `Worker_Reference` and `Enter_Time_Off_Entry_Data[]`. Each entry is `Date`, `Start_Time`, `End_Time`, `Requested`, `Time_Off_Type_Reference`, `Time_Off_Reason_Reference`, `Comment`, plus worktags.
- `Business_Process_Parameters` carries `Auto_Complete`, `Run_Now`, `Comment_Data`.

**REST `absenceManagement/v5`** [V, absenceManagement_v5_20261003_oas2.json; basePath `/absenceManagement/v5`; security OAuth2]:

- Endpoints:
  - `GET /workers`, `GET /workers/{ID}`
  - `GET /workers/{ID}/eligibleAbsenceTypes`, `GET /workers/{ID}/validTimeOffDates`
  - `POST /workers/{ID}/requestTimeOff`, `POST /workers/{ID}/correctTimeOffEntry`
  - `GET /workers/{ID}/timeOffDetails` with `fromDate`, `toDate`, `status[]`, `timeOffType[]`, `limit`, `offset`
  - `GET /workers/{ID}/leavesOfAbsence`
  - `GET /balances` with `worker`, `category`, `effective`
  - `GET /values/timeOff/status/`, `GET /values/leave/status/`
- The spec documents the request flow as three steps: eligibleAbsenceTypes, then validTimeOffDates, then requestTimeOff [V, operation description].
- `requestTimeOff` body: `{ days: [{date, start, end, dailyQuantity, timeOffType:{id}, reason:{id}, comment, position:{id}}], businessProcessParameters: {...} }`, plus header `wd-warning-action`.
- `timeOffDetails` item: `{timeOffEntryId, date, quantity, unit{id,descriptor}, timeOffType{id,descriptor}, status{id,descriptor}, reason, comment, worker{id,descriptor,href}, position, timeOffEventId, worktags}`.
- `balances` item: `{worker, absencePlan{id,descriptor}, quantity, unit, effectiveDate, category, position, dateOfFirstAbsence}`.

**REST conventions** [S, REST fundamentals page; V, specs]:

- Collections are `{ total, data: [] }`. Paging is `limit` (default 20, **max 100**) and `offset`.
- Every reference is `{id (WID, 32 chars), descriptor, href}`. Reference ids use `Employee_ID=21005` style, and `me` means the current user.
- No rate limits are documented [S].

**Gap worth knowing [V]:** REST `common/v1` `GET /workers` takes only `search`, `limit`, `offset` and `includeTerminatedWorkers`, with **no updated-since filter**. So incremental sync uses SOAP `Get_Workers` with the transaction log, or a RaaS report.

**REST `businessProcess/v1`** [V]: `GET /events`, `GET /events/{ID}`, `GET /events/{ID}/remainingSteps`, `POST /eventSteps/{ID}/approve | deny | sendBack`, `POST /events/{ID}/cancel | rescind`. Weft could read the status of a Workday time-off request it submitted.

**SOAP `Payroll_Interface`** [V, Payroll_Interface.wsdl; its documentation says it exposes data "for integration with external payroll systems"]:

- Operations: `Get_Payees`, `Get_Worker_Effective_Change_Integration_Systems`, `Get_External_Payroll_Inputs`, `Get_External_Payroll_Earnings`, `Get_External_Payroll_Deductions`, `Get_Period_Schedules`, `Get_External_Pay_Groups`, `Import_External_Payroll_Results`, `Put_External_Payroll_Actuals`, `Import_External_Payroll_Document`, `Get_Worker_Costing_Allocations`.
- This is the native seam for "Workday HCM, third-party payroll" [I]. The Weft connector reads payees and inputs, and writes payroll results back as one proposal per run.

### 2.4 Workday: free version, terms, what Nitish must do

- **Free path: the Workday Developer Program (open access beta)** [S]:
  - Join "with a personal email" at https://developer.workday.com (https://blog.workday.com/en-us/workday-open-developer-platform-generally-available.html).
  - Request 1 development tenant (Console > Tenants > +). Sign-in details arrive by email in "about 15 minutes".
  - The tenant expires after 7 days without a login. You can have only 1 active tenant, and at most 2 within 6 hours (https://developer.workday.com/doc/GUID-4f875963-a845-43b5-868a-0f77e6261eb7-enHYPHENus.md).
  - **Not stated:** cost, sample data, and whether HCM SOAP, REST absence and RaaS work there.
  - The site's robots.txt disallows `/terms/`, so I did not read the developer terms. Nitish should read them at sign-up for any limits on open-source or commercial use.
- **Classic path:** Workday's partner page says tenant and sandbox access is not given outside a formal partnership [3P summary of https://workday.com/en-us/company/partners/become-a-partner.html; the current page, partner-program-overview.html, says nothing about tenants]. Customers get sandboxes with their subscription [3P].
- **Specs licensing:** the WSDLs and REST OAS files are publicly downloadable without login [V]. Their license is not stated on the directory. **Do not vendor them into the repo** [I]. Write the simulator from field names, which are facts, in Weft's own code. Keep any downloaded spec in a gitignored scratch folder.
- **What Nitish would do himself:**
  1. Sign up at developer.workday.com with a personal email and read the developer terms himself.
  2. Request a development tenant. Log in at least once a week or it expires.
  3. In the tenant, register an API client for integrations: functional-area scopes Staffing, Time Off and Leave, Compensation, Organizations and Roles, Payroll Interface (if offered), and enable non-expiring refresh tokens if allowed. Create an ISU and generate a refresh token for it.
  4. Put host, tenant, client id, client secret, refresh token and token URL into `~/Developer/projects/.weft.secrets.env`.
  5. Optionally create a custom report enabled as a web service, "Workers updated since", with a prompt.
  6. Tell the builder which REST and SOAP services the tenant actually exposes. The connection test reports this too.

### 2.5 Workday time off: system of record or downstream target

| Mode | When | Who owns balances and approvals | What Weft does |
|---|---|---|---|
| **Workday is SoR (recommended when connected)** | Customer runs Workday Absence | Workday | Poll `timeOffDetails` (status approved) and `balances` per worker per pay period. Map approved hours to payroll inputs: unpaid leave reduces pay, paid time off coded as PTO earnings. Requests made in Weft become a proposal "Submit time off request to Workday" (REST `requestTimeOff`). Approval happens in Workday's business process; Weft shows the BP status from `businessProcess/v1`. |
| **Weft is SoR (default, no Workday)** | Everyone else, and the Larkspur demo | Weft Time Off (wave 3 goal 2) | Native policies, accruals and approvals. No Workday calls. |
| **Weft SoR, Workday downstream** | Rare (Workday for analytics only) | Weft | After approval in Weft, a proposal pushes `Enter_Time_Off` (SOAP) with `Auto_Complete=true`. P2. |

**Rule [I]:** one owner per company per domain, stored as `integration_ownership {domain: "people" | "compensation" | "time_off", owner: "weft" | "workday"}`.

- When the owner is Workday, Weft UI edits on owned fields are disabled with the copy "Managed in Workday". The agent's write tools for those fields refuse with `NOT_PERMITTED` and the reason `owned_by_integration`.

### 2.6 Workday change notifications

- No generic signed webhook exists in the public REST specs [V: no webhook service among the 89 REST service versions the directory bundle references (the only name containing "event" is benefitEnrollmentEventOfferings), see `services2026.41.json`].
- Outbound notifications for business events such as Hire and Termination exist through tenant configuration. Global Payroll Connect describes "Event Outbound Notifications" to a vendor endpoint with an X509 key pair [3P, https://doc.workday.com/workday-education/en-us/course-manuals/creating-integrations-using-global-payroll-connect/global-payroll-connect.html]. Forums describe outbound messaging as a real-time notify, after which the receiver queries the API [3P, https://connect.hyland.com/t5/alfresco-forum/where-i-can-find-outbound-messaging-services-of-workday/m-p/15631].
- **Weft design [I]:**
  - Polling is the contract: every 15 minutes in real mode, plus a manual "Sync now".
  - An optional inbound endpoint `/v1/integrations/workday/notify` accepts a nudge. It is authenticated with a shared secret header, or mTLS later. Its only effect is to schedule an immediate poll; the body is never parsed into domain data.

---

## 3. Weft design

### 3.1 One connector contract, two modes

Put it in `packages/contracts/src/integrations.ts` (new) [I]. Use the same pattern as `sim.ts`: interfaces in contracts, simulators in `packages/sim`, real adapters in a new `packages/integrations` that is the only place doing outbound HTTP to vendors. This keeps the brain and hands split: `packages/agent` never imports it (SPEC 2 import-scan rule (1) should add `@weft/integrations`).

```ts
export type IntegrationVendor = "greenhouse" | "workday";      // wave 3 adds hireright, checkr, docusign in the other file
export type ConnectorMode = "simulated" | "real";
export interface ConnectorStatus {
  vendor: IntegrationVendor; mode: ConnectorMode;              // UI label: "Simulated" or "Connected"
  configured: boolean;                                          // real credentials present in WEFT_SECRETS_FILE
  lastSyncAt: string | null; cursor: string | null;             // vendor cursor or updated_since watermark
  health: "ok" | "auth_failed" | "rate_limited" | "permission_gap" | "unreachable";
  detail: string | null;                                        // structured, never vendor free text
}
export interface SyncPage<T> { items: T[]; nextCursor: string | null; rateLimit: { remaining: number | null; resetAt: string | null } }

export interface AtsConnector {                                 // Greenhouse
  status(): Promise<ConnectorStatus>;
  testConnection(): Promise<ConnectorStatus>;                   // reads 1 application + 1 offer; flags empty-offers permission gap
  listHires(q: { updatedAfter: string | null; cursor: string | null }): Promise<SyncPage<AtsHire>>;
  getHire(applicationId: string): Promise<AtsHire | null>;      // application + current offer + candidate + job, normalized
  listJobs(q: { cursor: string | null }): Promise<SyncPage<AtsJob>>;
  verifyWebhook(raw: Uint8Array, headers: Record<string, string>): { ok: boolean; deliveryId: string | null };
  parseWebhook(raw: Uint8Array): { action: string; applicationId: string | null } | null;   // ids only
  markHired(req: { applicationId: string; startDate: string; openingId: string | null; credential: string }): Promise<{ ok: true }>;  // write, proposal-only
}
export interface HrisConnector {                                // Workday
  status(): Promise<ConnectorStatus>;
  testConnection(): Promise<ConnectorStatus & { services: string[] }>;
  listChangedWorkers(q: { updatedFrom: string; updatedThrough: string; page: number }): Promise<SyncPage<HrisWorker>>;
  listOrganizations(q: { cursor: string | null }): Promise<SyncPage<HrisOrg>>;
  listTimeOff(q: { workerRef: string; from: string; to: string; status: "approved" | "all" }): Promise<SyncPage<HrisTimeOffEntry>>;
  listBalances(q: { workerRef: string; asOf: string }): Promise<SyncPage<HrisBalance>>;
  requestTimeOff(req: { workerRef: string; days: { date: string; quantity: number; typeRef: string; reasonRef: string | null }[]; credential: string }): Promise<{ eventRef: string; status: string }>;  // proposal-only
  importPayrollResults(req: { payrollRunId: string; credential: string }): Promise<{ batchRef: string }>;                                 // proposal-only, P1
}
```

- **Mode selection** [I]: `real` only when every required key for that vendor resolves from `WEFT_SECRETS_FILE` **and** `WEFT_INTEGRATIONS_REAL=1`. Otherwise `simulated`. Tests force `simulated`; the factory throws `LIVE_INTEGRATION_IN_TEST`, mirroring `LIVE_PROVIDER_IN_TEST`.
- **Simulators** follow SPEC 8: `sim_*` tables, SimClock, seeded RNG, fault check before each call.
  - Fault targets: `greenhouse.listHires`, `greenhouse.rateLimit`, `greenhouse.webhook`, `workday.getWorkers`, `workday.requestTimeOff`.
  - They store vault names, never credentials.
- **Simulator fidelity** [I]:
  - Greenhouse: bare arrays, `Link rel="next"` cursor, X-RateLimit headers, the 30 s window, versioned offers with `current_only`, the `custom_fields.salary {amount, unit}` currency shape, `starts_on` vs webhook `starts_at`, signed `hire_candidate` deliveries (`Signature: sha256 <hex>` over the raw body), the 7-attempt retry schedule driven by the SimClock, and the empty-offers permission gap as a fault.
  - Workday: `{total, data}` envelopes, `limit` capped at 100, `{id, descriptor, href}` references with 32-char hex WIDs, the three-step time-off request flow, BP status values, and `Updated_From` / `Updated_Through` semantics.
- **Seed** [I]: the fictional Larkspur Robotics Greenhouse account and Workday tenant, with fictional names only.
  - Greenhouse: 3 open jobs, 2 hired applications with accepted offers, one of them with an offer `version: 2` after a start-date change.
  - Workday (for the "Workday is SoR" demo company variant): 48 workers matching the seed and 6 time-off entries.

### 3.2 Flows

**F1. Greenhouse hire to Weft offer and onboarding (the hero flow)**

1. Trigger:
   - Real: a `hire_candidate` webhook or the 15-minute poll (`applications?status=hired&updated_at[gt]=watermark`).
   - Sim: the demo control "Simulate a hire in Greenhouse".
2. Webhook handler steps:
   - Verify the HMAC over the raw bytes and dedupe on `Greenhouse-Event-ID` (table `integration_deliveries`, unique).
   - Return 200 fast. Emit `integration.ats_hire_detected {vendor, application_ref}`, ids only.
3. System command `integrations.record_ats_hire` (system_only, R1):
   - Re-reads the hire through `getHire`.
   - Upserts `ext_links {vendor, ext_type:"application", ext_id, weft_type:"offer", weft_id}`.
   - Creates a Weft **offer in `draft`** with `source: greenhouse:<application_id>:v<offer_version>`, then emits `offer.imported`.
4. Routine `rt_ats_hire` runs on `offer.imported`. It is proposal-heavy:
   - The agent checks the work state against tax registrations and the department mapping.
   - It flags gaps such as an unknown office or missing salary.
   - It proposes `offers.send` (existing wave 2 lifecycle), so a human approves before the candidate gets the Weft portal invite.
5. From there the existing GP6 to GP8 path (portal, e-sign, documents, `offer.accepted`, onboarding checklist, `rt_new_hire`) runs unchanged.

**Idempotency** [I]:

- `(vendor, application_id)` maps to one Weft offer.
- A later offer `version` or an `offer_updated` event changes the start date or salary on a draft or sent offer. That creates a **sync conflict item** in the Inbox ("Greenhouse changed the start date from 2026-11-02 to 2026-11-09. Apply?"); Weft never overwrites silently.
- `unhire_candidate` makes a proposal to void the Weft offer if it is not yet accepted. If it is accepted, it raises an Inbox item.

**F2. Workday worker sync** (Workday is SoR; P1 behind the simulator)

1. A poll every 15 minutes calls `Get_Workers` with the transaction log window (`Updated_From = watermark`, `Updated_Through = now - 2 min` to absorb clock skew), paging through `Page` and `Count`.
2. Each changed worker is upserted into the people mirror through system command `integrations.apply_hris_change` (system_only, R1). It writes only Workday-owned fields.
3. A **pay-affecting change** (a compensation amount or frequency change, a termination, a work state change) is not applied silently to an open payroll draft. It emits `people.external_change {worker_id, fields[]}`.
4. The existing pre-payroll anomaly rules (SPEC 7.5) pick that up as evidence on the flagged row.

**F3. Workday time off to payroll** (Workday is SoR)

1. Before each pay run preview, pull approved `timeOffDetails` for the period, plus `balances`.
2. Map the entries into Weft time-off entries marked `source: workday`, read-only in the UI.
3. Payroll consumes them exactly like native entries. That keeps one code path: the wave 3 Time Off builder owns the native model, and this connector just fills it.

**F4. Weft payroll results to Workday** (P2): one proposal per processed run through `Import_External_Payroll_Results`.

### 3.3 Data mapping tables

**Greenhouse to Weft offer** (Weft `Offer` in `packages/contracts/src/domain.ts`):

| Weft field | Greenhouse source | Notes |
|---|---|---|
| `candidateFirst`, `candidateLast` | `candidate.first_name`, `last_name` (prefer `preferred_name` for display only) | untrustedFields (candidate-entered) |
| `candidateEmail` | `candidate.email_addresses[]`, first with `type: "personal"`, else the first | untrusted; the sim uses `*.example` addresses only |
| `title` | `jobs[0].name` | Job name, recruiter-entered: trusted-ish, but still wrap |
| `departmentId` | `jobs[0].departments[0].{id,name,external_id}` through the `ext_links` department map | Unmapped: Inbox "Map Greenhouse department X" |
| `workplaceId`, `workState` | `jobs[0].offices[0].{name,location,external_id}` through the office map | `location` may be null; the state must be resolved before the offer can be sent |
| `managerId` | Not in the hire payload; job hiring team via `/v3/job_hiring_managers` | Optional; else null |
| `base`, `payKind` | `offer.custom_fields` of `type: "currency"` → `{amount, unit}` | Field key is customer-defined. A per-company setting `greenhouse.salary_field_key` is required. `unit` must equal the company currency, else block. Amount is in major units (80000 means $80,000), so convert to cents |
| `payKind` | Job custom field `employment_type` (e.g. "Full-time") plus an hourly flag field | Default `salary`; an hourly needs a mapped field |
| `startDate` | v3 `offer.starts_on` / webhook `offer.starts_at` / `hire.start_date` | Normalize to `YYYY-MM-DD` in the company timezone |
| `status` | Always `draft` on import | A human sends it |
| provenance | `application.id`, `offer.id`, `offer.version`, `candidate.id` | Stored in `ext_links`, not on the offer |

**Workday to Weft worker** (Weft `Worker`):

| Weft field | Workday source (SOAP `Worker_Data` / REST) | Owner when connected |
|---|---|---|
| external key | `Worker_ID` (Employee_ID) and WID | Workday |
| `firstName`, `lastName`, `displayName` | `Personal_Data.Name_Data` | Workday |
| `workEmail` | `Personal_Data.Contact_Data` (work) / REST `primaryWorkEmail` | Workday |
| `title` | `Employment_Data.Worker_Job_Data.Position_Data` business title / REST `businessTitle` | Workday |
| `departmentId` | `Organization_Data` (supervisory org) / REST `primarySupervisoryOrganization` | Workday |
| `managerId` | `Management_Chain_Data` | Workday |
| `workplaceId`, `workState` | Position location (`Get_Locations` for address and state) | Workday |
| `startDate`, `endDate`, `status` | Employment data hire and termination dates | Workday |
| pay rate | `Compensation_Data` → `Employee_Base_Pay_Plan_Assignment_Data {Amount, Currency_Reference, Frequency_Reference, Assignment_Effective_Date}` | Workday; Weft `set_pay_rate` is disabled |
| W-4, state withholding, bank account | Not synced in v1 (Workday Payroll Interface carries some) | Weft (employee self-service in the portal) |
| `payScheduleId` | `Get_External_Pay_Groups` / pay group on the worker | Weft maps pay group to schedule once |

**Workday to Weft time off entry:**

| Weft field | Workday REST `timeOffDetails` | Notes |
|---|---|---|
| external key | `timeOffEntryId` | Idempotent upsert |
| `workerId` | `worker.id` through `ext_links` | |
| `date`, `quantity`, `unit` | `date`, `quantity`, `unit.descriptor` (Hours/Days) | Convert days to hours with the worker's scheduled hours |
| `type` | `timeOffType.{id,descriptor}` through the per-company type map (PTO, Sick, Unpaid) | Unmapped type: Inbox item; payroll blocks for that worker |
| `status` | `status.descriptor` | Only approved entries feed payroll |
| comment | `comment` | **untrustedFields** (employee-entered) |

### 3.4 Sync conflicts

- **Field ownership is static per domain** (2.5). Conflicts occur only when the non-owner has a pending local change, or when the owner changes something a human already acted on, such as a sent offer.
- **Detection:** keep `ext_snapshots {vendor, ext_id, field, value_hash, seen_at}`. On sync, compare the incoming value with the last snapshot, and the local value with the snapshot taken at last apply.

| Case | Resolution |
|---|---|
| Owner changed, local unchanged | Apply silently through the system command; audit row |
| Owner changed, local also changed (or the offer is already sent) | Inbox item `sync_conflict` with both values and two actions, "Keep Weft value" and "Take Greenhouse/Workday value", human only |
| Owner deleted the record (`delete_candidate`, `candidate_anonymized`, Workday termination) | Never hard-delete. Mark the `ext_links` row as orphaned and raise an Inbox item. For anonymization, also null the mirrored candidate PII on unaccepted offers |
| Merge (`merge_candidate`) | Re-point `ext_links` to the surviving candidate id after re-read |

- **Payroll safety:** sync never mutates a payroll run in `pending_approval` or later. Changes land in the next draft, and the anomaly flag explains them.

### 3.5 Webhook handling (generic; reuse for DocuSign Connect and Checkr later)

- Route: `POST /v1/integrations/{vendor}/webhook`. Read the raw body before JSON parsing. Limit the size to 1 MB. Compare signatures in constant time.
- **Return 200 only after the delivery row is durably stored.** Return 401 on a bad signature (the sender will retry, which is fine). Return 200 on a duplicate `Greenhouse-Event-ID`.
- Store `integration_deliveries {vendor, delivery_id, action, received_at, verified, processed_at, error}`. **Do not store the body** beyond ids: it contains candidate PII, and the record is re-read from the API.
- Event payloads stay id-only, so triggers do not taint (SPEC 9.3).
- Ping deliveries are acknowledged and recorded.
- The simulator delivers to the same route in-process with a valid signature. The fault `greenhouse.webhook` makes the receiver "fail", so the SimClock-driven retry schedule can be demoed.

### 3.6 What the agent may do

- **Reads (R0/R1, allowed on chat and MCP allowlists):**
  - `integrations.status`
  - `integrations.list_sync_items`, which lists pending conflicts and unmapped values.
  - `ats.get_hire`, concise, with candidate fields wrapped untrusted.
  - `hris.get_worker_external`, which compares Weft and Workday values.
  - `hris.list_time_off`.
- **Writes, all through proposals:**
  - `integrations.map_value` (department, office or time-off type) is R2. It is proposed to a human because a wrong map misroutes taxes.
  - `ats.mark_hired` is R3, `always`.
  - `hris.request_time_off` is R3, `always`; the headline is built from structured fields only.
  - `hris.import_payroll_results` is R4, `always`, with the run's subject hash.
  - Resolving a sync conflict is **human only**, not a tool.
  - `integrations.sync_now` is R1. It only schedules a poll and is allowed for the main agent.
- **Taint:**
  - Declare as `untrustedFields`: candidate names, emails, addresses, application `answers`, candidate custom fields, Workday time-off comments, and any vendor error text.
  - Job and department names are recruiter or admin entered, but still come from outside: wrap them, and do not taint on them alone.
  - Any run that reads untrusted integration fields is tainted, so its writes can only be proposals (already the rule).
- **Tool cap:** a new routine `rt_ats_hire` gets 8 tools at most, on its own allowlist: `ats.get_hire`, `people.search`, `tax.list_registrations`, `integrations.list_sync_items`, `integrations.map_value`, `onboarding.get_checklist`, `comms.send_message`, `comms.post_update`. Add the read tools to the chat allowlist only if it stays at 16 or fewer: swap one or two in, or give integrations its own chat agent kind.

### 3.7 UI copy (Weft's own words; names used nominatively, no logos)

- Settings > Integrations card: "Greenhouse" with the badge **Simulated** or **Connected**. Body: "Bring hired candidates into Weft as draft offers." Button: "Connect Greenhouse". Hint: "Add credentials to your secrets file, then restart. Weft never stores them in the database."
- Workday card body: "Keep people, pay and time off in sync when Workday is your HR system of record." Toggle: "Workday owns: People, Compensation, Time off".
- Every simulated screen shows the existing simulator label pattern: "Greenhouse (sim)", "Workday (sim)".

---

## 4. Recommended decisions

1. Build Greenhouse against **Harvest v3 only**. v1/v2 were removed on 2026-08-31, per Greenhouse.
2. **One connector contract with two modes**, interfaces in `@weft/contracts`, simulators in `@weft/sim`, real adapters in a new `@weft/integrations` that the agent package cannot import. Real mode requires secrets **and** `WEFT_INTEGRATIONS_REAL=1`. Tests throw on real mode.
3. **The Greenhouse hire creates a draft Weft offer** (system command, then `offer.imported`, then the `rt_ats_hire` routine that proposes sending). It does not create a worker directly. That reuses the wave 2 offer, portal and onboarding chain unchanged.
4. **Webhooks are nudges.** Verify the HMAC over the raw bytes, dedupe on the delivery id, persist ids only, then re-read from the API. Polling every 15 minutes is the baseline because local Weft cannot receive webhooks (Greenhouse port allowlist, no public URL).
5. **Workday real mode is P1 behind a complete simulator.** The free path is the Developer Program's personal tenant (beta, expires after 7 idle days), which Nitish must sign up for himself. Build and test the simulator first.
6. **Workday role: system of record upstream of Weft payroll** (worker sync, compensation, approved time off in). Writes back are proposals: time-off requests now, payroll results P2. Use SOAP `Get_Workers` with the transaction log for incremental sync, because REST workers has no updated-since filter.
7. **Field ownership is per domain**, with "Managed in Workday" locks. Conflicts go to the Inbox as human-only decisions. Sync never touches a payroll run past draft.
8. **Time Off has one native model** (wave 3 goal 2). Workday is just another source filling it (`source: workday`, read-only), so payroll has one code path.
9. **Show the Greenhouse public job board as real mode with zero credentials** (read-only open roles). Tests use a hand-written Larkspur fixture; one opt-in live smoke test only.
10. **Do not vendor Workday WSDL/OAS or Greenhouse OpenAPI files into the repo.** Their license is unstated. Write the simulators from field names in our own code.
11. **Skip the Greenhouse Onboarding API (P2).** Weft is the onboarding product.

## 5. Open questions for the architect

- Does the chat allowlist absorb the integrations read tools (cap 16), or do integrations get their own agent kind?
- Which salary custom-field key does the simulator use? Proposal: `salary` (the `currency` type), matching Greenhouse's own example.
- Should `ext_links` and `integration_deliveries` be domain tables (audited) or `sim_`-like infrastructure tables? Recommendation: domain tables, written only by system commands.
- Workday demo: is it a second seeded company ("Larkspur on Workday") or a toggle on Larkspur? A toggle is simpler to demo, but it must reseed ownership.

## 6. Sources

- Greenhouse Harvest v1/v2 (deprecation date, v1 rate limits, On-Behalf-Of): https://docs.greenhouse.io/harvest.html (301 from developers.greenhouse.io/harvest.html)
- Harvest v3 index: https://harvestdocs.greenhouse.io/ and https://harvestdocs.greenhouse.io/llms.txt
- v3 auth: https://harvestdocs.greenhouse.io/docs/authentication.md
- v3 rate limits: https://harvestdocs.greenhouse.io/docs/api-rate-limiting.md
- v3 paging: https://harvestdocs.greenhouse.io/docs/pagination.md
- Partner OAuth: https://harvestdocs.greenhouse.io/docs/harvest-partner-oauth.md
- Write migration guide: https://harvestdocs.greenhouse.io/docs/write-endpoint-migration-guide.md
- v3 references (each embeds OpenAPI 3.1.0): `https://harvestdocs.greenhouse.io/reference/{get_v3-offers, post_v3-offers, patch_v3-offers-id, get_v3-applications, post_v3-applications-id-hire, get_v3-candidates, post_v3-webhooks, get_v3-webhooks}.md`
- Webhooks: https://docs.greenhouse.io/webhooks.html
- Job Board API: https://docs.greenhouse.io/job-board.html; live GETs to `boards-api.greenhouse.io/v1/boards/cloudflare/jobs?content=false` and `/jobs/7695702?questions=true` on 2026-10-16
- Onboarding API: https://docs.greenhouse.io/gho.html
- Sandbox: https://support.greenhouse.io/hc/en-us/articles/17053185557787-Use-a-sandbox; [3P] https://docs.unified.to/sandboxes
- MSA: https://www.greenhouse.com/master-subscription-agreement
- Workday WWS directory v47.0: https://community.workday.com/sites/default/files/file-hosting/productionapi/index.html; WSDLs downloaded: Human_Resources, Staffing, Absence_Management, Compensation, Payroll_Interface (v47.0)
- Workday REST directory: https://community.workday.com/sites/default/files/file-hosting/restapi/index.html, `services2026.41.json`, OAS2 files `{absenceManagement_v5, staffing_v7, common_v1, businessProcess_v1, compensation_v3}_20261003_oas2.json`
- Workday developer docs index: https://developer.workday.com/llms.txt
- REST fundamentals: https://developer.workday.com/doc/GUID-85810465-bcfb-4fdf-a26d-55eaff3968a8-enHYPHENus.md
- REST auth: https://developer.workday.com/doc/GUID-6c598444-ce67-40d5-bd95-267ecfe439b8-enHYPHENus.md
- Create API client: https://developer.workday.com/doc/zwx1518028675482.md
- Refresh token: https://developer.workday.com/doc/cqa1553122177664.md
- RaaS: https://developer.workday.com/doc/hto1529968349582.md and https://developer.workday.com/doc/GUID-bd5c7437-7ad2-4917-8dfa-cf886aa22ff2.md
- Integration events: https://developer.workday.com/doc/GUID-2ef86f32-ceee-489d-83f8-e05b09071bc3.md
- Personal development tenants: https://developer.workday.com/doc/GUID-4f875963-a845-43b5-868a-0f77e6261eb7-enHYPHENus.md
- Developer program announcement: https://blog.workday.com/en-us/workday-open-developer-platform-generally-available.html
- Partner program: https://www.workday.com/en-us/company/partners/partner-program-overview.html
- [3P] Workday tenant OAuth setup: https://nango.dev/docs/api-integrations/workday-refresh-token/connect, https://help.merge.dev/en/articles/9891389-workday-how-do-i-link-using-oauth
- [3P] Workday outbound notifications: https://doc.workday.com/workday-education/en-us/course-manuals/creating-integrations-using-global-payroll-connect/global-payroll-connect.html, https://connect.hyland.com/t5/alfresco-forum/where-i-can-find-outbound-messaging-services-of-workday/m-p/15631
- Weft context: `SPEC.md` sections 8, 9.2 and 9.3; `docs/simulators.md`; `packages/contracts/src/sim.ts`; `packages/contracts/src/domain.ts` (Offer, Worker); `research/product.md:149` (Workday listed as coming soon in the reference product)
