# Wave 3: a coherent app top bar and shell

Researched 2026-10-16 against main at `4b18f99`. Method: a scratch clone ran `pnpm dev --e2e --web-port 4580 --api-port 4581` (scripted provider, clock frozen at Mon Oct 26 8:30 AM PT). Playwright 1.64 drove installed Chrome at 1440, 1280, 1024 and 390 px, took screenshots and read `getComputedStyle` and `getBoundingClientRect` for every top bar element. To see the live state Nitish sees, the `/api/v1/health` response was rewritten in the browser to `{label: "OpenAI gpt-5.6-luna", live: true}`. No live model was called. The server and clone were stopped and deleted afterwards.

Tags: **[V]** I measured or reproduced it myself. **[C]** read from the Weft code at the path given. **[R]** from the Warp reference mockups as described in `research/design.md` section 10 and seen in `research/design/reference/shots/mock-*.png` (gitignored, never commit). No Warp copy appears below.

Artifacts in this folder (all Weft's own UI, safe to commit):
- `topbar-shots/current-topbar.png`: today's top bar at 1440 live, 1440 scripted, 1280, 1024 and 390, plus the persona picker with keyboard focus.
- `topbar-shots/current-app-1440.png`: the whole shell at 1440.
- `topbar-mockup.html`: the proposed bar, rendered in plain HTML and CSS with Weft tokens. `topbar-shots/proposed-topbar-mockup.png` is a render of it.

## 1. What is on screen today (measured)

Source: `apps/web/src/components/app/shell/header.tsx` [C]. All figures are at a 1440 px window, with the agent docked and a header 855 px wide [V].

| # | Element | Box (w x h) | Radius | Fill / edge | Text | Icon |
|---|---|---|---|---|---|---|
| 1 | Sidebar toggle (`Button ghost icon-sm`) | 28 x 28 | 6 | transparent | | PanelLeft 16, gray-11 |
| 2 | Breadcrumb `nav` (flex-1) | 181 x 20 | | | 14/400 gray-11, then 14/500 ink | ChevronRight 14 |
| 3 | Search trigger (wrapper flex-1, button max 320) | **181** x 32 | 8 | white, **CSS border** 1px `#e5e5e5`, shadow-xs | 14/400 gray-9, cut to "Search or ..." | Search 16 |
| 3a | Kbd chips "⌘" and "K" | 19 x 16 and 17 x 16, **9 px apart** | 4 | white, CSS border `#e5e5e5` | 10/400 gray-11; the ⌘ glyph sits low | |
| 4 | Model badge (`Badge tone=green size=md`, a `span`) | 134 x 24 | 6 | **green-3 `#e6f6eb` wash**, no edge | 12/500 green-11 `#218358` | none |
| 4' | Same badge, scripted (`tone=outline`) | 125 x 24 | 6 | white + ring `#00000014` | 12/500 gray-11 | none |
| 5 | Sim clock (`a` to /app/simulators) | 114 x 28 | 8 | **gray-3 `#efefef` fill**, no edge | 12/500 ink, tabular | Clock **14** |
| 6 | Persona picker (`label` over a native `select` at opacity 0) | 136 x 24 | 8 | transparent + ring `#00000014` | "Dana" 12/500 | ChevronDown **12** |
| 6a | "Demo control" badge nested in 6 | 73 x 16 | 6 | amber-3 `#fff8e7` | **10/500** amber-11 `#ac6500` | |
| 7 | Agent toggle | 28 x 28 | 6 | open: `secondary` (white + ring + shadow); closed: ghost | | open: PanelRight; closed: **Sparkles** |

Header: 48 px tall, padding `0 8px`, gap 6 px [V computed]. The classes `@min-[560px]:gap-2 @min-[560px]:px-3` sit on the same element that declares `@container`. An element cannot query itself, so those classes never apply at any width [V: 1440 still computes to padding 0 8px and gap 6px].

Responsive behavior today [V]:
- **1440** (header 855): the search box is squeezed to 181 px. It sits between the breadcrumb and the badges, so it is neither centered nor left-aligned. The "Sim" prefix and the full date only show when the container is at least 900 px wide, so a docked layout never shows them. The clock reads "Mon 8:30 AM" with nothing marking it as simulated.
- **1280** (header 696): the agent docks at 80rem (`app-shell.tsx`), and the bar drops below its 720 px container breakpoint, so search collapses to a bare icon.
- **1024** (header 779, agent overlays): search shows "Sear..." and the agent toggle turns into a ghost Sparkles icon.
- **390**: the model badge is gone (`hidden @min-[600px]`), so a phone cannot tell whether the live, metered model is on. "Demo control" shortens to "Demo".

Focus [V, keyboard Tab from the sidebar]:
- Buttons show a 2 px `#0090ff` ring with a 1 px white offset.
- The search trigger and the clock link show Chrome's default `#005fcc` outline.
- The persona `select` gets focus with **no visible indicator** (opacity 0). See the last row of `current-topbar.png`.
- Tab order: sidebar toggle, search, clock, persona, agent toggle. The model badge is not focusable, and its explanation lives only in a `title`.

## 2. Diagnosis: why the middle reads as five unrelated parts

1. **Five control heights in one 48 px bar:** 16 (kbd, Demo badge), 24 (model, persona), 28 (icon buttons, clock), 32 (search) [V]. The top and bottom edges never line up, so the eye reads them as separate objects.
2. **Three radii with no concentric logic:** 4, 6 and 8 [V]. The amber badge (radius 6) sits 4 px inside the persona pill (radius 8), which is a pill inside a pill.
3. **Four surface treatments for peer controls:**
   - white field with a CSS border (search);
   - colored wash with no edge (model);
   - gray fill with no edge (clock);
   - transparent with a box-shadow ring (persona).

   Edges also mix two techniques: CSS `border #e5e5e5` and the ring `0 0 0 1px #00000014`. The ring is Weft's and the reference's standard (`--shadow-border`, `research/design.md` section 5).
4. **Three text sizes and three weights in the right half:** 14/400, 12/500, 10/500 and 12/400 [V].
5. **Icons:**
   - Sizes are 16, 14 and 12, all stroke 1.5.
   - The model has no icon, while the clock does.
   - The agent toggle swaps glyphs (Sparkles and PanelRight) as well as fills (ghost and raised white) depending on state and width.
6. **Color semantics collide with page content:**
   - The model badge uses the exact green-3/green-11 pair that Home uses for "Active" registration status (`Badge tone="green"`) [V, same rgb]. A system setting looks like a record status.
   - The amber "Demo control" shares amber-11 with "Due in 2d 8h" on the same screen [V].
   - So green, amber and gray each carry two meanings at once.
7. **No grouping:** every item is 6 px from its neighbors [V]. Model, clock and persona all describe one thing (the demo environment), but nothing groups them. The search box sits between them and the breadcrumb, so it looks like part of the same row of chips.
8. **Mixed interaction models:**
   - The model badge is a static span.
   - The clock is a link that leaves the page.
   - The persona is a native select with its own OS menu.
   - The agent toggle is a button.

   Each looks clickable in a different way, and only two of them are.
9. **The width budget is exhausted.** At the most common desktop layout (1440 with the agent docked, header 855), the controls need about 1030 px at their natural sizes, so the search box absorbs the shortfall and truncates [V: computed from measured widths]. A restyle alone cannot fix this. Something has to move.

## 3. What the reference does [R]

- **Dashboard mock** (`design.md` 10.1):
  - 48 px header with a sidebar toggle on the left;
  - one centered, bordered search field (radius 8, kbd chips);
  - two ghost icons on the right.

  Exactly one bordered control and no colored chips.
- **Agent app mock** (`design.md` 10.2, the newer one):
  - Search moves into the **sidebar**: a white field with radius 8 and a ring, plus a square "+" button beside it.
  - The 44 px content header holds only a panel toggle, a breadcrumb (13 px, gray-11 then ink) and a "+" on the right.
- Controls everywhere are 32 px with radius 7 to 8, hairline rings, and 16 px line icons at stroke 1.5 (`design.md` 1.8 and 6).

Weft needs three things the reference does not have: model, simulated clock and persona. The coherent move is to keep the reference's quiet bar and put those three into **one** control.

## 4. Decisions

- **D1. Search moves to the top of the sidebar,** as in the agent mock [R].
  - Layout: a 32 px field with a 32 px square "New agent thread" button beside it.
  - When the sidebar is hidden (collapsed at 1024 px and up, or a drawer below 1024), a 32 px ghost search icon appears in the top bar.
  - ⌘K / Ctrl+K works everywhere.
  - Rationale: D9's budget problem goes away, and the bar matches the newer reference. This supersedes the header line of `design.md` 13.3 and SPEC 11.3 (`SPEC.md` line 754), which put Cmd+K in the header.
- **D2. One environment pill** groups model, clock and persona, in that order (system, then time, then identity; the identity sits next to the right edge, where account controls usually live).
  - It is one white container with a ring. Each segment is a button with its own popover or menu.
- **D3. One control height (32) and one outer radius (8)** for every top bar control. Pill segments are 28 tall with radius 6, so they nest concentrically inside a 2 px pad.
- **D4. Color carries status only, never decoration.** Inside the bar, color appears in exactly two places:
  - the model status dot;
  - the persona avatar (amber means a demo affordance, matching the existing mock-data banner in `app-shell.tsx`).

  No washes, no colored text. The accent stays out of the bar.
- **D5. One focus style shell-wide:**
  - 2 px `--blue-9` ring;
  - outside controls keep a 1 px offset;
  - pill segments use an inset ring so they don't collide with their neighbors.
- **D6. The agent toggle keeps one icon (PanelRight).** State shows through `aria-pressed` and a gray-a3 fill, never a glyph swap or a raised white fill.
- **D7. The persona control becomes a Radix `DropdownMenu` with `RadioItem`s,** replacing the opacity-0 native select. The e2e helper already supports this; see section 8.
- **D8. Collapse runs on the header's container width,** not the window, because docking the agent changes the header width. Use three tiers: Full, Compact and Mini. Put `@container` on a wrapper, not on the header itself (that is the bug in section 1).

## 5. Spec

### 5.1 Anatomy and order

```
<header 48px, px 12, gap 8, border-b 1px --app-border, bg --background>
  [PanelLeft 32]  [Breadcrumb, flex 1, truncates]  [Search 32, only when sidebar hidden]  [ENV PILL]  [PanelRight 32]
ENV PILL = [● model] | [clock-icon time] | [avatar "Viewing as" name ⌄]
```

### 5.2 Tokens (add to `packages/ui/src/tokens.css` under `/* app shell */`)

```css
--tb-h: 48px;            /* = --app-header-h */
--tb-pad-x: 12px;  --tb-gap: 8px;
--tb-ctl: 32px;    --tb-r: var(--radius-lg);     /* 8: every bar control and the pill */
--tb-seg: 28px;    --tb-seg-r: var(--radius-md); /* 6: pill segments, inside a 2px pad (8 - 2 = 6) */
--tb-seg-px: 8px;  --tb-seg-gap: 6px;
--tb-divider: var(--gray-a4);                     /* 1 x 16 px between segments, 2px margin each side */
--tb-fill-hover: var(--gray-a3);  --tb-fill-open: var(--gray-a4);
--tb-ring: 0 0 0 2px var(--blue-9);
--tb-surface: var(--card);  --tb-edge: var(--shadow-border), var(--shadow-xs);
--tb-text: 13px;  --tb-text-lh: 20px;   /* every control label; the breadcrumb stays 14 */
--tb-icon: 16px;  --tb-chevron: 14px;   /* lucide, stroke 1.5 */
--tb-dot: 8px;    --tb-avatar: 20px;
--status-live: var(--green-9); --status-local: var(--blue-9); --status-off: var(--red-9);
--demo-bg: var(--amber-3); --demo-fg: var(--amber-11);
```

Type in the bar comes down to three sizes, each with one role:
- 14 for the breadcrumb (14/400 gray-11 for parents, 14/500 ink for the current page);
- 13 for every control label (500 ink for values, 400 gray-11 for a prefix);
- 11/500 for the single kbd chip.

The 10 px text goes away.

### 5.3 Controls

- **Icon buttons** (sidebar toggle, search, agent toggle):
  - `Button variant=ghost size=icon`, which is 32 x 32 at radius 8 (it already exists in `packages/ui/src/components/button.tsx`; stop using `icon-sm`).
  - Icon 16, gray-11.
  - Hover: gray-a3 fill, ink icon. Pressed: the same fill with `aria-pressed=true`.
- **Env pill container:**
  - `inline-flex h-8 items-center p-0.5 rounded-lg bg-[--tb-surface] shadow-[--tb-edge]` (the same edge as `Button secondary` and the sidebar search field).
  - Dividers: `w-px h-4 mx-0.5 bg-[--tb-divider]`, `aria-hidden`.
  - Hide a divider next to a hovered or open segment (`opacity 0`) so the fill reads as one shape.
- **Segment:**
  - `h-7 px-2 gap-1.5 rounded-md text-[13px] leading-5 font-medium text-gray-12`.
  - Hover: `--tb-fill-hover`. Open (`aria-expanded=true`): `--tb-fill-open`.
  - Focus-visible: `box-shadow: inset 0 0 0 2px var(--blue-9)`.
- **Model segment:** an 8 px dot, then a label. The label comes from `health.provider.label` in Full and `provider.model` in Compact; Mini shows the dot only.
- **Clock segment:**
  - Clock icon 16 gray-11, then a tabular label.
  - Full: `fmtClock`, which renders "Mon, Oct 26, 8:30 AM".
  - Compact and Mini: `fmtShortClock`, which renders "Mon 8:30 AM". Mini also drops the icon.
- **Persona segment:**
  - Left padding 4 px.
  - A 20 px round avatar with initials (10/600, `--demo-bg`/`--demo-fg`).
  - In Full: "Viewing as" in gray-11/400, then the first name in ink/500.
  - Then ChevronDown 14 gray-10.
  - Compact: avatar, name, chevron. Mini: avatar only, as a square 28 px segment.

### 5.4 Color semantics (the complete list for the bar)

| Meaning | Mark | Token |
|---|---|---|
| Hosted model, live and metered (OpenAI, Claude) | solid dot | green-9 `#30a46c` |
| Local model, live and unmetered (`Local ...` labels in `packages/agent/src/providers/chat-completions.ts`) | solid dot | blue-9 `#0090ff` |
| Scripted, no model (`SCRIPTED_LABEL` in `scripted.ts`) | hollow dot, 1.5 px inset ring | gray-8 `#bbbbbb` |
| API unreachable (health failed) | solid dot, label "API offline" | red-9 `#e5484d` |
| Loading | dot gray-6 with a 1.2 s opacity pulse (none under reduced motion); label is a 56 x 10 gray-3 skeleton bar | |
| Simulated time | neutral: clock icon gray-11, ink text. "Simulated" is said in the popover title and the aria-label. | |
| Demo persona | amber avatar; the same amber pair as the mock-data banner | amber-3 / amber-11 |
| Focus | 2 px ring | blue-9 |
| Accent (madder `#d6264b`) | **not used in the bar.** It stays reserved for the Inbox count and primary actions. | |

### 5.5 States

| State | Icon button | Pill segment |
|---|---|---|
| Rest | transparent, icon gray-11 | transparent on the white pill |
| Hover | gray-a3, icon ink | gray-a3, adjacent dividers hidden |
| Focus-visible | 2 px blue-9 ring, 1 px offset | inset 2 px blue-9 ring, radius 6 |
| Open / pressed | gray-a3 + `aria-pressed` | gray-a4 + `aria-expanded=true`; chevron stays put (no rotation) |
| Disabled | 50% opacity, no hover | text gray-9, no hover, `aria-disabled` (for example the persona when mocks are on) |
| Active press | `.weft-press` scale .99 (existing) | same |

Transitions: background 100 ms `--ease-standard` (`.weft-press`). Popovers use the existing `weft-pop` 200 ms. Add `.data-[state=open]:animate-none` under `prefers-reduced-motion`; today `PopoverContent` animates regardless.

### 5.6 Popovers (all Radix, using the existing `PopoverContent`: 13 px text, radius 12, `--shadow-menu`, width min(360, 100vw - 24))

- **Model** (Popover, `aria-label="Model"`):
  - Title row: dot plus the full label, 13/600.
  - Key/value rows: label column 88 px gray-11, values in ink. The values are:
    - Mode ("Live, metered" / "Local, unmetered" / "Scripted, no model calls");
    - Spent today, `daySpentUsd`;
    - Live total, `liveSpentUsd`.
  - The spend figures come from `GET /v1/agent/costs` [C `apps/api/src/routes/agent.ts`]. Fetch only while the popover is open.
  - Footnote, 12 gray-11: the model is chosen when the API starts and switching needs a restart.
  - Read-only, with no switching UI (the provider is fixed per process).
- **Clock** (Popover, `aria-label="Simulated time"`):
  - Title "Simulated time".
  - The full date with "PT", 14/500 tabular.
  - Rows: Rate ("Paused" when `rate === 0`, otherwise "Real time" or "Nx"), and Next routine.
  - Three `Button size=xs secondary` actions: "+1 hour", "+1 day", "Next routine". They call `POST /v1/sim/clock/advance` with `{by:"PT1H"}`, `{by:"P1D"}` and `{toNext:"cron"}` [C `apps/api/src/routes/sim.ts` AdvanceBody], then `invalidate()`.
  - A link "Open simulators" to `/app/simulators`. That replaces today's click-through, which leaves the page.
  - SPEC 11.3 lists +30 min on the Simulators page. Keep that page as is; the popover is a shortcut.
- **Persona** (`DropdownMenu`, trigger `aria-haspopup="menu"`):
  - Label: "Viewing as (demo control)".
  - A `RadioGroup` with one item per principal in `PRINCIPALS`: avatar, full name 13/500, then "title, role" 12 gray-11, with a check on the current one.
  - A separator, a "New-hire portal" label, then `Item`s from the existing `usePortalPersonas()`. They keep today's behavior of `location.assign('/portal?as=...')`.
  - Footer, 12 gray-11: switching changes the signed-in human, dev auth only, and self-approval checks treat each persona as a different person by design. That keeps SPEC line 278's "demo control" labeling visible.

### 5.7 Responsive tiers (by header container width; window widths are examples)

| Tier | Header width | Example layouts | Model | Clock | Persona | Pill width (13 px Inter) |
|---|---|---|---|---|---|---|
| Full | at least 760 | 1440 docked (856), 1024 with the agent overlaid (780), 1440 undocked (1196) | dot + "OpenAI gpt-5.6-luna" | icon + "Mon, Oct 26, 8:30 AM" | avatar + "Viewing as Dana" + chevron | about 505 |
| Compact | 480 to 759 | 1280 docked (696), sidebar hidden at 1280 | dot + "gpt-5.6-luna" (or "Scripted") | icon + "Mon 8:30 AM" | avatar + "Dana" + chevron | about 310 |
| Mini | under 480 | 390 phone | dot only (28 square) | "Mon 8:30 AM", no icon | avatar only (28 square) | about 170 |

Width check:
- Full at 856: 12 + 32 + 8 + breadcrumb + 8 + 505 + 8 + 32 + 12 leaves about 239 px for the breadcrumb.
- Compact at 696, sidebar shown: 696 - 24 - 40 - 310 - 48 leaves about 274 px.
- Mini at 390, with the search icon: about 82 px. "People" fits; long section names truncate with an ellipsis, and only the current crumb shows below 620 (today's rule, kept).

In the mockup render, the measured pill widths were 437 px (Full without "Viewing as"), 307 (Compact) and 169 (Mini), with no row overflowing [V].

Below 1024 the sidebar is a drawer (`app-shell.tsx`). The drawer gets the same search field at its top, and the top bar shows the search icon.

### 5.8 Keyboard and ARIA

- The pill is `<div role="group" aria-label="Demo environment">`. Each segment is its own tab stop. These are three independent popover triggers, not a single-select set, so the toolbar pattern does not fit.
- Tab order: sidebar toggle, breadcrumb links, search (when present), model, clock, persona, agent toggle.
- `aria-label`s (visible text is shortened in narrow tiers, so the labels carry the full meaning):
  - model: `Model: OpenAI gpt-5.6-luna, live and metered`;
  - clock: `Simulated time: Monday, October 26, 8:30 AM Pacific`;
  - persona: `Viewing as Dana Whitfield (demo). Demo control: switches the signed-in human, dev auth only`.
- Remove the `title` tooltips. They never show on keyboard focus, and the popovers replace them.
- Toggles:
  - sidebar toggle: `aria-controls` the sidebar `id`, plus `aria-expanded`;
  - agent toggle: `aria-pressed` and `aria-controls` the agent panel.
- Keys:
  - Enter, Space and ArrowDown open a menu (Radix);
  - Esc closes it and returns focus to the trigger;
  - arrow keys move through the persona items;
  - ⌘K / Ctrl+K opens the command menu (exists).
- The kbd chip shows "⌘K" on Apple platforms and "Ctrl K" elsewhere (`navigator.userAgentData?.platform ?? navigator.platform`). Use one `<kbd>`: 18 px tall, padding 0 5, radius 4, ring edge, 11/500. This fixes the misaligned double chip.
- Add an `aria-live="polite"` sr-only node that announces model state changes (live to offline) and persona switches.

### 5.9 Dark mode (future-proofing; the app has no dark toggle today [C: no `.dark` set anywhere in `apps/web/src`])

The `.dark` block in `tokens.css` leaves several tokens at their light values:
- `--shadow-border` stays `#00000014`, which is invisible on `#2b2b2b`;
- `--shadow-xs`, amber, green and blue stay light as well.

When dark mode ships, add:
- `--shadow-border: 0 0 0 1px #ffffff1a`;
- `--shadow-xs: 0 1px 2px rgba(0,0,0,.3)`;
- `--amber-3: #302008` and `--amber-11: #ffca16`.

The mockup's dark row uses these.

## 6. Mockup

Open `research/wave3/topbar-mockup.html`; `topbar-shots/proposed-topbar-mockup.png` is a render of it. ASCII, Full tier at 1440 with the agent docked:

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [▯|]  People › Dana Whitfield (demo)     ╭───────────────────────────────────────────────────╮ [|▯] │
│                                          │ ● OpenAI gpt-5.6-luna │ ◷ Mon, Oct 26, 8:30 AM │ (DW) Viewing as Dana ⌄ │      │
│                                          ╰───────────────────────────────────────────────────╯      │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
 48 px bar; every control 32 px at radius 8; segments 28 px at radius 6; dividers 1 x 16; one white pill with a ring.

Compact (header 696):  [▯|] Payroll › Sep 1 to Sep 15      ( ○ Scripted │ ◷ Mon 8:30 AM │ (TM) Theo ⌄ )  [|▯]
Mini (390):            [▯|] Taxes & … [⌕]  ( ● │ Mon 8:30 AM │ (DW) )  [|▯]
Sidebar head:          [■ Larkspur Robotics / Demo workspace, Admin ⌄]
                       [⌕ Search            ⌘K ] [+]
```

## 7. Other shell inconsistencies, with fixes

1. **Detail breadcrumbs show raw ids** [V]: `/app/people/wrk_0001` shows "People › wrk_0001", and `/app/payroll/pay_2026_09_15` shows "Payroll › pay_2026_09_15". The cause is `crumbs()` in `components/app/nav.ts`, which decodes the URL segment.
   - Fix: a `BreadcrumbProvider` in `app-shell.tsx` plus a `useCrumbLabel(label)` hook that each detail view calls with the H1 text ("Dana Whitfield (demo)", "Sep 1 to Sep 15").
   - Fallback while loading: the id in 12 px mono, gray-11.
2. **Sidebar badges use four styles** [V, `sidebar.tsx`]: blue "Admin", accent Inbox count, outline "Simulated" (4 rows), gray "Coming soon". All are 16 px tall with 10 px text.
   - Fix: the Inbox count becomes the only pill: 18 px tall, radius 9, minimum width 18, 11/600 tabular, accent.
   - "Simulated" becomes plain trailing 12/400 gray-9 text with no pill. It stays explicit but quiet, and still satisfies the "labeled Simulated" rule.
   - "Coming soon" goes away as wave 3 lands Expenses and Time Off. Update `NAV` in `nav.ts` and SPEC 11.3.
3. **The workspace row truncates** to "Larkspur Rob..." at every width [V]. The badge and chevron leave about 120 px for the name.
   - Fix: a 40 px two-line row: "Larkspur Robotics" 14/500, then "Demo workspace, Admin" 12/400 gray-11.
   - This drops the blue Admin badge and keeps the demo marker visible.
4. **Group labels show a chevron but are not interactive** [C: `sidebar.tsx` renders a `div` with `ChevronDown`]. Either make them `button`s with `aria-expanded` that collapse the group (persist in localStorage), or drop the chevron. Recommended: drop it for now.
5. **The agent panel header** [C `agent/agent-panel.tsx`, V]:
   - It is 48 px and matches the bar, which is good.
   - Its buttons are `icon-sm` (28 at radius 6), while the bar's are 32 at radius 8. Switch them to `icon`.
   - When the panel is docked, the X duplicates the top bar's agent toggle. Show the X only in overlay mode (below 1280).
   - The title "Weft agent" 14/600 is fine.
   - The composer's "Ask about this page" chip (24 tall, ring) and the 28 px round send button can stay. They are inside a card, not in the bar.
6. **Page containers use six max widths** [C, grep of `components/app`]: 1100 (10 views), 1200 (3), 1000 (3+), 880 (3), 1040 (Home), 760 (1).
   - Fix: three tokens:
     - `--app-content: 1100px` as the default;
     - `--app-content-wide: 1280px` for tables (People, Payroll run, Audit);
     - `--app-content-narrow: 760px` for forms and Settings.
   - Use one padding: `px-4 py-6`, and `tablet:px-8 tablet:py-8`.
7. **Status rendering varies** [V]:
   - Payroll list shows "processed" lowercase in a green wash badge;
   - People shows "Active" as plain green text;
   - Home shows "Active" in a green wash badge.

   Fix: one `StatusBadge` with a status-to-tone/label map, in sentence case, used everywhere. Plain colored text stays only in dense tables.
8. **Focus styles split in two** [V]: see D5. Add one base rule in the app CSS: `:where(a, button, select, [tabindex]):focus-visible { outline: none; box-shadow: 0 0 0 1px var(--background), 0 0 0 3px var(--blue-9); }`. Components that need an inset ring override it.
9. **Breadcrumb versus H1:** top-level pages repeat the title ("Inbox" in the bar and as the H1) [V]. Keep both. The bar crumb is the anchor after scrolling, and the reference agent mock does the same.

## 8. Implementation notes for builders

- **Files to change:**
  - `apps/web/src/components/app/shell/header.tsx` (rewrite);
  - `sidebar.tsx` (search row, workspace row, badges);
  - `app-shell.tsx` (an `@container` wrapper around the header, a `sidebarVisible` prop so the header knows when to show search, and the breadcrumb provider);
  - `agent/agent-panel.tsx` (button size, X only in overlay);
  - `nav.ts` (badges, crumbs);
  - `packages/ui/src/components/kbd.tsx` (single chip);
  - `packages/ui/src/tokens.css` (the `--tb-*` tokens in 5.2).
- **New `packages/ui` component:** `DropdownMenu` (Radix, styled like `PopoverContent`). `radix-ui` is already a dependency, and Popover, Dialog and Slot are used.
- **Keep these test ids:**
  - `TID.providerBadge` on the model segment button;
  - `TID.simClock` on the clock segment;
  - `TID.viewingAs` on the persona trigger;
  - `TID.cmdkInput`, unchanged.
- **E2E impact** [C `e2e/fixtures.ts`]:
  - `viewAs()` already handles a non-`SELECT` control: it clicks the trigger, picks `getByRole('menuitemradio', {name: /Theo/})`, then expects the trigger to contain the first name. Radix `DropdownMenu.RadioItem` renders `role=menuitemradio`, and every tier shows the name except Mini (no e2e runs at 390). No change is needed.
  - `openApp()` waits for `simClock` to be visible. It is still visible.
  - `gp4` asserts `simClock` contains `9:00` or `9:30`. Both clock formats include the time.
  - **`gp6-offer-portal.spec.ts:34` must change.** It looks for an `option[value="portal:..."]` inside the control. It should instead open the menu and expect a `menuitem` with the candidate's name.
  - `e2e/screens/capture.screens.ts:107` uses `simClock` (fine).
- **Acceptance checks:**
  - At 1440 docked, 1280 docked, 1024 and 390: no overflow (`header.scrollWidth <= clientWidth`).
  - Every bar control's `getBoundingClientRect().height` is 32, and every segment's is 28.
  - Every focusable item in the header shows the blue ring under keyboard Tab.
  - The bar has no green-3 or amber badge fill.
  - `pnpm lint:brand`, `pnpm brand:overlap`, `pnpm lint:prose`, unit tests and e2e all pass.
- **SPEC follow-up:** update `SPEC.md` 11.3 (line 754, header contents and sidebar badges) and `research/design.md` 13.3 (the header line) to match D1 and D2.

## 9. Open questions

- D1 moves search out of the header. If Nitish prefers search in the header, the fallback is: a centered search field of 240 to 400 px (`grid-template-columns: minmax(0,1fr) minmax(200px,400px) minmax(0,1fr)`), with the env pill forced into the Compact tier at 1440 docked. It works but is cramped. I recommend D1.
- Should the "New agent thread" button next to sidebar search open the agent panel with an empty thread and focus the composer? Assumed yes. It mirrors the reference's square "+" and gives the agent a permanent entry point.
- Should the clock popover's advance actions be limited to admins? The API accepts any principal today [C `sim.ts`]. That is out of scope here, so it is flagged only.
