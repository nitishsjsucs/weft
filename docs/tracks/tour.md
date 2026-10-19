# Track tour

Rounds 1 and 2, 2026-10-18. Branch `feat/tour` (worktree `weft-worktrees/tour`). How to use it: `docs/tour.md`.

## Done in round 1

- The tour itself, in `apps/web/src/components/tour/`: the 21 steps from the design as pure data (`steps.ts`), the
  state machine, persistence and preflight (`engine.ts`), the provider in the root layout so the tour survives the hop
  to `/portal` (`tour-provider.tsx`), the shell bridge for the agent panel, its thread and the nav drawer
  (`bridge.ts`, `shell-bridge.tsx`), and the card, ring and reset dialog (`tour-card.tsx`, `tour-ring.tsx`,
  `tour-reset-dialog.tsx`, `tour.css`). No new dependency: Radix Popover on a virtual anchor, Radix Dialog for the
  centered steps, AlertDialog for the reset.
- Agent steps drive the real flows: Deliver posts the DE 2088 notice, the run step watches the RunFeed's
  `data-status` with a 12 s soft and a budget-capped 20 s hard timeout, Approve polls the proposal until it executed
  (8 s), and the chart step sends "Show payroll cost by month" and waits for the chart (8 s soft, 15 s hard).
- Entry points: Home, the Viewing as menu (a Demo group), the command menu, and `/app?tour=1`,
  `/app?tour=<stepId>`, `&autoplay=1`. No auto-start.
- `data-tour` tokens on 21 app files (attributes plus two minimal wrappers), kept apart from `data-testid`.
- Keyboard, screen reader, reduced motion and phone layout per the design.
- Tests: `apps/web/test/tour-steps.test.ts`, `apps/web/test/tour-engine.test.ts`, `apps/api/test/tour-profile.test.ts`
  in `pnpm test`; `pnpm e2e:tour` (`playwright.tour.config.ts`, `e2e/tour/`) on ports 5640 and 5641 and
  `.data-e2e-tour`.

## Done in round 2

- Merged `feat/rich-seed` (389f157) and main (5babb58). There is now one seed profile seam, the rich-seed track's
  `packages/seed/src/profile.ts` (`@weft/seed/profile`): round 1's loader (`apps/api/src/seed-profile.ts`,
  `scripts/seed-profile.ts`) is gone. The tour keeps two additive pieces on top: `GET /v1/health` reports
  `seedProfile` (through `readSeedProfile`), and `POST /v1/sim/reset` parses its body with the strict `SimResetBody`
  (an unknown profile or an extra key is a 400 and the world is untouched). `apps/web/next-env.d.ts` stays as on main.
- `pnpm e2e:tour` seeds base with `--e2e` (the rich-seed `dev.ts` always seeds base there) and every test rebuilds the
  rich world with `POST /v1/sim/reset { profile: "rich" }`, then checks health says rich and the clock is at the seed.
- The whole tour now runs on the rich world with every target found, the portal stop included.
- Fixed a request storm in the new-hire portal (`apps/web/src/components/portal/w4-people.tsx`): `usePortal`
  returned a new object each render, so the People section's `load` changed every render and its effect refetched
  life events, check-ins and time off in a loop (about 650, 250 and 250 requests in 5 s). The browser ran out of
  sockets (`ERR_INSUFFICIENT_RESOURCES`), other portal sections failed to load, and a client navigation away from the
  portal stalled until Next fell back to a full page load. The base world never showed it because it has no persona.
- The tour carries on after a full page load it caused itself: before each route change it marks
  `sessionStorage weft.tour.nav` with the path, and a page load on that path within 30 s continues the step instead of
  offering "Resume tour". A reload by the person still offers it.
- The memory step pointed at `procedures/state-sui-rate-notice.md`; the file is
  `knowledge/procedures/state-sui-rate-notice.md`, so round 1 rang the fallback (whatever file was open). Fixed, and
  the rich layer gained one memory thread (`workstreams/2026-agency-notices.md`, in `packages/seed/src/rich/index.ts`)
  that links the procedure, so its Backlinks are not empty when the tour opens it.
- The card carries `data-target-match` (`primary` or `fallback`), and on the rich world the complete spec checks
  every step matched its own target, the memory backlinks are non-empty, and the read-backs compare against the
  proposals and runs that existed before the tour (the rich world has a year of decided history).
- The draft payroll lookup reads up to 100 runs (the rich world has 20).
- New controls test: the persona portal settles (fewer than 20 API calls in 3 s) and the tour leaves it for
  `/app/memory` in one hop, without the resume prompt, back as Dana.

## Decisions beyond the design

1. The rate row has a `data-current` token so the ring skips superseded rows.
2. Deliver has an 8 s hard timeout, so the worst case is exactly 180 s.
3. Deep links skip the reset offer.
4. Autoplay pauses only on keyboard focus (`:focus-visible`) in the card, so a mouse click on Play does not pause it.
5. Docked steps (payroll flag, expense drawer) do not move focus to the card title: Radix closes the flag popover on
   focus outside.
