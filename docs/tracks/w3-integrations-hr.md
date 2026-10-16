# Track w3-integrations-hr: connector framework, Greenhouse, Workday, the Integrations screen

Wave 3 goal 3 (docs/wave3.md section 3). Research: `research/wave3/integrations-hr.md`. Branch `track/w3-integrations-hr`.

## How to run it

- Tests: `pnpm test` covers everything below. The track's own files are:
  - `packages/sim/test/vendors/greenhouse.test.ts` and `packages/sim/test/vendors/workday.test.ts`
  - `packages/integrations/test/{board,overlay,mode,real-greenhouse}.test.ts`
  - `apps/api/test/integrations.test.ts`
  - `tests/scenarios/gp17-greenhouse-hire.test.ts` and `tests/scenarios/gp17-workday-sync.test.ts`
- E2E: `WEFT_E2E_WEB_PORT=4700 WEFT_E2E_API_PORT=4701 pnpm e2e e2e/gp17-greenhouse-hire.spec.ts`. The spec holds two
  tests: the Greenhouse hire and the Workday sync.
- In the app: open Integrations (`/app/integrations`).
  - Greenhouse card: "Simulate a hire", "Change the start date", "Resend the last delivery".
  - Workday card: "Sync now" first. Then "Promote someone in Workday" or "Approve two days off", and Sync now again.
    The 15-minute poll also applies Workday changes on its own once Workday has been synced.
- Live public smoke (opt-in, one read of a public board): `WEFT_LIVE_PUBLIC=1 pnpm vitest run packages/integrations/test/board.test.ts`.

## Real versus simulated

| Vendor | Simulated (default, always in tests) | Real |
|---|---|---|
| Greenhouse | Harvest v3 shapes, signed webhooks, demo controls | Read-only Harvest v3 adapter, built and tested on a fake transport only. It runs only with `WEFT_INTEGRATIONS_REAL=1` and both client secrets in the secrets file. |
| Workday | Workday REST and Get_Workers shapes, the time-off flow, demo controls | Stub (returns null, so the simulator stays). See left.md. |
| Checkr, HireRight, DocuSign | Owned by w3-integrations-screening-esign | Owned by w3-integrations-screening-esign |

- Mode is per vendor. `integrationMode()` is real only when `WEFT_INTEGRATIONS_REAL=1` and every required secret
  resolves from `WEFT_SECRETS_FILE`. Inside a test it throws `LIVE_INTEGRATION_IN_TEST`.
- Secret values are read only by `readSecret` inside an adapter. The cards, the API and the logs show names with
  present or missing, never a value. Tests assert this for every integrations route and for adapter error text.
- No account was created, no terms were accepted and no credential was entered anywhere. No vendor spec file is
  vendored; the simulators follow field names from the research.

## What exists

### Framework (round 1)

- `POST /v1/integrations/:vendor/webhook` is public. It reads the raw body with a 1 MB cap (413). The vendor
  connector verifies the signature over the raw bytes in constant time (401 otherwise).
- Deliveries are deduped on the delivery id in `integration_deliveries`, which holds ids and a sha256 of the body,
  never the body. The route answers 200 only after `integrations.record_delivery` (svc_events) stored the row.
- Greenhouse deliveries emit `integration.ats_hire_detected` (ids only). The handler re-reads the hire through
  `integrations.record_ats_hire`.
- Screening and e-signature vendors get `VENDOR_APPLY_COMMAND` with ids-only `W3VendorApplyArgs`.
- `apps/api/src/integrations/poll.ts` runs on every scheduler tick:
  - It delivers due simulated webhooks in process, through the same receiver as the public route. The
    `greenhouse.webhook` fault makes a delivery retry on the 7-attempt sim-clock schedule.
  - It syncs Greenhouse every 15 sim minutes, and Workday every 15 sim minutes once Workday has been synced. Each
    sync runs only when there is something to read, so the seed, the demo and the older tests see no new action rows.

