# The guided tour

A three-minute walkthrough inside the app (21 steps, 161 s planned, 180 s hard budget) that shows the agent work a
California DE 2088 rate notice end to end and then takes a fast lap of the rest of the product. It is a custom
build on the app's own Radix primitives, with no new dependency.

## Starting it

- Home: "Take the tour" next to the greeting (an accent dot shows until `weft.tour.seen` is set).
- The Viewing as menu: a Demo group with "Take the tour" and "Reset demo data...".
- The command menu (Cmd or Ctrl K): "Take the tour".
- `/app?tour=1` starts it, `/app?tour=<stepId>` jumps to a step, `&autoplay=1` turns autoplay on.

There is no auto-start and no first-visit popup, so `pnpm e2e` and `pnpm screenshots` never see a tour.

## How it works

`apps/web/src/components/tour/`:

| File | What it holds |
|---|---|
| `steps.ts` | The 21 steps as pure data (route, target, fallbacks, copy, action, seconds, timeouts) and the budget math |
| `engine.ts` | The state machine (idle, preflight, reset, resume, running, done), sessionStorage persistence, preflight |
| `tour-provider.tsx` | Runs each step: navigate, locate (MutationObserver plus rAF, 5 s), ring, then the action |
| `shell-bridge.tsx`, `bridge.ts` | The agent panel and nav drawer controls the app shell hands to the tour |
| `tour-card.tsx`, `tour-ring.tsx`, `tour-reset-dialog.tsx`, `tour.css` | The card, the ring, the reset dialog, the pulse |

Targets are `data-tour` tokens matched with `~=`, kept apart from `data-testid`. Dynamic ids (the notice run, the
rate proposal, its action seq, the draft payroll, the new-hire persona) come from the API at step entry. A missing
target shows the card unanchored with "This part of the demo data is missing on this world." and Next, so the tour
never gets stuck.

Wait timeouts are budget-aware: hard timeout = min(step hard, 180 s - elapsed - planned seconds of the steps left),
never below the step's own seconds.

## Seed profiles

The base world is what every test, `pnpm e2e`, `pnpm demo` and the evals use, and it does not change. A rich world
is the base world plus the rich layer from the rich-seed track (`packages/seed/src/rich.ts`, export `seedRich`).
`pnpm dev` defaults to `--profile rich`, `--e2e` to base. `POST /v1/sim/reset { profile }` picks one explicitly and
`GET /v1/health` reports `seedProfile`. Until the rich layer lands, a rich request seeds the base world and the tour
runs on its fallbacks (the reset offer, a skipped portal stop, unanchored cards where data is missing).

## Tests

- `pnpm test` covers `apps/web/test/tour-steps.test.ts`, `apps/web/test/tour-engine.test.ts` and
  `apps/api/test/tour-profile.test.ts`.
- `pnpm e2e:tour` runs `e2e/tour/` on its own ports (5640 and 5641) and data dir (`.data-e2e-tour`), scripted.
