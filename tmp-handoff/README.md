# Temporary handoff folder

This folder is for the next agent continuing the Weft on Cloudflare build (started 2026-10-20). Delete it once the work has landed on `main` and is deployed.

Start here: [handoff-2026-10-20.md](handoff-2026-10-20.md). It covers what is done, what is in progress and what is left, Nitish's decisions, the rules, how to set up a cloud agent, and how to protect the original local demo (tag `demo-stable-2026-10-20`).

| File | What it holds |
|---|---|
| `handoff-2026-10-20.md` | The handoff itself. Read all of it first. |
| `build-results-2026-10-20.json` | The final status of every agent in the build run: Round 0, six tracks with their adversarial reviews and fixes. Includes test counts, open items and contract requests. |
| `ground-truth-2026-10-20.json` | The free-plan account probe measured on 2026-10-20, Cloudflare product research with sources, and the Node-to-Workers porting-seam map. |
| `build-workflow-2026-10-20.js` | The prompts of the build workflow: the shared CONTEXT block and the Integrate, Deploy, Verify and Land stages. Reuse them in a fresh script; never resume the old run. |

The design itself lives in `docs/cloudflare/design.md` (section 0 holds Nitish's settings) and `docs/cloudflare/tracks.md`. The build is on the `cf/integration` branch.
