# Simulators

Every outside party Weft talks to is a simulator in `packages/sim`. Nothing in this repo contacts a real agency, bank, carrier or SaaS product, and no real money moves. Simulators persist to `sim_*` tables, read the simulated clock, use a seeded random generator, and check the fault injector before every outbound call. They write only their own tables; domain changes they cause go through system commands run by event handlers, so they appear in the audit log.

| Simulator | Stands in for | Behavior |
|---|---|---|
| IRS (sim) | Federal tax agency | Account registrations and responses; federal deposit schedule notices (P1 handling) |
| CA EDD (sim) | California employer payroll tax | Renders notice scenarios (the DE 2088 revised rate notice), accepts filed responses and returns confirmations like `CA-EDD-R-000123` |
| NY DTF (sim), NY DOL (sim) | New York withholding and unemployment insurance | Registrations, a missing-filing notice scenario |
| TX TWC (sim) | Texas unemployment insurance | Registrations |
| CO DOR (sim), CO CDLE (sim) | Colorado withholding and unemployment insurance | Registrations complete 2 simulated business days after submission with synthetic account numbers; a `needs_info` fault asks to "Confirm first wage date in Colorado" |
| Sim Federal Credit Union (ACH) | The payroll bank | `submitBatch` settles at payday 06:00 PT on the first tick at or after `settleAt`; a `return` fault returns one entry |
| Identity provider (sim) | Google Workspace, GitHub, SSO and team chat accounts | Accounts are active immediately; a `delay` fault keeps them provisioning for one tick. Offboarding suspends accounts and clears groups (fault targets `idp.suspend`, `idp.clearGroups`) |
| Laptop vendor (sim) | Device orders | "Larkspur standard laptop (sim)" at $1,899.00, ETA 3 business days; a remote lock for offboarding (fault target `devices.lock`) |
| Team chat (sim) | Slack-style channels | Channels `#people-ops`, `#payroll`, `#new-hires`, `#general`; routines post through `comms.send_message` |
| Juniper Mutual (sim), Tidewater Retirement (sim) | Benefits carriers | Plans and enrollments are real seed data. `carrier.invoice(month)` bills medical, dental and vision enrollments per semi-monthly period at the enrolled tier, stored once per month; the October invoice carries three planted errors for reconciliation (fault target `carrier.invoice`) |
| Email (sim) | Outbound mail | An outbox over `sim_email_messages`, `*.example` addresses only: offer invites with the portal link, COBRA notices, carrier disputes; `GET /v1/sim/email` (fault target `email.send`) |
| Bank account verification (sim) | Direct deposit checks | Deterministic verify of a routing and account pair after the ABA checksum passes; only last 4 digits are stored (fault target `bankVerify.verify`) |
| Payment rail (sim) | Contractor payouts abroad | `send` books a pending transfer; the scheduler tick moves it to sent, then delivered two PT business days after booking, emitting `sim.rail_delivered`; a `return` fault bounces it (fault target `rail.send`) |

## Notice scenarios

Delivered from the Simulators panel (or `POST /v1/sim/notices/deliver {scenario}`), which inserts the notice and emits `notice.received`:

- `ca_de2088_rate_change`: the hero. UI rate 1.5% replacing 3.4% from 2026-01-01 on account `000-4817-2`, ETT 0.1% unchanged, respond within 60 days.
- `ca_de2088_injection`: the same notice plus a line that tries to instruct the agent. Used to show that a tainted run can only propose.
- `ny_missing_filing`: NYS-45 Q3 not received.
- `irs_deposit_schedule_change`: P1 handling.

Notice text is original and fictional, stored as plain text and rendered as text.

## Demo controls (dev only)

| Route | Use |
|---|---|
| `GET /v1/sim/clock`, `POST /v1/sim/clock/advance` | Read or move the simulated clock: `{ to }`, `{ by: "PT30M" }` or `{ toNext: "cron" }` |
| `POST /v1/sim/notices/deliver` | Deliver a notice scenario |
| `POST /v1/sim/faults` | Arm or disarm a fault: targets such as `agency.CO.register`, `agency.CA.fileResponse`, `bank.submitBatch`, `idp.createAccount` |
| `GET /v1/sim/state`, `GET /v1/sim/chat?channel=` | Redacted simulator state and chat feeds |
| `POST /v1/sim/reset` | Rebuild the database, reseed, re-init memory and delete run workspaces (under 5 s); never touches `.data/spend/`. E2E calls it before every test |
