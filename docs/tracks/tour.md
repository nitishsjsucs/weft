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

## Review round 2 fixes (tp/merged, 2026-10-18)

The QA pass on tp/merged at 1280x800, 1366x768, 1440x900, 1512x982 and 390x844 found these; all fixed at display
time or in the rich layer, so base digests, base e2e and eval digests are unchanged:

- The card's drop under the app's layers never reached its stacking context: Radix Popper copies the content's
  z-index to `[data-radix-popper-content-wrapper]` once, when the content mounts, so the wrapper stayed at 70 and the
  card's corner painted over a flag popover lower in the group. `tour.css` sets the wrapper to 49 whenever it holds a
  card with `data-under-layer`. `tour-layout.spec.ts` now opens every flag in the Needs Review group at 1280x800 and
  1366x768 and checks the card is under any popover it overlaps.
- Escape at step 10 exited the tour instead of closing the flag popover the step opened: the card is a Radix layer
  that mounts after that popover, so it was the top layer and got Escape first. The card now closes an open app
  popover through its trigger (`closeAppPopover` in `layout.ts`) and exits only when none is open; the flag sweep
  above presses Escape between flags, so it covers this.
- The phone sheet reads the target and the open app layers every frame (`sheetEdge` in `geometry.ts`, unit-tested):
  it moves to the other edge when its own covers the target or an open menu and the other edge is clear (the chart's
  head at step 11), and drops under the layers (z 49) when no edge clears an open menu (the Viewing as menu at step
  2). `data-sheet` still names the step's edge; `data-sheet-edge` is where the sheet is.
- One display helper for server text, `apps/web/src/components/app/copy.ts`: `humanCopy` (moved from `flag-text.ts`),
  `humanLine` (step lines, routine summaries, proposal headlines: a payroll run id reads as "the Oct 30 run", an id
  after the noun it names goes, a bare id becomes its noun, parenthesized id lists and "(#n)" go), `humanDateText` and
  `humanDateLists` (a run of days is "Nov 23 to Nov 25"), and `enumWords` ("in review to resolved"). Used by the agent
  panel's step lines, a routine run's summary (a chat answer keeps the result id it cites, which GP5 pins), the
  approval card and the Inbox card's headline and diff, the time-off coverage line, the expense policy checks, the
  payroll page's "compared with the Oct 15 run" and the rate table's source ("DE 2088 notice", "audit #229").
- `humanDates` formatted no date followed by a colon, so the chart step line read "Nov 1 to 2026-10-26: 10 months"; only
  a colon and digits (a time) excludes a date now.
- The Inbox card's routine run id sits behind the word Routine (a `details` disclosure), and a linked evidence chip
  shows its label, not the raw ref (the link and its title carry it). The expense drawer's subtitle drops the id.
- Rich layer: the NEW_IN_RUN note no longer repeats the start date (the headline and the evidence give it), the
  seeded submit proposal's evidence names the excluded person, and the seeded chat answer says "a gross change flag".
- The ring draws only its inset halo on a side whose pad an overflow-clipping parent took away (`tightSides`,
  `data-tight`), so at step 20 no border runs along the agent row's own edge. The pulse fades the ring's opacity
  instead of its border color, so that side stays halo only.

Left: steps 5 and 18 still ring targets with no inner padding (the halo sits 2 to 3 px from the label); the chat
system prompt still lets a live answer cite a result id ("Source: res_0234"), since the drafting rule and GP5 ask for
cited ids; the expense drawer is still a full-height modal over the docked agent panel (app behavior).

## Review round 3 fixes (tp/merged, 2026-10-18)

- The app shell jumped up and snapped back on steps 12 to 20. Root cause: the chart answer's screen reader table
  (`sr-only`, position absolute) had no positioned ancestor, so its containing block was the initial containing block:
  it escaped the agent thread's and the shell's overflow clips and made the document 285 px taller than the window.
  Each step's `scrollIntoView` then scrolled the document too, and a 450 ms `resetDocScroll` snapped it back. Fixed
  at the root: the chart card, the agent thread and the main pane are positioned, and the shell grid is
  `relative overflow-clip` (clip, unlike hidden, is not a scroll container), so nothing in /app can make the
  document scroll again. `scrollToView` (`dom.ts`) scrolls only the target's own scroll containers (the document
  only outside the app shell, the portal) and `resetDocScroll` is gone.
- The ring trailed a smooth scroll by a frame or more. `scrollToView` now resolves once every container it moved has
  reached its end position (900 ms cap), and the step sets the ring and the card after that, so both are placed on the
  settled page. The ring also writes its box in the animation frame it reads the target (`useFrameValue`'s
  `onFrame`), so a later move (a drawer, a style change) is followed in the same frame.
- `tour-layout.spec.ts` walks the real path from the notice to the chart at 1280x800 and 1440x900 (so the agent thread
  holds the notice run and the chart, taller than the panel) and checks every frame of steps 12 to 20: the document
  never scrolls, is never taller than the window, and the ring never trails its target by more than 2 px. Without
  the containment it fails with "the document is taller than the window: 285".