### Greenhouse simulator and the hero flow (round 1)

- The simulator follows Harvest v3:
  - bare arrays sorted by id descending
  - an opaque `Link rel="next"` cursor that must be the only query parameter
  - `per_page` from 1 to 500, `X-RateLimit-*` headers, and a 429 with `Retry-After` under `greenhouse.rateLimit`
  - versioned offers with `current_only`, and the salary custom field
  - signed `hire_candidate` and `offer_updated` deliveries with the vendor's escaping
  - the `greenhouse.offersHidden` permission gap
- GP17: a simulated hire becomes exactly one draft offer, linked in `ext_links`, and emits `offer.imported`.
  - The unmapped Boulder office opens an `unmapped_value` item.
  - `rt_ats_hire` proposes `documents.send_offer`, and GP6 runs unchanged after Dana approves.
  - A duplicate delivery is a no-op.
  - Offer version 2 with a new start date opens a human-only `sync_conflict`.

### Workday simulator and sync (round 2)

- `packages/sim/src/vendors/workday.ts`:
  - `{ total, data }` collections, with `limit` at most 100 and `offset`
  - `{ id, descriptor, href }` references with 32-character hex WIDs
  - `Get_Workers` over the transaction log window, inclusive at both ends, with `Response_Results` paging
  - the three-step time-off flow: eligible types, then valid dates, then `requestTimeOff`. That opens a business
    process In Progress with Submitted entries; the manager's approval makes them Approved.
  - balances, and the `workday.getWorkers` and `workday.requestTimeOff` faults
- The seed builds the fictional tenant from the seeded employees: same work email, title, state and pay, so the first
  sync has no conflict. The Workday connection row carries the absence type map read from the tenant.
- `integrations.sync_now { vendor: "workday" }` detects:
  - workers that are new to Weft, or whose Workday-owned values differ from the last snapshot
  - linked workers with approved time off Weft has not imported

  Detection compares content, not timestamps, so a frozen sim clock misses nothing.
- `integrations.apply_hris_change` (system only, svc_events) re-reads those workers and:
  - links each one to the Weft worker with the same work email, or opens an `unmapped_value` item
  - applies a changed title when the Weft value is unchanged since the last apply, and otherwise opens a conflict
  - never applies a pay-affecting change (base pay, work state, termination) silently. It opens a human-only
    `sync_conflict` and emits `people.external_change`.
  - imports each approved entry as one approved `time_off_requests` row, with `source = workday`, `ext_ref` set to the
    entry WID and the Weft policy of the mapped type. It writes no ledger rows: when Workday owns time off, the
    balances come from Workday.
  - moves the cursor, and sets the ownership of people, compensation and time off to Workday
- Reads: `hris.get_worker_external` compares Weft and Workday field by field. `hris.list_time_off` lists Workday
  entries with the request Weft imported for each; the comment is an untrusted field.
- `integrations.resolve_sync_item` on a worker conflict:
  - Take Workday value applies a title.
  - A pay change is refused with `DOMAIN_PAY_CHANGE_IN_PEOPLE`, because it belongs to the pay settings so payroll
    previews it.
  - Keep Weft value closes the item.

### Real Greenhouse adapter (round 2)

`packages/integrations/src/real/greenhouse.ts`:

- client credentials with Basic `client_id:client_secret` to `auth.greenhouse.io/token`, with the token cached until
  60 seconds before expiry
- one token refresh on a 401
- 429 waits `Retry-After` and retries up to 3 times
- the Link cursor is sent alone
- the hire is normalized exactly like the simulator's
- `testConnection` reports the empty-offers permission gap, `auth_failed` with `http_<status>`, or unreachable
- webhooks verify with `WEFT_GREENHOUSE_WEBHOOK_SECRET`
- the board reads `WEFT_GREENHOUSE_BOARD_TOKEN` through `fetchBoardJobs`
- `markHired` is refused, because the adapter is read-only

