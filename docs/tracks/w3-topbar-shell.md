# Track w3-topbar-shell: a coherent app top bar and shell

Wave 3 track (docs/wave3.md section 4), implementing `research/wave3/topbar-design.md` D1 to D8 and the shell fixes in
its section 7. Branch `track/w3-topbar-shell`. E2E ports 4610 (web) and 4611 (API).

## What exists

| Item | Where | What it does |
|---|---|---|
| The bar | `apps/web/src/components/app/shell/header.tsx` | 48 px strip inside an `@container` wrapper (the old header declared `@container` on itself, so its own container classes never applied). Sidebar toggle (`aria-expanded`, `aria-controls`), breadcrumb (14 px; parents gray-11, current ink), a ghost search icon only while the sidebar is hidden, the environment pill, and the agent toggle (one PanelRight icon, `aria-pressed`, gray-a3 fill when pressed). Every control is `Button ghost size=icon`, 32 x 32 at radius 8. |
| Environment pill | `shell/env-pill.tsx`, `shell/segment.ts` | One white container with the ring edge, 32 px with a 2 px pad. Segments are 28 px at radius 6, 13 px labels, gray-a3 hover, gray-a4 while open, an inset 2 px blue-9 focus ring. 1 x 16 dividers hide next to a hovered or open segment. `role="group"`, `aria-label="Demo environment"`. |
| Model segment | `env-pill.tsx` (`ModelSegment`), `env.ts` | 8 px status dot: green-9 hosted live, blue-9 local, hollow gray-8 ring scripted, red-9 when health fails, pulsing gray-6 while loading. Full tier shows the provider label, Compact the model id ("Scripted" for the scripted provider), Mini only the dot. Popover: mode, model id, spent today and live total from `GET /v1/agent/costs` (fetched only while open), and a note that the model is fixed per API process. Keeps `TID.providerBadge`. |
| Clock segment | `env-pill.tsx` (`ClockSegment`) | "Mon, Oct 26, 8:30 AM" in Full, "Mon 8:30 AM" below (no icon in Mini). Popover titled Simulated time: the long date with PT, Rate (Paused, Real time or Nx), Next routine (the same 09:00 PT weekday rule the API uses for `toNext: "cron"`), and +1 hour, +1 day, Next routine buttons calling `POST /v1/sim/clock/advance`, plus a link to Simulators. Keeps `TID.simClock` and `data-now`. |
| Viewing as | `shell/persona-menu.tsx` | Radix `DropdownMenu` (new `packages/ui` component) replacing the opacity-0 native select. Label "Viewing as (demo control)", radio items (`menuitemradio`) grouped by role (Admins, Managers, Employees; empty groups hidden, group labels only when there is more than one), each with a 20 px amber initials avatar, name, then "title, role". New-hire portal personas follow as plain items (`data-persona="portal:<id>"`) that open `/portal?as=...`. Footer explains it is dev auth only. Trigger keeps `TID.viewingAs`; Full shows "Viewing as Dana", Compact "Dana", Mini the avatar alone (28 px square). |
| Tiers | `env.ts` (`tierFor`), Tailwind `@min-[480px]` and `@min-[760px]` | Full from 760, Compact from 480, Mini below, by the header's own width. Measured on the e2e world: 1440 docked header 855 px (Full), 1280 docked 695 (Compact), 1024 779 (Full), 390 (Mini); no overflow at any of them. |
| Screen reader | `env-pill.tsx`, `persona-menu.tsx` | `aria-live="polite"` announcements for a model state change and a persona switch; every segment's `aria-label` carries the full meaning the narrow tiers drop. `title` tooltips are gone. |
| Sidebar head | `shell/sidebar.tsx` | Two-line workspace row ("Larkspur Robotics" over "Demo workspace, Admin"), then a 32 px search field with one platform kbd chip ("⌘K" or "Ctrl K") and a square New agent thread button (clears the thread, opens the panel, focuses the composer). Cmd or Ctrl+K still opens the command menu on every page. |
| Sidebar badges | `shell/sidebar.tsx` | One pill style only: the Inbox count (18 px, radius 9, 11/600 tabular, accent). "Simulated" and "Coming soon" are quiet trailing 12 px gray-9 text. Group labels lost their inert chevrons. |
| Breadcrumb titles | `shell/crumbs.tsx`, `nav.ts` (`crumbs`), `people/[id]/page.tsx`, `payroll/[id]/page.tsx`, `page.tsx` (`PageHeader crumb`) | `BreadcrumbProvider` in the shell; `<CrumbLabel label>` (or `PageHeader crumb="..."`) registers the record title for the current path. Person pages read "People > Dana Whitfield (demo)", payroll runs "Payroll > Sep 1 to Sep 15". While a record loads the id shows in 12 px mono gray-11. |
| Agent panel header | `agent/agent-panel.tsx` | Buttons are 32 px (`size=icon`); the X shows only when the panel overlays the page (`overlay` prop, below 1280). The panel has `id="weft-agent-panel"` for the toggle's `aria-controls`. |
| Page widths | `page.tsx` (`PageBody`) | `width="default" | "wide" | "narrow"` on the `--page-w-*` tokens with one padding (`px-4 py-6`, `tablet:px-8 tablet:py-8`). `Placeholder` uses it. |
| Status map | `apps/web/src/components/app/status-badge.tsx` | `StatusBadge` and `StatusText` over one status-to-tone map in sentence case (green done, blue moving, amber waiting on a person, red failed, gray inert), with per-kind overrides where a word means something else (an offboarding step's pending, a reconciliation's open). Covers every status enum in the contracts, wave 3 included. |
| UI primitives | `packages/ui/src/components/dropdown-menu.tsx`, `kbd.tsx` | `DropdownMenu*` styled like `PopoverContent` (radius 12, menu shadow, gray-a3 highlight, reduced motion respected). `Kbd` is one 18 px chip for a whole shortcut; `shortcutLabel(key, platform)`. |
| Contract (additive) | `packages/contracts/src/ext/w3-topbar-shell.ts`, re-exported from `w3/testids-shell.ts` | `W3_TOPBAR_SHELL_DOM` (the sidebar and agent panel ids) and `W3_TOPBAR_SHELL_TIERS`. No frozen contract changed. |

