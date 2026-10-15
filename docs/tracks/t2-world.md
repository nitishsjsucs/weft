# Track t2-world: domain world

Branch `track/t2-world`. People, onboarding, tax, notices, benefits, IT, comms, the simulators and the world seed.

## What is built

- **Simulators** (`packages/sim`): `createSimulators({ db, clock })` over a db or transaction handle. Agency (register completes after 2 sim business days with a synthetic account number; `needs_info` fault; `fileResponse` confirmation such as `CA-EDD-R-000001`), bank ACH (settles on the first tick at or after `settleAt`; `return` fault returns the first entry), IdP (`delay` fault provisions for one tick), devices (catalog `lrk-laptop-std` at $1,899.00, ETA 3 business days, delivery on tick), chat (closed channel enum; `postInbound` for seeded human messages), faults, fixed synthetic FX, carrier (P1 stub). Rows hold only vault names. Business days are judged in America/Los_Angeles.
- **Notice scenarios** (`packages/sim/fixtures/notices/*.txt`, original text): `ca_de2088_rate_change`, `ca_de2088_injection` (the only fixture with the injection line), `ny_missing_filing`, `irs_deposit_schedule_change`. Rendered with the sim date; a deterministic labeled-line parser produces `NoticeExtract` (changed rates only).
- **Seed** (`packages/seed/src/{company,people,benefits,tax,it,actions}.ts`): SPEC 5.1 to 5.4 and 5.6 counts. Roster order fixes ids: employees `wrk_0001` to `wrk_0048` (EMP numbers match), contractors `wrk_0049` to `wrk_0051`.
- **Commands** (`packages/core/src/commands/*.ts`, logic in `people/ tax/ notices/ benefits/ it/ comms/ onboarding/ demo/`): every read and write in SPEC 9.2 for t2 except `people.update_profile` (cut line).
- **Handlers**: `sim.registration_completed` and `sim.registration_needs_info` run `tax.record_registration`; `tax_account.activated` completes `state_registration` once every account of the work state is active.
- **Routes**: company, stats, workers (list, detail, onboarding), offers (list, accept), tax, notices, benefits, it, sim (clock, advance, deliver, state, faults, chat, reset).
- **Scenario S3** (`tests/scenarios/s3-new-hire.test.ts`): the domain flow through the real scheduler and handlers, with direct stand-ins for the executor; script `tests/scenarios/scripts/s3-new-hire.json` for the scripted provider.

## Key ids and facts for other tracks

| What | Value |
|---|---|
| Admin workers | Dana `wrk_0001` (CA), Theo `wrk_0002` (CA), Sam `wrk_0025` (NY) |
| Hardware lead (Noor's manager) | Imani Ferreira (demo) `wrk_0004` |
| CA hires under the SUI base | `wrk_0020` Oct 1 $96,000; `wrk_0021` Oct 1 $88,000; `wrk_0022` Oct 19 $104,000, no bank account |
| NY raise | `wrk_0026` Lena Brooks (demo), 11,800,000 to 13,924,000 cents from 2026-10-16 (old rate ends 2026-10-15), via `people.set_pay_rate` as Dana at 2026-10-09 10:00 PT |
| NY offboarder | `wrk_0027` Owen Mercer (demo), status `active`, `end_date` 2026-10-23 (kept active so draft eligibility "active or onboarding" includes him) |
| TX techs | `wrk_0043` to `wrk_0048` hourly 2,800 to 3,600 cents; time entries for Sep 1 to 15 through Oct 16 to 31, 86.67 h; `wrk_0048` has 86.67 regular plus 33.33 overtime (120.00 h) in Oct 16 to 31 |
| Pre-2020 W-4 | `wrk_0009` (Married, 3 allowances) |
| Above $200,000 | `wrk_0003` $245,000, `wrk_0004` $232,000 |
| Tax accounts | `txa_0001` IRS, `txa_0002` CA EDD `000-4817-2`, `txa_0003` NY DTF, `txa_0004` NY DOL, `txa_0005` TX TWC, `txa_0006` CO DOR, `txa_0007` CO CDLE (both `not_registered`) |
| Rates | CA SUI 0.034 and ETT 0.001 on $7,000; NY SUI 0.041 on $17,600 (source `notice:ntc_0001`); TX SUI 0.027 on $9,000; CO SUI 0.0305 on $30,600 inserted on activation (source `registration:sima_...`, effective 2026-01-01) |
| Noor | `offr_0001`; accepting creates the next `wrk_` id with `EMP-0049`, status `onboarding`, the demo bundle (W-4 single, CO profile, Sim Federal Credit Union `vault:bank-<wrk id>`), 9 checklist tasks |

## Conventions the integrator should know

- **Domain refusals** are thrown as `DomainRefusal`, a subclass of the contracts `Refused` with `extra: { code, hint, example }`; `comms.send_message` throws `Refused("UNGROUNDED", ...)`. Hints carry derived values (for `tax.update_rate`, the notice's account, rate and effective date, with the corrected args as `example`).
- **`untrustedFields` paths** are dotted; `*` walks every array element or object value (`notices.*.title`). `valuesAt` and `nonEmptyUntrusted` in `@weft/core` are the reference semantics.
- **Concise reads never return untrusted fields.** `notices.get` concise returns the parser's extract and no title or body; `response_format: "detailed"` adds them and taints.
- **Action seq inside commands**: `created_action_seq` and `superseded_action_seq` are `MAX(actions.seq) + 1`, read inside the executor's transaction (`nextActionSeq`), which assumes one action row per command appended after `run()` in the same transaction.
- **Not reversible reasons**: `NOT_REVERSIBLE_REASONS` in `@weft/core` ("Not reversible: filed with the agency simulator").
- **Direct stand-ins** (`directExecutors`, `runDirect`, `directDeps`, `ensureTestPrincipals`) exist for tests and the pre-integration seed only.

See `.scratch/contract-requests/t2-world.md` for the contract requests and `.scratch/t2-world/left.md` for what is left.
