# Track w3-topbar-shell: a coherent app top bar and shell

Wave 3 track (docs/wave3.md section 4), implementing `research/wave3/topbar-design.md`: decisions D1 to D8 in its
section 4, the spec in section 5 and the shell fixes in section 7 (docs/wave3.md counts these as D1 to D11). Branch
`track/w3-topbar-shell`. E2E ports 4610 (web) and 4611 (API). Two rounds; the second hardened the tests and fixed
two small bugs (below).

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

## How to run it

- See it: `pnpm dev` and open any `/app` page. Resize the window, dock or undock the agent (the PanelRight toggle) and
  hide the sidebar to walk the three tiers; Tab from the page top to walk the bar.
- Unit: `pnpm vitest run --project @weft/web test/w3-topbar-shell` (both files, 28 tests).
- E2E: `WEFT_E2E_WEB_PORT=4610 WEFT_E2E_API_PORT=4611 pnpm e2e e2e/site-topbar.spec.ts` (GP19, two tests, about
  35 s with the server start). The full suite: `WEFT_E2E_RUNNER_PORT=4612 WEFT_E2E_WEB_PORT=4610
  WEFT_E2E_API_PORT=4611 pnpm e2e` (about 3 minutes). Set the runner port too: `site-dev-runner.spec.ts` otherwise
  takes 4216 and 4217, which parallel tracks share; one round 2 run failed there on a collision and passed on 4612.
- Lints: `pnpm lint:prose`, `pnpm lint:brand`, `pnpm brand:overlap`.

## Real versus simulated

Everything in the bar is real UI over real API routes; nothing in this track simulates a vendor.

- **Model segment** reads `GET /v1/health` (the provider the API process started with) and, only while its popover is
  open, `GET /v1/agent/costs` (the spend ledger). It never calls a model and has no switching UI: the provider is
  fixed per API process (`WEFT_LLM`). In e2e and the demo the provider is the scripted one, shown as a hollow gray
  dot and "Scripted".
- **Clock segment** reads `GET /v1/sim/clock`; its buttons call `POST /v1/sim/clock/advance`. The clock is Weft's
  simulated business clock, so the popover title and the accessible name both say "Simulated time".
- **Viewing as** is a demo control: it switches the dev-auth principal (`x-weft-principal`) between the demo humans
  in `PRINCIPALS`, and new-hire items open `/portal?as=...`. The menu label and footer say so. It is not real auth.
- **Sidebar** "Simulated" trailing text marks the products whose vendors are simulated (Benefits, IT, Contractors,
  Integrations, Simulators). "Coming soon" stays on Expenses and Time Off until w3-expenses and w3-timeoff merge.

## Tests

- Unit, `apps/web/test/w3-topbar-shell.test.tsx` (pure rules, 16 tests): model state and labels, accessible names
  (scripted, local, loading), spend format, long clock, rate, next routine slot, initials, persona grouping, shortcut
  label, tiers, breadcrumb titles, the status map against every contract status enum, page widths.
- Unit, `apps/web/test/w3-topbar-shell.render.test.tsx` (static render with the data hooks stubbed, 12 tests): pill
  order and the wave 1 test ids on their controls, segment shape and inset ring classes, every icon button `size-8
  rounded-lg` (never `icon-sm`), `aria-controls`, `aria-expanded` and `aria-pressed` wiring, the search icon only
  without the sidebar, full accessible names, no `title` tooltips, two polite live regions, no badge wash or accent in
  the bar, the `@container` on a wrapper, the mono id crumb while loading, the sidebar head (id, two-line workspace
  row, one kbd chip, one pill, no chevrons), and the agent panel X only in overlay.
- E2E GP19, `e2e/site-topbar.spec.ts`, test 1: at 1440 and 1280 docked, 1024 and 390, `header.scrollWidth <=
  clientWidth`, every bar control 32 px, every segment 28 px, no green-3 fill and amber only on the avatar, the model
  segment has no fill; Tab walks sidebar toggle, the People crumb, model, clock, persona and agent toggle and each
  shows the blue ring; the persona menu is a radio menu and the `viewAs` fixture switches personas; the clock popover
  advances time and the model popover shows spend; sidebar search, Cmd or Ctrl+K and the bar search icon all open the
  command menu; person and payroll crumbs show names.
- E2E GP19, test 2: Full text at 1440 docked ("Viewing as Dana", the long clock) and Compact at 1280 docked (first
  name, short clock); Enter opens the persona menu on a radio item, ArrowDown moves, Esc closes and returns focus to
  the trigger; the same for the clock popover; New agent thread opens a closed panel with the composer focused; the
  docked panel has no X and the 1024 overlay does; at 390 the model is the dot alone, Tab walks toggle, search icon,
  model, clock, persona and agent toggle with the ring on each; the 390 drawer has the sidebar search, which closes
  the drawer and opens the command menu.
- `e2e/gp6-offer-portal.spec.ts` line 34 opens the persona menu and finds the candidate's `menuitem` by name, with
  `data-persona="portal:<id>"`.

## Round 2 fixes

- The scripted model's accessible name read "Model: Scripted, no model, scripted, no model calls"; it now reads
  "Model: Scripted, no model calls".
- A `CrumbLabel` that unmounted cleared the crumb title even when another label for the same page was still mounted;
  it now clears only its own title.

## Contract changes

