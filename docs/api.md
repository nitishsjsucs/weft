# The /v1 API

The API is Hono on Node, bound to 127.0.0.1 (port 4070 by default). The route table, with each route's method, path, query, body, response schema and owner, is `packages/contracts/src/api.ts`; the typed browser client is `apps/web/src/lib/api/client.ts`.

## Auth

- **API keys**: `x-api-key: weft_sk_...`, scoped (`admin`, `mcp`, and others). The seed writes a demo admin key to `.data/demo-api-key.txt` and an `mcp`-scope key to `.data/demo-mcp-key.txt` (both mode 0600). `mcp`-scope keys get 403 on decision, rollback, settings, api-keys and simulator routes.
- **UI sessions** (dev auth, `WEFT_DEV_AUTH=1`): `x-weft-principal: usr_...` is honored only together with a valid `x-weft-proxy`, which the Next proxy injects from `.data/run/proxy.secret`. Decisions (`/v1/proposals/:id/approve` and friends) and rollback accept only UI sessions.
- **Host and Origin**: requests must carry a `Host` of `127.0.0.1` or `localhost` on the API or web port; mutating requests with an `Origin` must match the same list.
- **Rate limits**: 60 requests per minute per API key; 1,200 per minute per UI principal.
- Public routes: `GET /v1/health`, `GET /v1/stats`.

## Conventions

- JSON in and out. Money fields are `{ amount, currency, display }` with `amount` in integer cents; rates are decimal strings such as `"0.034"`.
- Cursor paging: `limit` (default 25, 1 to 100), `afterId`, `beforeId`; responses are `{ hasMore, count, data }`.
- Errors: `{ _tag, message, ...extra }` with `_tag` one of `Unauthorized` 401, `Forbidden` 403, `NotFound` 404, `ValidationError` 400, `Conflict` 409, `Refused` 422 (with `code`), `RateLimitExceeded` 429, `NotImplemented` 501, `Internal` 500.
- Every mutating route runs through the executor with the caller's session, so it is audited, and then kicks the scheduler.

## Routes by area

| Area | Routes |
|---|---|
| Health and stats | `GET /v1/health` (status, provider badge, clock, stubbed parts), `GET /v1/stats` (counts for the landing page and Home) |
| Company and people | `GET /v1/company`, `GET /v1/workers`, `GET /v1/workers/:id`, `GET /v1/workers/:id/onboarding`, `GET /v1/offers`, `POST /v1/offers/:id/accept` |
| Hiring and documents (wave 2) | `POST /v1/offers`, `GET /v1/offers/:id`, `POST /v1/offers/:id/send`, `POST /v1/offers/:id/void`, `GET /v1/workers/:id/documents?status=`, `GET /v1/documents/:id` |
| New-hire portal (wave 2, the hire's persona only) | `GET /v1/portal/me`, `POST /v1/portal/offer/view`, `POST /v1/portal/documents/:id/sign`, `POST /v1/portal/w4`, `POST /v1/portal/state-withholding`, `POST /v1/portal/direct-deposit`, `POST /v1/portal/i9` (multipart), `POST /v1/portal/benefits`. A persona gets 403 `PORTAL_ONLY` on every other path |
| Offboarding (wave 2) | `POST /v1/workers/:id/terminate`, `GET /v1/offboarding`, `GET /v1/offboarding/:id` |
| Payroll | `GET /v1/payrolls`, `GET /v1/payrolls/:id`, `GET /v1/payrolls/:id/paychecks`, `GET /v1/paychecks/:id`, `POST /v1/payrolls/:id/preview`, `POST /v1/payrolls/:id/submit`, `POST /v1/payrolls/drafts`, `POST /v1/payrolls/off-cycle` (wave 2, a proposal) |
| Tax and notices | `GET /v1/tax/accounts`, `GET /v1/tax/rates`, `GET /v1/notices`, `GET /v1/notices/:id` |
| Benefits, IT and contractors | `GET /v1/benefits/plans`, `GET /v1/benefits/enrollments`, `GET /v1/it/accounts`, `GET /v1/it/devices`; wave 2: `GET /v1/benefits/reconciliation?month=`, `POST /v1/benefits/reconciliation/run`, `GET /v1/benefits/open-enrollment`, `GET /v1/contractors/payouts`, `POST /v1/contractors/payouts`, `GET /v1/contractors/fx` |
| Decisions | `GET /v1/proposals`, `GET /v1/proposals/:id`, `POST /v1/proposals/:id/{approve,deny,dismiss,start}` |
| Audit | `GET /v1/actions`, `GET /v1/actions/:seq`, `POST /v1/actions/:seq/rollback`, `GET /v1/actions/verify` |
| Tools | `GET /v1/tools?surface=mcp|main`, `POST /v1/tools/:name` (the surface comes from the key, never the request) |
| Memory | `GET /v1/memory/tree`, `GET /v1/memory/file?path=` (with `links`: outgoing and backlinks), `GET /v1/memory/search?q=` (alias and wiki-link expansion), `GET /v1/memory/history?path=&limit=` (read only) |
| Activity and settings | `GET /v1/events?afterId=`, `GET /v1/settings/permissions`, `PUT /v1/settings/agent-grants`, `POST /v1/api-keys` (the key is shown once) |
| Agent | `POST /v1/agent/runs`, `GET /v1/agent/runs`, `GET /v1/agent/runs/:id`, `GET /v1/agent/runs/:id/events` (SSE), `GET /v1/agent/runs/:id/trace`, `GET /v1/agent/runs/:id/artifacts/:ref`, `POST /v1/agent/runs/:id/cancel`, `GET /v1/agent/costs?day=` |
| Routines | `GET /v1/routines`, `GET /v1/routines/:id`, `GET /v1/routines/:id/runs`, `GET /v1/routine-runs/:id`, `POST /v1/routines/:id/trigger`, `POST /v1/routines/draft`, `POST /v1/routines/:id/enable`, `POST /v1/routines/:id/disable` |
| Simulators (dev only) | see [simulators.md](simulators.md) |

## Examples

```sh
KEY=$(cat .data/demo-api-key.txt)
curl -s -H "x-api-key: $KEY" "http://127.0.0.1:4070/v1/workers?limit=5"
curl -s "http://127.0.0.1:4070/v1/stats"
```

The MCP server uses the `mcp` key, given as the key (`WEFT_API_KEY`) or as the file that holds it
(`WEFT_API_KEY_FILE`, an absolute path: pnpm starts the server in `apps/mcp`):

```sh
WEFT_API_URL=http://127.0.0.1:4070 WEFT_API_KEY_FILE=$PWD/.data/demo-mcp-key.txt pnpm --filter @weft/mcp start
```

`pnpm mcp:config` prints a ready-to-paste client config for this checkout (the `mcpServers` shape Claude Desktop and
the MCP Inspector read; `--api-port` and `--data-dir` for another world). `docs/demo-scenarios.md` scenario 8 has the
call sequence.