## Tests

- Unit: `apps/web/test/w3-topbar-shell.test.tsx` (model state and labels, accessible names, spend format, long clock,
  rate, next routine slot, initials, persona grouping, shortcut label, tiers, breadcrumb titles, the status map against
  every contract status enum, page widths).
- E2E: `e2e/site-topbar.spec.ts` (GP19): at 1440 and 1280 docked, 1024 and 390, `header.scrollWidth <= clientWidth`,
  every bar control 32 px, every segment 28 px, no green-3 fill and amber only on the avatar, the model segment has no
  fill; Tab walks sidebar toggle, the People crumb, model, clock, persona and agent toggle and each shows the blue
  ring; the persona menu is a radio menu and the `viewAs` fixture switches personas; the clock popover advances time
  and the model popover shows spend; sidebar search, Cmd or Ctrl+K and the bar search icon all open the command menu;
  person and payroll crumbs show names.
- `e2e/gp6-offer-portal.spec.ts` line 34 now opens the persona menu and finds the candidate's `menuitem` by name, with
  `data-persona="portal:<id>"`.
- Run: `WEFT_E2E_WEB_PORT=4610 WEFT_E2E_API_PORT=4611 pnpm e2e e2e/site-topbar.spec.ts`.

## Contract requests

Written to `.scratch/contract-requests/w3-topbar-shell.md` as well.

1. **The manager persona.** The persona menu groups `PRINCIPALS` (in `apps/web/src/lib/api/mocks/world.ts`, owned by
   t5-app) by role, so Imani shows under Managers as soon as she is in that list with `role: "manager"`. w3-timeoff
   seeds `usr_imani`; whoever merges it should add `{ id: "usr_imani", name: "Imani ... (demo)", title: ..., role:
   "manager" }` to `PRINCIPALS`, and `hooks.ts` already restores any id in that list from local storage. No change in
   this track's files is needed.
2. **Typed costs.** `GET /v1/agent/costs` is `unknown` in `apps/web/src/lib/api/client.ts`; the model popover casts it
   to `{ day, daySpentUsd, liveSpentUsd }`. Adding `"GET /v1/agent/costs": CostRollup` to `Responses` would remove
   the cast.
3. **Focus ring base rule.** Design 7.8 suggests one `:focus-visible` rule in `apps/web/src/app/globals.css` (not
   owned here). The bar and sidebar set the ring per control instead, so nothing depends on it.

## Left (left.md)

Everything the cut line names landed (the bar, tokens, persona menu, focus ring, three tiers, GP19), and so did the
sidebar search move, breadcrumb titles, the badge, workspace row, chevron and agent panel fixes. What is left:

- **Adopt `StatusBadge`** in the views that render statuses today (payroll list and review, People, Home, Hiring,
  Offboarding, Compliance, Routines, Benefits, Contractors). Those files belong to other owners; each swap is a
  one-line change from `<Badge tone={X_TONE[s]}>{s}</Badge>` to `<StatusBadge status={s} />`. Watch e2e assertions
  that read lowercase status text (`payroll-status` uses `data-status`, which `StatusBadge` keeps).
- **Adopt `PageBody`** in the views with ad hoc max widths (1100, 1200, 1000, 880, 1040, 760): People, Payroll run and
  Audit should be `wide`, Settings and forms `narrow`, everything else `default`.
- **More crumb titles**: offers, routines (`/app/routines/[id]`), runs and wave 3 detail pages can pass
  `PageHeader crumb=...` or render `<CrumbLabel>`.
- **Drop "Coming soon"** from Expenses and Time Off in `nav.ts` when w3-expenses and w3-timeoff merge (SPEC 11.3
  already describes the merged sidebar).
- **Dark mode tokens** (design 5.9) wait for an app dark mode.
- **Clock advance permissions**: the API accepts any principal (design 9, flagged only).