- On a phone, routines and integrations scroll their target's head to the top and dock the sheet at the bottom, so
  the gallery's first routine and the Greenhouse title are not under the sheet. A `block: "start"` step with a top
  sheet leaves the sheet's height above the target (`sheetRoom`).
- Copy on the path: the audit table names a routine by its name (the run id in the title), reads each summary through
  `humanLine` (the stored text in the title), says "from an approved proposal" and "Agent run" with the ids in titles,
  and sets the Command cell in mono, breaking only after a dot ("notices." / "draft_response"), never inside a
  word (one unbroken line overflowed the table at 1440 px, which `e2e/rich-data.spec.ts` checks). `noticeName` does not double "notice" ("UI rate notice"); one
  `auditLabel` ("audit #N") on the rates table, the person page, the approval card and the document library. The
  memory chip reads "updated Oct 26". Flag evidence dates in the period's year read without one, as the headline does.
  New-hire personas in the Viewing as menu read "(demo)". The rate step avoids the other rate rows, so the card goes
  below the table.
- Rich layer: a new pay rate note gives its unit ("$139,240.00 a year") from the rate's kind, and the hours spike note
  says what was computed and leaves overtime to the workweek instead of stating a per-period rule. Both stay grounded.
- API: `keepAliveTimeout` 65 s and `headersTimeout` 66 s, so the web proxy never sends on a keep-alive socket the
  server is closing (the ECONNRESET 500s seen once at 1512x982).

Set aside:

- The CA EDD response letter (`responseTemplate`, `packages/core/src/notices/writes.ts`) still cites the notice's row
  id and ISO dates. It is the text that gets filed, so it can only change in core, and that moves the base and eval
  digests this round must keep; it needs a re-pin with a review log note.
- Audit sequence order on the rich world: the base world's raise is #1 (Oct 9, 2026) and the rich layer appends ten
  months of earlier history after it (#2 is Dec 19, 2025). The honest fixes are re-sequencing the chain (every
  `createdActionSeq`, `executedActionSeq`, `reversesSeq` and signature reference moves) or an imported-history marker
  on the rows, which needs a column or a contract field; both are larger than this round.
- Step 10 at 1280x800 and 1366x768: when a lower flag's popover opens upward over the card's spot, the card drops
  under it as designed and its Back button is under the popover until the popover closes (Escape). The content column
  is too narrow there (about 660 px with the panel docked) for a 260 px card beside a 360 px popover, and weighting
  the card's button strip only moved the card onto the group; it needs a different layout (the card docked in the
  agent panel's column, or a compact card) rather than a scoring change.
- Step 6 on a phone: the inbox card is taller than the space beside the sheet, so either the head or the diff and
  evidence are under the sheet; it needs the card to collapse its sections on a phone.
- Audit routine run ids made during the tour are random (`rtr_mveqy7jqe8e097`), from the routine runtime's id
  generator, not the seed's counters; the table now shows the routine's name instead.

## Demo-perfect round 1, layout and UI (dp/r1-layout-and-ui, 2026-10-18)

Three of round 3's set-asides are fixed in the engine, not by scoring:

- Step 10 docks its card in the docked agent panel's column (`dockPanel` on the step, `panelSpot` in `geometry.ts`,
  `dockedPanelRect` in `layout.ts`). Every flag popover is bounded by the main pane, so none can reach the card and
  Back and Next stay clickable while any flag is open. `tour-layout.spec.ts` hit-tests both buttons for every flag at
  1280x800 and 1366x768; the card-over-panel check allows the panel only for a card placed there (`data-place="panel"`).
- Step 4 is `agent: "after"`: the panel opens only where it docks. On a phone or tablet it stays closed, so the real
  Deliver button is visible and tappable, and Deliver's own `watch` opens the sheet for step 5. A 390x844 spec checks it.
- Step 6 on a phone: the proposal card reads its four facts as one line and clamps the agent note to three lines below
  640 px, so the diff, the evidence and Approve fit above the bottom sheet.
- Step 16 (portal) docks the card at the bottom of the content column under 1400 px (`dockBottomUnder`), so it never
  covers the checklist items' status.
- Step 18 (routines) also docks in the panel's column (integration of round 1): with the gallery's last and next run
  lines and two cards a row at 1280 docked, the gallery left no clear spot, and the geometry spec caught the card over it.
- `scrollToView` keeps a target wider than its scroll box (a table row) at its inline start, so the tour never scrolls
  a table's first columns away. The rates table also fits a 600 px column now (state and code in one cell).

Shared pieces: `packages/ui/src/controls.css` draws every native select and date field with the app's chevron and
calendar marks, and `useEdgeFade` fades the edge a wide table or tab strip runs past. The rich crawl fails on a
control with `appearance: auto` or a table scroller that ends past the main pane.