- Additive, in its own commit (`contract: W3_TOPBAR_SHELL_DOM and W3_TOPBAR_SHELL_TIERS`):
  `packages/contracts/src/ext/w3-topbar-shell.ts` exports `W3_TOPBAR_SHELL_DOM` (`sidebar: "weft-sidebar"`,
  `agentPanel: "weft-agent-panel"`) and `W3_TOPBAR_SHELL_TIERS` (`fullMin: 760`, `compactMin: 480`), re-exported from
  `packages/contracts/src/w3/testids-shell.ts` with one export line. `W3_SHELL_TID` is unchanged.
- Component API changes inside owned files (not contracts): `crumbs(pathname, recordTitle?)` takes an optional record
  title and returns `Crumb` with an optional `id` flag; `AgentPanel` takes optional `id` and `overlay`; `Header` takes
  `sidebarVisible` and `sidebarExpanded`; `Sidebar` takes `id` and `onOpenSearch`; `PageHeader` takes `crumb`.
- No frozen contract, test id, route or token changed. `TID.providerBadge`, `TID.simClock`, `TID.viewingAs` and
  `TID.cmdkInput` stay on their controls; the `--tb-*` and `--page-w-*` tokens are consumed as they landed.

## Contract requests

Written to `.scratch/contract-requests/w3-topbar-shell.md` as well.

1. **The manager persona.** The persona menu groups `PRINCIPALS` (in `apps/web/src/lib/api/mocks/world.ts`, owned by
   t5-app) by role, so Imani shows under Managers as soon as she is in that list with `role: "manager"`. w3-timeoff
   seeds `usr_imani`; whoever merges it should add `{ id: "usr_imani", name: "Imani ... (demo)", title: ..., role:
   "manager" }` to `PRINCIPALS`, and `hooks.ts` already restores any id in that list from local storage. No change in
   this track's files is needed. The unit test already covers a manager in the list.
2. **Typed costs.** `GET /v1/agent/costs` is `unknown` in `apps/web/src/lib/api/client.ts`; the model popover casts it
   to `{ day, daySpentUsd, liveSpentUsd }`. Adding `"GET /v1/agent/costs": CostRollup` to `Responses` would remove
   the cast.
3. **Focus ring base rule.** Design 7.8 suggests one `:focus-visible` rule in `apps/web/src/app/globals.css` (not
   owned here). The bar and sidebar set the ring per control instead, so nothing depends on it.
4. **Reduced motion on popovers.** Design 5.5 asks `PopoverContent` (`packages/ui/src/components/popover.tsx`, not
   owned here) to skip its open animation under reduced motion. The bar's two popovers pass
   `motion-reduce:data-[state=open]:animate-none` themselves, and `DropdownMenuContent` has it built in.

## Left (left.md)

Also in `.scratch/w3-topbar-shell/left.md`. Everything the cut line names landed (the bar, tokens, persona menu, focus
ring, three tiers, GP19), and so did the sidebar search move, breadcrumb titles, the badge, workspace row, chevron and
agent panel fixes. What is left:

- **Drop "Coming soon"** from Expenses and Time Off in `nav.ts` (`badge: "soon"` on both items) when w3-expenses and
  w3-timeoff merge. SPEC 11.3 already describes the merged sidebar. If nothing else carries `"soon"` then, the
  `soon` badge kind and its `TRAILING` entry in `sidebar.tsx` can go too.
- **Adopt `StatusBadge`** in the views that render statuses today (payroll list and review, People, Home, Hiring,
  Offboarding, Compliance, Routines, Benefits, Contractors). Those files belong to other owners; each swap is a
  one-line change from `<Badge tone={X_TONE[s]}>{s}</Badge>` to `<StatusBadge status={s} />`. Watch e2e assertions
  that read lowercase status text (`payroll-status` uses `data-status`, which `StatusBadge` keeps).
- **Adopt `PageBody`** in the views with ad hoc max widths (1100, 1200, 1000, 880, 1040, 760): People, Payroll run and
  Audit should be `wide`, Settings and forms `narrow`, everything else `default`.
- **More crumb titles**: offers, routines (`/app/routines/[id]`), runs (`/app/runs/[id]`), offboarding cases
  (`/app/offboarding/[id]`) and the wave 3 detail pages can pass `PageHeader crumb=...` or render `<CrumbLabel>`.
  Those page files belong to other owners.
- **Dark mode tokens** (design 5.9) wait for an app dark mode.
- **Clock advance permissions**: the API accepts any principal (design 9, flagged only).

## Model segment removed (2026-10-20)

The environment pill now holds two segments, the simulated clock and then Viewing as, with one divider between them.
`ModelSegment`, its status dot, its popover (`W3_SHELL_TID.modelPopover`) and its polite live region are gone from
`env-pill.tsx`, so the bar shows no provider name, model id or spend, and its only fill color is the amber persona
avatar. The tables above describe the bar as this track built it.

- `TID.providerBadge` and `W3_SHELL_TID.modelPopover` stay in the contracts (frozen ids) but no control in the bar
  carries them. The model helpers in `env.ts` (`modelState`, `MODE_LABEL`, `modelLabel`, `modelAria`, `fmtUsd`) stay
  and keep their unit tests in `w3-topbar-shell.test.tsx`.
- `w3-topbar-shell.render.test.tsx` checks the pill order (clock, Viewing as), one divider, one polite live region (the
  persona switch), no status dot and no provider badge, model state, "Scripted" or "Model:" text in the bar.
- GP19 (`e2e/site-topbar.spec.ts`) expects the segments clock then persona at every width, no model chip or model
  text in the bar, and the Tab order sidebar toggle, the People crumb (or the search icon at 390), clock, persona and
  agent toggle.
