# Review log

Round 2 review of main at e8bd7b8 (correctness, security, harness, product design and brand honesty lenses), fixed
on 2026-10-15 between 17:58 and 18:30 PDT. Each finding was checked against the code before it was fixed or set aside.

## Fixed

| Lens | Finding | Commit subject |
|---|---|---|
| Design (blocking) | cn() dropped type scale sizes next to text colors | fix(ui): register the text-0 to text-12 type scale with tailwind-merge |
| Security, correctness | routines.enable and routines.disable always failed (events missing from the union) | fix(routines): add routine.enabled and routine.disabled events |
| Security, harness | the per-run tool allowlist was never enforced | fix(executor): freeze the run allowlist on exec_runs and refuse anything else |
| Correctness | proposal expiry never woke or finalized the proposing runs | fix(executor): proposal expiry wakes the proposing run and finalizes its routine run |
| Correctness | submit_run paid a stale draft after an approved rate change | fix(payroll): a rate change or revert recomputes open drafts in the same transaction |
| Security | DNS rebinding through the web proxy; MCP keys could trigger routines and cancel runs; API keys could run ui-only commands through /v1/tools | fix(auth): close the DNS-rebinding path through the web proxy |
| Security, harness | the redactor never learned a key loaded from WEFT_SECRETS_FILE | fix(api): the redactor learns provider keys loaded from WEFT_SECRETS_FILE |
| Correctness, design | next-env.d.ts dirtied the tree; a second next dev failed late; the Next dev badge covered Settings | chore(dev): refuse a second next dev in the checkout, restore next-env.d.ts on stop, hide the Next dev badge |
| Correctness | golden path scenarios skipped themselves on a stub | test: golden path scenarios fail on a stubbed part instead of skipping |
| Harness | two nonces per run; chat answers could ground themselves on comms.post_update | fix(agent): one nonce per run and no self-grounding through the run feed |
| Brand | taint overclaim, "four states", "0.1", live spend "in total", stale status sections, lint:brand and NOTICE scope | docs: honest landing and README copy; mark the stale status sections historical |
| Design | GP1 next-run diff row read $0.00 to a negative number; ISO date in the title | fix(tax): the GP1 next-run diff row shows employer SUI before and after |
| Design | repeated "Content to be sent" label, repeated evidence refs, raw rule ids in the flag popover, home widgets padded to 180px, lowercase badges | fix(web): drop repeated labels and raw rule ids from proposal cards and flag popovers |
| Correctness | routine decisions lived only in memory, so a restart re-listed decided proposals | fix(routines): read proposal decisions through the ReadOnlyExecutor |
| Correctness | addBusinessDays shifted the wall time across the DST change | fix(sim): addBusinessDays steps PT calendar dates |
| Correctness, harness | SPEC 12 L4 row did not match the relaxed live criterion | SPEC 12 L4 row now states the L4a criterion and names L4b as left (this commit) |

Notes on the allowlist fix: a chat handle opened without an `allowlist` (only executor and scenario tests do this)
is unrestricted; every route in apps/api passes CHAT_TOOLS or DRAFT_TOOLS, and routine runs always freeze the
routine's own tools from its row. The ui-only check covers routines.enable, routines.disable and the two rollback
commands; other human_only commands (people.accept_offer, people.update_profile, sim.deliver_notice) stay open to
admin and cli keys on purpose, because their routes accept API keys.

## Set aside, with the reason

| Lens | Finding | Why not now |
|---|---|---|
| Harness | waiting routine runs lose their trigger and handle on restart (runtime.ts in-memory triggers, handles) | Needs the trigger stored in the context step and a DB-backed wake path in the runtime; larger than this round's budget. The routines half (decisions from memory) is fixed. Next step: read the trigger from the context step's RunSetup and pending proposals through actions.get_run |
| Harness | routine run summaries are the model's prose, not grounded | A deterministic summary from checklist items and proposal titles plus a separate grounded agent note needs a contract field (agent_note) and UI work; left for the next round |
| Harness | no Active Memory recall at task start, no dossier refresh, no timeline coarsening | A P1 feature (harness 9.5, 7.2), not a defect fix; it needs its own track |
| Harness | live L4 cannot fail on injection behavior | L4b costs a live call; the SPEC row now says so plainly. Add the forced-read chat case in the next live round under the $0.50 cap |
| Harness | grounding check treats short strings with spaces as identifiers | The rule exists for identifiers like "DE 2088" that carry a space; tightening it needs a corpus check. The self-grounding path it enabled (post_update echo) is closed |
| Harness | spend ledger per-run cap keyed by reused run ids | Only bites after many live reruns on the same data dir; the loop already enforces the per-run budget. Key by a unique run key in the next live round |
| Harness | sandbox gate missing | No code.run exists yet; add the SANDBOX_NOT_ALLOWED policy branch with code.run |
| Harness | no cross-run prefix pin test | Worth adding with WEFT_PIN_PREFIX=1; not a defect today |
| Design | paycheck table too wide with the agent panel docked; audit Summary column squeezed; command search hidden at 1440; payroll page does not show the pending submit proposal | Layout work that needs screenshots across breakpoints; the cn() fix already restores the 11px chips and 14px table text that caused much of the width |
| Design | simulators: all Deliver buttons disabled for about 6s, no staged run feed reveal; approve gives no result strip | Interaction work across three components; next design round |
| Design | landing: no mobile menu, missing agent showcase and run log sections, hero mock reflows at 390, dark island density, stat tile spacing | New sections and responsive work; next design round. The heading line height and the API path in the Numbers heading are fixed |
| Design | Bank batches raw headers, empty states without a next step, humanized enums and run id crumbs everywhere | Small but spread over many files; next design round |
| Brand | research/ quotes reference marketing lines verbatim and they are in git history | The repo is local only and never pushed. Before any publish, paraphrase research/product.md and research/agent.md or move them out of the tracked tree and rewrite history |
