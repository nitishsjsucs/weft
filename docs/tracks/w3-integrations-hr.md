# Track w3-integrations-hr: connector framework, Greenhouse, Workday, the Integrations screen

Wave 3 goal 3 (docs/wave3.md section 3). Research: `research/wave3/integrations-hr.md`. Branch `track/w3-integrations-hr`.

## What landed (round 1)

**Framework.**

- `POST /v1/integrations/:vendor/webhook` is public. It reads the raw body, caps it at 1 MB (413), and asks the
  vendor connector to verify the signature over the raw bytes in constant time (401 otherwise).
- It dedupes on the delivery id in `integration_deliveries`. A duplicate answers 200 `{ ok, duplicate: true }` and
  writes nothing. The row holds ids and a sha256 of the raw body, never the body.
- It answers 200 only after `integrations.record_delivery` (svc_events) stored the row.
- A Greenhouse `hire_candidate` or `offer_updated` delivery emits `integration.ats_hire_detected` (ids only, subject
  the `dlv_` id). The handler re-reads the hire and applies it through `integrations.record_ats_hire`, which marks
  the delivery applied.
- Screening and e-signature vendors get their `VENDOR_APPLY_COMMAND` called with `W3VendorApplyArgs`
  (`{ vendor, delivery_id, items }`, ids only). This is the agreement with w3-integrations-screening-esign.
- `apps/api/src/integrations/poll.ts` runs on every scheduler tick. It delivers due simulated webhooks in process
  through the same receiver as the public route. The `greenhouse.webhook` fault fails a delivery, which then retries
  on the 7-attempt schedule of the sim clock (0, 1, 16, 76, 196, 436, 916 minutes).
- The poll also runs `integrations.sync_now` as svc_scheduler every 15 sim minutes. It runs only when there is
  something to read: an unlinked or newer simulated hire with no delivery still waiting, or a real connection. So
  the existing tests, the demo and the seed see no new action rows.
- Mode and overlay: `@weft/integrations` stays as scaffolded. New tests cover the overlay passing simulators through,
  a missing secret, and `LIVE_INTEGRATION_IN_TEST`.

**Greenhouse simulator** (`packages/sim/src/vendors/greenhouse.ts`). It follows Harvest v3 field names, with no
vendored spec:

- bare arrays, sorted by id descending
- an opaque `Link rel="next"` cursor that must be the only query parameter (422 otherwise)
- `per_page` from 1 to 500
- `X-RateLimit-*` headers, and the `greenhouse.rateLimit` fault, which returns 429 with `Retry-After: 3`
- versioned offers with `current_only`, and `custom_fields.salary { amount, unit }` in major units
- signed `hire_candidate` deliveries: `Signature: sha256 <hex>` over the raw body, with `<`, `>` and `&` escaped the
  way the vendor does, so a re-serialized body fails
- the `greenhouse.offersHidden` fault, which is the empty-offers permission gap

Demo controls (`W3GreenhouseSimControls`): simulate a hire, change the start date (offer version 2), resend the last
delivery. The seed adds three fictional Larkspur jobs and two in-process candidates, and no hires. The Boulder field
office is deliberately unmapped.

**Hero flow (GP17).**

1. Simulate a hire. A signed delivery is verified, stored and re-read.
2. Weft creates one draft offer through the existing `documents.create_offer` logic, linked in `ext_links`, and emits
   `offer.imported`. The offer is for CO, uses Remote US, and is Hardware at 132,000.00.
3. The unmapped office becomes an `unmapped_value` sync item.
4. `rt_ats_hire` (8 tools, enabled, on `offer.imported`) reads the sync items and proposes `documents.send_offer`.
5. Dana approves, and GP6 runs unchanged from there: the invite, the portal and signing.

After that:

- A second delivery with the same id is a no-op.
- Offer version 2 with a new start date opens a human-only `sync_conflict`. The offer is never overwritten.
- `integrations.resolve_sync_item` (human only) can keep the Weft value or take the vendor value, on drafts only.

**Commands.** All are in `packages/core/src/integrations/commands.ts`:

