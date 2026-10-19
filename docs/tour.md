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
is the base world plus the rich layer (`packages/seed/src/rich/`, through `seedWorldProfile` in
`packages/seed/src/profile.ts`). `pnpm dev` seeds rich by default, `--e2e` always seeds base. A rich world carries
the `seed.profile` settings row, so `POST /v1/sim/reset` with no profile rebuilds it rich. The tour sends
`{ profile: "rich" }` explicitly; an unknown profile or an extra key is a 400. `GET /v1/health` reports `seedProfile`.
On a world that is not a clean rich one, the tour offers the reset first and otherwise runs on its fallbacks (the
reset offer, a skipped portal stop, unanchored cards where data is missing).

## Tests

- `pnpm test` covers `apps/web/test/tour-steps.test.ts`, `apps/web/test/tour-engine.test.ts` and
  `apps/api/test/tour-profile.test.ts`.
- `pnpm e2e:tour` runs `e2e/tour/` on its own ports (5640 and 5641) and data dir (`.data-e2e-tour`), scripted.

## Measured

| Run | World | Total | Notes |
|---|---|---|---|
| tour-complete, scripted, reading each card for its seconds | base (round 1) | 128 s | portal stop skipped (no persona on base) |
| tour-autoplay, scripted | base (round 1) | 132 s | 20 steps |
| tour-autoplay, live gpt-5.6-luna | base (round 1) | 142 s | notice run 8.2 s (soft 12 s), chart step 7.4 s; $0.0038 |
| tour-complete, scripted, reading each card for its seconds | rich (round 2) | 137 s | all 21 steps, every step on its own target |
| tour-autoplay, scripted | rich (round 2) | 141 s | 21 steps |
| tour-autoplay, live gpt-5.6-luna | rich (round 2) | 150 s | notice run 9.0 s (soft 12 s), chart step 5.5 s (soft 8 s); $0.0037 |

Round 2, scripted on the rich world: Deliver ready to the run step 1.9 s, the run step 1.6 s, Approve 1.8 s, the chart
answer 3.0 s including the typed prompt. The slowest step to get ready is the payroll flags (about 1 s: the page
plus the flag popover).

The live pass is opt-in: `WEFT_TOUR_LIVE=1 pnpm e2e:tour tour-autoplay` starts the same server on live Luna with
`WEFT_LIVE_USD_CAP=0.05`, its own data dir (`.data-e2e-tour-live`) and tracing off.