6. The card stays clickable over the expense drawer's modal dialog; clicking it closes the drawer, as the design's
   "closes the drawer on leave" asks.
7. Round 2: a page load the tour caused continues silently (see above); the design only covered a person's reload.

## Measured

See `docs/tour.md`. On the rich world, scripted: the whole tour read at its planned pace took 137 s and autoplay
141 s, under the 180 s budget.

## Merge state

Merged into main on 2026-10-18 (after the review fix merge at 788a46e) with no conflict, as `Merge feat/tour`; the
integration added the rich-profile route capture (`pnpm screenshots:rich`), per-step tour shots (`TOUR_SHOTS=1`), the
autoplay spec's notes and status lines, and one fix: typing the chart prompt stops once the composer is sent or edited
(the complete spec used to send at "Show payroll cost" while the letters kept coming). The branch and its round 2 notes
below are kept as they were.

Round 2 notes:

- Round 2 merged `feat/rich-seed` (389f157) and then main at c8b5928, which already contains rich-seed round 2. The
  only conflict was Home's lucide import (the tour's Compass and rich-seed's UserRoundCheck). `feat/tour` now merges
  into main with no conflict. It is not merged into main and not pushed.
- Two files outside the tour that round 2 changed: `packages/seed/src/rich/index.ts` (one memory thread in
  `MEMORY_DOCS`) and `apps/web/src/components/portal/w4-people.tsx` (the `useMemo` fix).
- `packages/contracts/src/ext/tour.ts` (`SimResetBody`, `HealthSeedProfile`) can be folded into the frozen contracts
  (`.scratch/contract-requests/tour.md`).

## Live

Round 2 ran one opt-in live autoplay pass on the rich world (gpt-5.6-luna, `WEFT_LIVE_USD_CAP=0.05`, tracing off): 150 s,
$0.0037, the notice run in 9.0 s and the chart step in 5.5 s, both inside their soft timeouts, so no fallback copy
showed. With round 1's pass (base world, 142 s, $0.0038) that is two of two passes inside the soft timeouts, $0.0075
of the $0.40 cap (`weft-notes/tour-spend.json`). A third pass was not run.

## Engine fixes (tp/engine, 2026-10-18)

Nitish's step 10 report and the QA pass behind it (ring over the flag popover, a stale ring, a popover over the
sidebar, the card over the docked agent panel) came from three engine gaps. Fixed at the root:

- Layering. The ring and the secondary marks were a fixed `z-[70]`, above every app layer. They now paint one above
  the target's own layer, never below 45 and never at the card's 70 (`ringZFor` in `layout.ts`): 45 for page content,
  so every z-50 popover, menu and drawer the step or the person opens paints over the ring; 51 inside the expense
  drawer. The ring is a 2 px border plus a 2 px inset halo inside its 4 px pad (`tour.css`), so it never paints over
  the text next to the target.
- Measurement. `useFrameValue` reads the target once per animation frame while a step shows, so a move with no resize
  and no DOM insertion (a text or style change above the table, a CSS transition) is followed within a frame. The
  ring is cut to where the target is visible (the viewport and every overflow-clipping ancestor: the main pane under
  the header, a table that scrolls sideways, the agent thread), and a side where the target runs on fades out
  instead of drawing an edge (`data-clip`). A target hidden under another sheet (the phone's agent sheet, the
  tablet's overlay panel) gets no ring and an unanchored card. `scrollToView` leaves a 16 px margin so a
  `block: "start"` target is not flush against the header or the window top.
- Card placement. `placeCard` (`geometry.ts`, pure, unit-tested) works inside the content column (right of the
  sidebar, left of the agent panel, docked or overlaid) and scores every side and free spot against the target, the
  open app layers (popovers, menus, drawers, read every frame) and the step's secondary marks and new `avoid`
  selectors. It narrows to 260 px beside a tall target or a tall menu before covering anything; with no clean spot
  left it drops under the app's layers (z 49) rather than over the menu the person opened. The card sits on a point
  anchor at the computed spot (`updatePositionStrategy: "always"`). Targets in the agent panel put the card left of
  it, in the main column. The unanchored card centres on the content column, not the window.
- Steps: payroll flags scrolls the group low enough for the card to fit above it (`cardAbove`), since its popover
  drops below; audit avoids the newest two rows and the rate change row; permissions avoids the matrix; the portal
  avoids the checklist items.
- The flag popover (`flag-chip.tsx`) aligns to the chip's start, uses the app's main pane as its collision boundary
  (`appMain()`, `data-app-main` on the shell's `<main>`) and scrolls inside the available height.
- Tests: `apps/web/test/tour-geometry.test.ts`, and `e2e/tour/tour-layout.spec.ts` at 1280x800 and 1440x900 with the
  panel docked (ring encloses the visible target and hugs it within 6 px on 16 steps; no card over the target, an
  open layer, the sidebar or the panel; the flag popover paints over the ring, checked by hit-testing the ring's edge,
  and stays inside main; the ring follows a style-only move; the env pill's three popovers and menu).