| Command | Risk | Access | Note |
|---|---|---|---|
| `integrations.status` | R0 | all | |
| `integrations.list_sync_items` | R0 | all | |
| `ats.get_hire` | R0 | all | candidate name and email are untrusted fields |
| `ats.list_jobs` | R0 | all | |
| `integrations.sync_now` | R1 | all | reads the vendor and emits id-only detection events |
| `integrations.map_value` | R2 | all | approval always |
| `integrations.record_delivery` | R1 | system only | |
| `integrations.record_ats_hire` | R1 | system only | |
| `integrations.resolve_sync_item` | R2 | human only | |

**Routes.**

- `GET /v1/integrations` returns five cards. Each card has the mode, the health, and the secret names with present or
  missing, never a value.
- Also landed: `GET /v1/integrations/:vendor`, `POST .../test`, `POST .../sync`, `POST .../simulate { kind }`,
  `GET /v1/sync-items`, `POST /v1/sync-items/:id/resolve` and `GET /v1/ats/jobs`.
- One read-only extra route is outside the route table: `GET /v1/integrations/greenhouse/imported`. It requires a
  session and lists the imported offers with their Greenhouse link.

**Integrations screen** (`/app/integrations`):

- five vendor cards: Simulated or Connected, health, the secrets file names, the free path, Test connection, Sync now
- the Greenhouse simulate controls
- the sync items, with Keep Weft value and Take Greenhouse value
- the hires imported as draft offers
- the open roles

**Public job board.** `parseBoardJobs` in `@weft/integrations` reads single_select metadata as a string and
multi_select as an array. It is tested on a hand-written fictional Larkspur fixture. One live smoke read runs only
with `WEFT_LIVE_PUBLIC=1`.

**Tests.**

- `packages/sim/test/vendors/greenhouse.test.ts` (6 tests)
- `apps/api/test/integrations.test.ts` (6 tests: cards and secret values, webhook refusals and the 1 MB cap, retry
  and poll, registry rules)
- `packages/integrations/test/{board,overlay}.test.ts`
- `tests/scenarios/gp17-greenhouse-hire.test.ts` (4 tests)
- `e2e/gp17-greenhouse-hire.spec.ts` (ports 4660 and 4661)

## Left for round 2

These are in `.scratch/w3-integrations-hr/left.md`, matching the cut line:

- the Workday simulator, `integrations.apply_hris_change` and the Workday scenario (workers and approved time off
  read-only with `source = workday`)
- the real Harvest v3 adapter (OAuth client credentials, read-only) and the Workday real adapter skeleton
- `ats.mark_hired` and `hris.request_time_off` proposal stubs, and `unhire_candidate`
- Inbox rendering of sync items

## Shared files touched outside the owned paths

- `packages/routines/test/engine.test.ts` and `apps/api/test/routines.test.ts` pin the prebuilt routine list. Both
  gain `rt_ats_hire`, in the separate commit `contract: add rt_ats_hire to the pinned prebuilt routine lists`. Every
  wave 3 track that adds a routine touches the same two lines, so merging is a one-line union.
- Additive contracts: `packages/contracts/src/ext/w3-integrations-hr.ts` is exported through
  `w3/testids-integrations.ts`. It holds:
  - the simulate kinds
  - the outbox delivery and HTTP response shapes
  - the Greenhouse and Workday simulator controls
  - the retry schedule, the 1 MB cap and the 15-minute poll interval
  - `W3VendorApplyArgs`

## Contract requests

- Inbox: render open `sync_items` (kind, detail, Keep or Take) next to proposals. Today they live on the
  Integrations screen only. The resolve route is `ui_only`, and the command is human only.
- Route table: add `GET /v1/integrations/greenhouse/imported` (or a `source` column on offers) so the imported list
  is typed.

## Notes

- Simulated mode signs with a fixed demo key (`GREENHOUSE_SIM_SIGNING_KEY`). It is not a credential. Real mode will
  verify with `WEFT_GREENHOUSE_WEBHOOK_SECRET`.
- `documents.create_offer` still requires `*.example` candidate emails. A real Greenhouse hire would need that rule
  relaxed behind real mode. That decision belongs to the integrator.
- The Host allowlist means a real webhook through a tunnel needs its host allowed. Real mode on a laptop relies on
  polling.