### Commands

| Command | Risk | Access |
|---|---|---|
| `integrations.status`, `integrations.list_sync_items`, `ats.get_hire`, `ats.list_jobs`, `hris.get_worker_external`, `hris.list_time_off` | R0 | all |
| `integrations.sync_now` | R1 | all |
| `integrations.map_value` | R2, approval always | all |
| `integrations.record_delivery`, `integrations.record_ats_hire`, `integrations.apply_hris_change` | R1 | system only |
| `integrations.resolve_sync_item` | R2 | human only |

### Routes and screen

- `GET /v1/integrations` (five cards) and `GET /v1/integrations/:vendor`
- `POST .../test`, `.../sync` and `.../simulate`
  - `simulate` takes the Greenhouse kinds, plus the Workday kinds `worker_change` and `time_off`
  - Workday `sync` returns the apply result under `data.applied`
- `GET /v1/sync-items` and `POST /v1/sync-items/:id/resolve`
- `GET /v1/ats/jobs`
- Two session-only reads outside the route table: `GET /v1/integrations/greenhouse/imported` and
  `GET /v1/integrations/workday/imported`
- The screen shows:
  - the five cards, with mode, health, secret names, free path, Test connection, Sync now and the simulate controls
  - the Workday ownership line (who owns People, Compensation and Time off)
  - sync items with vendor-aware wording ("Take Workday value" is hidden for pay changes)
  - the hires imported as draft offers, the time off from Workday (read-only) and the open roles

## Contract changes and shared files

- `contract: add rt_ats_hire to the pinned prebuilt routine lists` (round 1, separate commit). It touches
  `packages/routines/test/engine.test.ts` and `apps/api/test/routines.test.ts`. Merging with the other wave 3
  routines is a one-line union.
- Additive, in owned paths:
  - `packages/contracts/src/ext/w3-integrations-hr.ts`: the simulate kinds, the outbox and HTTP shapes, the simulator
    controls, the retry schedule, the 1 MB cap, the poll interval and `W3VendorApplyArgs`
  - `W3_INTEGRATIONS_HR_TID`, which gains `ownership`, `sync` and `workdayTimeOff` in round 2
- No frozen contract changed. `apply_hris_change` runs as svc_events, which is already on that allowlist.

## Merge notes

- The seed falls back to `tot_vacation` and `top_vac_us` (the same ids and values the w3_timeoff seed writes) only when
  no vacation type exists. With w3-timeoff merged, its seed runs first and the fallback adds nothing.
- `tests/scenarios/gp17-workday-sync.test.ts` inserts the same two rows with `INSERT OR IGNORE`.
- Workday-sourced requests are approved rows with `decided_by` null and the note "Approved in Workday". w3-timeoff's
  payroll leave lines read approved requests, so they join payroll through the one native path.

## Contract requests

- w3-timeoff: refuse `time_off.cancel`, `time_off.reopen` and `time_off.decide` on rows with `source = workday`. Show
  "Managed in Workday" when the Workday ownership says vendor for `time_off`. Today only the system record writes
  those rows.
- People and person view: lock title, pay and state edits with "Managed in Workday" when ownership is vendor.
- Inbox: render open `sync_items` (kind, detail, Keep or Take) next to proposals. Today they live on Integrations only.
- Route table: add the two `.../imported` reads so the client is typed.

## Notes

- Simulated Greenhouse signs with a fixed demo key, `GREENHOUSE_SIM_SIGNING_KEY`. It is not a credential.
- `documents.create_offer` still requires `*.example` candidate emails. A real Greenhouse hire needs that rule relaxed
  behind real mode, which is the integrator's decision.
- The Host allowlist means a real webhook through a tunnel needs its host allowed. On a laptop, real mode relies on
  polling.
- Model spend this wave: $0.00 (no live model calls).

What is left is in `.scratch/w3-integrations-hr/left.md`.
