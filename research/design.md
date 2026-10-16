# Weft design research: mirroring the look of warp.co

Researched 2026-10-15 (13:05 to 13:40 PDT). Every fact below cites its source. Builders should read this file instead of re-downloading Warp material.

## 0. Sources and file map

All downloaded material is Warp's copyrighted work and lives only in `research/design/reference/` (gitignored, never committed). Paths below are relative to that folder.

| Tag | What | Source URL | Local file |
|---|---|---|---|
| [H] | Homepage HTML | https://www.warp.co/ | `html/home.html` |
| [A] | Agent page HTML | https://www.warp.co/agent | `html/agent.html` |
| [P] | Payroll page HTML | https://www.warp.co/payroll | `html/payroll.html` |
| [PR] | Pricing page HTML | https://www.warp.co/pricing | `html/pricing.html` |
| [CSS] | Main Tailwind v4 bundle (281 KB) | https://www.warp.co/_next/static/immutable/chunks/44uyryknbw_5u.css | `css/44uyryknbw_5u.css` |
| [CSS-F] | next/font module CSS | .../chunks/1p0hlvxgfnt4q.css | `css/1p0hlvxgfnt4q.css` |
| [CSS-D] | Dashboard mockup scope `.warp-dash` | .../chunks/1r3d7b_2zybdi.css | `css/1r3d7b_2zybdi.css` |
| [CSS-AG] | Agent mockup scope `.warp-agent` + Inter | .../chunks/1-3b6o_ub91_9.css | `css/1-3b6o_ub91_9.css` |
| [CSS-R] | Routine animations | .../chunks/1f2z1tpsopk-j.css | `css/1f2z1tpsopk-j.css` |
| [FONTS] | Font binaries, name tables read with fontTools | https://www.warp.co/_next/static/immutable/media/* | `fonts/*` |
| [S-*] | Full-page and fold screenshots, 1440 and 390 px | Playwright 1.63 Chromium | `shots/{home,agent,payroll,pricing}-{1440,390}-{full,fold}.png` |
| [PROBE-*] | Computed styles of headings, paragraphs, buttons, nav | Playwright `getComputedStyle` | `shots/{page}-probe.json` |
| [MENU] | Mega-menu popups (opened via keyboard) | Playwright | `shots/megamenu-{Products,Solutions,Resources}.png`, `shots/megamenu.json` |
| [MOCK] | Dashboard and agent mockups at 2x + geometry | Playwright element shots | `shots/mock-home-dashboard@2x.png`, `shots/mock-agent-app@2x.png`, `shots/mock-probe.json` |
| [INT] | Live animations, header, canvas info | Playwright `document.getAnimations()` | `shots/home-interactions.json`, `shots/agent-interactions.json` |
| [MOB] | Mobile menu open | Playwright 390 px | `shots/home-390-menu-open.png` |

Note: the [reference string, 3 words] on warp.co are not images. They are live DOM components (`.warp-dash` on the homepage, `.warp-agent` on /agent) with their own scoped token sets [CSS-D] [CSS-AG]. The element screenshots in [MOCK] are the best visual reference. Image requests on the homepage are only customer logos, state SVGs and integration PNGs (`shots/home-images.txt`).

Stack observed: Next.js App Router with Tailwind CSS v4 (`@layer theme`, `--spacing:.25rem`, `--tw-*` properties) [CSS]; Base UI navigation menu (`data-base-ui-navigation-menu-trigger`) [H] `shots/nav-outer.html.txt`; Radix-Colors-style 12-step scales with P3 overrides (`@media (color-gamut:p3)`) [CSS]; Vidstack media player CSS (`[data-media-player]`) in chunk `0mr8hryu7lhqx.css`.

## 1. The look in ten lines

1. Bright white canvas, near-black ink `#202020`, a single hot vermilion accent `#ff3d00`, everything else neutral gray. No gradients on surfaces; color comes from the accent and from small status colors inside product mockups [CSS] [S-home].
2. One soft grotesk for everything on the marketing site (Restart Soft) at weights 400, 450 ("book") and 500, with mild negative tracking on display sizes [PROBE-home] [CSS-F].
3. Two-tone headlines: first clause in ink, second clause in mid gray `#838383` in the same 35 px size ([reference string, 13 words]) [PROBE-home] [S-home].
4. A signature "lined" text effect: accent words filled with horizontal scanlines (`.text-lined`, `.text-lined-strong`) and section headings flagged by a dotted vertical accent rule (`.border-lined`) [CSS].
5. Real product UI as the hero imagery: a full app dashboard with an agent side panel, rendered in DOM, sitting in a white rounded frame with hairline border and long soft shadow [MOCK].
6. Content column 1216 px (1280 max minus 2 x 32 px padding), 3-up card grids with 48 px gutters, 96 px section padding [CSS] [PROBE-home].
7. Dark "island" cards (`#2b2b2b`, 12 px radius) and a dark CTA band (`#242424`, 24 px radius) punctuate the white page [H] [S-home].
8. Small, crisp controls: 32 px nav buttons, 40 to 44 px CTAs, 7 to 9 px radii, hairline borders `#e8e8e8` [PROBE-*].
9. Motion is quiet and functional: 100 to 350 ms transitions on expo-out curves, text shimmer for "agent working", a slow logo marquee, a ticking payroll counter, a canvas field of currency glyphs behind the hero [CSS] [INT].
10. Footer ends with a giant scanline-filled wordmark fading into the page [S-home tile 6] [CSS `--footer-wordmark`].

## 2. Color palette

### 2.1 Marketing site, light (the default) [CSS `:root` hex fallbacks; P3 oklch overrides in the same file]

Neutral scale `--gray-1..12` (Radix-style):

| Token | Hex | Role (observed) |
|---|---|---|
| gray-1 | `#fcfcfc` | Page bg on /agent (nav renders `oklab(0.991)`) [PROBE-agent] |
| gray-2 | `#f9f9f9` | Card visual wells, light panels |
| gray-3 | `#efefef` | Email capture pill bg, icon tiles, chat user bubble |
| gray-4 | `#e8e8e8` | `--border` default hairline |
| gray-5 | `#e0e0e0` | Stronger dividers |
| gray-6 | `#d9d9d9` | Inactive tracks |
| gray-7 | `#cecece` | |
| gray-8 | `#bbbbbb` | `--muted-foreground` |
| gray-9 | `#8d8d8d` | `--muted`, big muted numerals |
| gray-10 | `#838383` | Second clause of two-tone headlines, eyebrow ticker, logo-strip label, footer links [PROBE-home] |
| gray-11 | `#646464` | Card body copy, "Explore" links [PROBE-home] |
| gray-12 | `#202020` | Ink: headings, body, dark buttons |

Alpha neutrals: `--gray-a3 #00000010`, `--gray-a4 #00000017`, `--gray-a5 #0000001f`, `--gray-a6 #00000026`, `--gray-a9 #00000072`, `--gray-a10 #0000007c` (hero subcopy on /agent, `rgba(0,0,0,.486)`), `--gray-a11 #0000009b` (hero subcopy on home, `rgba(0,0,0,.608)`), `--gray-a12 #000000df`. Black alphas `--black-a1 #0000000d` ... `--black-a12 #000000f2` [CSS].

Semantic aliases [CSS `:root`]:

| Token | Hex | Role |
|---|---|---|
| `--background` / `--color-background` | `#ffffff` | Page |
| `--foreground` / `--color-foreground` | `#202020` | Ink |
| `--border` | `#e8e8e8` | Hairlines |
| `--card` | `#ffffff` | Cards |
| `--surface` / `--color-surface` | `#f3f8fb` | Cool tinted surface (P3: `oklch(97.5% .006 237)`) |
| `--surface-alt` | `#d6e6ee` | |
| `--blacktop` | `#242424` | CTA band, top announcement bar |
| `--dark` | `#171717` | |
| `--clay` | `#f0eae6` | Warm neutral |
| `--apex` | `#ff3d00` | Primary CTA fill (computed `rgb(255,61,0)`) [PROBE-home buttons] |
| `--accent-9` / `--color-accent` | `#ff3e02` | Accent text, eyebrows, lined words |
| `--brand` / `--warp-blue` | `#00b4f0` | Secondary brand cyan (rarely visible) |
| `--destructive` | `#ff2323` | |
| `--success` | `#008500` | |
| `--warning` | `#f59e0b` | |
| `--info` | `#286aff` | |

Accent scale `--accent-1..12` (light): `#fffcfb #fff7f4 #ffeae3 #ffd8cb #ffc9b8 #ffb6a2 #ffa28b #fa866b #ff3e02 #f12900 #e21200 #612416`; `--accent-surface #fff5f1cc`; `--accent-contrast #fff` [CSS].

Other 12-step scales present (light step 9 / step 11): red `#ff2323 / #e20000`, blue `#286aff / #205ce3`, green `#32cd32 / #008500`, amber `#f59e0b / #ac6500`, purple `#933bff / #7e27e0`, pink `#ff21f2 / #c300ba` [CSS]. These saturated step-9 colors appear as the routine icon tiles on /agent [S-agent tile 4].

### 2.2 Dark-scoped sections [CSS `.dark{...}`]

Warp applies `class="dark"` to individual sections (the [reference string, 3 words] card is `dark flex ... rounded-xl bg-gray-2` [H]). Dark values: gray-1 `#242424`, gray-2 `#2b2b2b` (card fill), gray-3 `#333333`, gray-4 `#393939`, gray-5 `#3e3e3e`, gray-6 `#464646`, gray-7 `#525252`, gray-8 `#696969`, gray-9 `#757575`, gray-10 `#808080`, gray-11 `#b6b6b6`, gray-12 `#eeeeee`; `--background #242424`, `--foreground #eeeeee`, `--border #ffffff14`, `--card #2b2b2b`; accent-11 `#ff957a`, accent-12 `#ffd1c5`, accent-surface `#3e241f80` [CSS].

### 2.3 Gradients and textures

- Lined text: `repeating-linear-gradient(0deg, currentColor 0 50%, transparent 50% 100%) 0 0 / 100% .05em` clipped to text (`.text-lined`); strong variant uses 68% ink [CSS]. Used on "runs itself" (home H1), "Scale" (pricing H1), "automated" (payroll H1), [reference string, 2 words] (CTA band, on gray) [H] [PR] [P].
- Dotted accent rule: `border-image: repeating-linear-gradient(to bottom, var(--accent-9) 0 1px, transparent 1px 2px) 1` (`.border-lined`) on left edge of section headings and between dark-card columns [CSS] [S-home].
- Footer wordmark: `--footer-wordmark: linear-gradient(0deg, #24242414 50%, #24242408 50%)`; footer top fade `--footer-shadow: linear-gradient(to bottom, #ffffffe6 0%, #ffffff80 40%, transparent 100%)` [CSS]. Rendered in a pale accent tint with scanlines [S-home tile 6].
- Shimmer text: `linear-gradient(90deg, #0a111180 0 30%, #dcdcdcb3 50%, #0a111180 70% 100%)`, 200% size, 2.5 s linear infinite [CSS] [INT].
- Logo-strip edge fades: `bg-linear-to-r from-background to-transparent` overlays on both ends [H].
- Agent scope shade: `--agent-shade-strength: .05`, `--agent-shade-stop: 55%` (subtle vertical darkening of mock canvases) [A].

### 2.4 Dashboard mockup palette `.warp-dash` [CSS-D]

`--background #fff`, `--foreground #0a0a0a`, `--muted-foreground #0a0a0a99`, `--border #e5e5e5`; sand scale `#fdfdfc #f9f9f8 #f1f0ef #e9e8e6 #e2e1de #dad9d6 #cfceca #bcbbb5 #8d8d86 #82827c #63635e #21201c`; status: green-3 `#e6f6eb`, green-9 `#30a46c`, green-11 `#218358` ("Active", "Autopay"), blue-3 `#e6f4fe`, blue-9 `#0090ff` (chart line), blue-11 `#0d74ce` ("Onboarding"), red-9 `#e5484d`, violet-9 `#6e56cf` (chart line), purple-9 `#8e4ec6`. Shell bg `#fafafa` (sidebar and agent panel), main pane white [MOCK]. Dark variant: background `#292929`, border `#ffffff1a`, sand-1 `#111110` ... sand-12 `#eeeeec` [CSS-D].

### 2.5 Agent mockup palette `.warp-agent` [CSS-AG] [A inline vars]

oklch neutral scale (hex computed): gray-1 `#ffffff`, gray-2 `#f9f9f9` (`--background-1`, sidebar), gray-3 `#f2f2f2`, gray-4 `#ebebeb` (active nav item), gray-5 `#e3e3e3`, gray-6 `#dbdbdb`, gray-7 `#cfcfcf`, gray-8 `#bdbdbd`, gray-9 `#929292`, gray-10 `#858585`, gray-11 `#696969` (inactive nav text), gray-12 `#2d2d2d` (ink). Accents (step 9): cyan `#00a5b9`, blue `#1899ec`, green `#24ae56`, purple `#a76ef8`, iris `#6d86ff`, orange `#dc7100`, amber `#ffc000`, crimson `#f4514f`; step 11: blue `#216fa7` (mentions like [reference string, 2 words]), green `#277c41` (up deltas), crimson `#ad403d` (down deltas). Washes: blue-2 `#f4faff`, blue-4 `#dcedfd`, green-2 `#f5fbf5`, green-4 `#ddf1e0`, amber-2/3, crimson-2/3 used as row-group bands mixed at 20% (`.group-band-wash`) [CSS-AG]. Page-level agent vars: `--agent-ink #1d1c1d`, `--agent-muted #616061`, `--agent-dim #8d8d8d`, `--agent-line #e8e8e8`, `--agent-well #f2f2f2`, `--agent-soft #f7f7f7`, `--agent-hover #f2f2f2`, `--agent-bubble #e6e6e6`, `--agent-card #ffffff`, `--agent-glass rgb(255 255 255/.8)`, `--agent-hairline oklch(0 0 0/.13)`, `--agent-track #d9d9d9`, `--agent-mark #202020` [A].

## 3. Typography

### 3.1 Families, sources and licenses [CSS-F] [CSS-AG] [FONTS]

| Warp variable | Actual family (name table) | Foundry / license | Where used | Open-licensed substitute for Weft |
|---|---|---|---|---|
| `--font-restart-soft` (`restartSoft`) | Restart Soft Variable, wght 100 to 900, ital 0 to 10 | Superior Type s.r.o., commercial | Entire marketing site: body, nav, all headings (computed `font-family: restartSoft`) [PROBE-*] | **Inter Variable** (SIL OFL 1.1, rsms; wght 100 to 900 plus opsz 14 to 32, so weights 450 and 550 and a display cut work). Alternative: Geist (OFL) |
| `--font-macan` (`brandFont`, files `book/medium/semibold/bold` at 450/500/600/700 + italics) | Macan v2.015 | TIGHTYPE, commercial | `html` default and the homepage dashboard mockup `.warp-dash` (`font-family: Macan`) [CSS] [CSS-D] | **Inter Variable** |
| `Inter Variable` | Inter 4.001 | SIL OFL 1.1 | Agent-page product mockup `.warp-agent` [CSS-AG] | Inter Variable (same) |
| `--font-berkeley-mono` | Berkeley Mono Variable 2.002 (wght, wdth, slnt) | U.S. Graphics, [reference string, 5 words] in the name table | `code, kbd, pre`, `.font-mono`: feature numbers "01 02 03", benefits card [reference string, 3 words] [CSS] [S-home] | **JetBrains Mono** (OFL). Alternative: Geist Mono (OFL) |
| `--font-family-serif` (`newYork`) | Apple New York | Apple, mockup-only license | Defined but no usage found in [CSS] | **Newsreader** or **Source Serif 4** (OFL) if a serif is ever needed |

Font features: `html { font-feature-settings: "ss13" }` with Macan [CSS]; the dashboard scope uses `letter-spacing: -.015em` globally [CSS-D]; agent scope uses `font-optical-sizing: auto` and letter-spacing 0 [CSS-AG]. Self-host Inter and JetBrains Mono through `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` (no Google CDN needed, no hotlinking).

Weights in use: 400 regular, 450 book (`--font-weight-book: 450`, used for nav, H2s, cards), 500 medium (H1 home, H3 cards, buttons), 550 (`.font-medium-plus` in agent mock), 600 semibold (pricing plan names, dashboard greeting) [CSS] [PROBE-*].

### 3.2 Warp's named type scale `.typography-0..12` [CSS]

| Class | Size / line-height | Tracking |
|---|---|---|
| typography-0 | 11 / 16 | .003em |
| typography-1 | 12 / 16 | .0025em |
| typography-2 | 14 / 20 | 0 |
| typography-3 | 16 / 24 | 0 |
| typography-4 | 18 / 26 | -.0025em |
| typography-5 | 20 / 28 | -.005em |
| typography-6 | 24 / 30 | -.00625em |
| typography-7 | 28 / 36 | -.0075em |
| typography-8 | 35 / 40 | -.01em |
| typography-9 | 60 / 60 | -.025em |
| typography-10 | 72 / 72 | -.028em |
| typography-11 | 80 / 80 | -.032em |
| typography-12 | 96 / 96 | -.04em |

### 3.3 Observed roles (computed at 1440 px) [PROBE-home] [PROBE-agent] [PROBE-payroll] [PROBE-pricing]

| Role | Size / LH | Weight | Tracking | Color |
|---|---|---|---|---|
| Home H1 | 46 / 50.6 (1.1); 40 tablet, 32 mobile | 500 | normal | `#202020`, accent words `#ff3e02` lined |
| Product H1 (/payroll, /pricing) | 48 / 57.6 (1.2), centered | 500 | normal | ink |
| Agent H1 | 44 / 46.2 (1.05) | 450 | normal | ink |
| Section H2 (two-tone) | 35 / 40 | 450 (500 when single-tone) | -0.35 px | clause 1 `#202020`, clause 2 `#838383` |
| Agent-page H2 | 37 / 42 | 450 | normal | ink |
| CTA band H2 | 40 / 48 | 450 | -0.03em (-1.2 px) | white |
| Dark card H2 | 28 / 36 | 500 | -0.21 px | `#eeeeee` |
| Feature H3 (large, agent/payroll rows) | 24 / 30 or 35 / 40 | 450 / 500 | -0.15 / -0.35 px | ink |
| Card H3 | 16 / 24 (home grid) or 18 / 26 (feature trio) | 500 (home) / 450 (agent) | -0.045 px at 18 | ink |
| News card title | 18 / 24.75 | 500 | -0.045 px | ink |
| Hero subcopy | 18 / 27 | 400 | -0.045 px | `rgba(0,0,0,.608)` home, `.486` agent |
| Body / card copy | 16 / 24 | 400 | normal | `#646464` |
| Eyebrow (accent) | 14 / 20 | 450 | normal | `#ff3e02`, with 16 px icon |
| Ticker eyebrow | 13 / 19.5 | 500 | normal | `#838383`, tabular-nums |
| Nav item | 14 / 20 | 450 | normal | ink at 80% |
| Button label | 14 (nav, secondary) / 16 (hero CTA, pricing) | 500 | normal | |
| Footer column head | 14 / 16.8 | 450 | normal | ink |
| Footer link | 14 / 16.8 | 400 | normal | `#838383`, hover ink |
| Mono numerals ("01") | 13 | 400 | normal | `#838383` |
| Dashboard greeting (mock) | 28 / 42 | 600 | -0.42 px | `#0a0a0a` |
| Agent chat text (mock) | 14 / 22.75 to 24 | 400 to 450 | -0.21 px (Macan) / 0 (Inter) | `rgba(0,0,0,.608)` / `#2d2d2d` |
| Mock small labels | 12 to 13 | 500 | | gray-11 |

## 4. Spacing, containers and grid

- Base unit `--spacing: .25rem` (Tailwind v4 default 4 px scale) [CSS].
- `--page-max-width: 1280px`, `--page-padding: 32px` -> content column 1216 px, left edge x = 112 at 1440 px [CSS] [PROBE-home `w:1216`]. Mobile padding `max-mobile-h:px-4` (16 px) [H].
- Nav heights: `--navigation-menu-height: 56px`, announcement bar `--navigation-menu-banner-height: 44px` [CSS].
- Resources pages: `--resources-page-max-w: 1340px`, px 70 / 50 (laptop) / 25 (tablet) / 20 (mobile) [CSS].
- Section wrapper: `flex py-24 justify-center items-center gap-12` (96 px vertical, 64 px tablet `py-16`, 48 px mobile `py-12`), inner column `gap-16` (64 px) between heading and content [H].
- Hero: `pt-20` (80 px) and `gap-11` (44 px) between ticker, H1 block, capture form and mockup; mockup 1214 x 678 [H] [MOCK].
- 3-up card grid: 373 px cards with 48 px gutter (`3 x 373 + 2 x 48.5 = 1216`) and about 60 px row gap; visual well 218 px tall [PROBE-home buttons w:373] [S-home tile 2].
- Dark island card: `p-12` (48 px), tablet `p-8`, mobile `p-6`; columns `laptop:flex-row laptop:gap-10` [H].
- CTA band: `p-16` (64 px), tablet `p-10`, mobile `p-6` [H].
- Common max widths for copy: hero subcopy `max-w-[600px]`, H1 `max-w-[900px]`, email capture `w-[430px]` [H]. Agent-page H2 column 560 px, paragraph 547 px [PROBE-agent].
- Tailwind containers available `--container-xs 20rem` ... `--container-7xl 80rem` [CSS].

## 5. Radii, shadows and borders

Radii [CSS] [PROBE-*]:
- Tailwind theme: xs 2, sm 4, md 6, lg 8, xl 12, 2xl 16, 3xl 24 px.
- Nav items 8 px; "Get Started" and agent-page CTAs 7 px; hero [reference string, 3 words] 9 px; pricing buttons 8 px; mega-menu popup 12 px; dark island card 12 px; feature visual wells 8 px (home) or 12 px (agent); [reference string, 3 words] big cards 12 px; payroll mock panels about 16 to 20 px (`rounded-2xl`); CTA band 24 px; [reference string, 3 words] and badges fully round.
- Agent mock scale: xs 4, sm 6, md 8, lg 10, xl 12, 2xl 14 px; canvas frame 10 px [CSS-AG] [MOCK].

Shadows [CSS `:root`]:
- `--shadow-border: 0 0 0 1px #00000014` (ring-as-border, used everywhere instead of CSS borders)
- `--shadow-small: 0 2px 2px #0000000a`; `--shadow-medium: 0 2px 2px #0000000a, 0 8px 8px -8px #0000000a`; `--shadow-large: 0 2px 2px #0000000a, 0 8px 16px -4px #0000000a`
- `--shadow-menu` (mega-menu): border ring + `0 1px 1px #00000005, 0 4px 8px -4px #0000000a, 0 16px 24px -8px #0000000f` [MENU computed]
- `--shadow-modal`: ring + `0 1px 1px #00000005, 0 8px 16px -4px #0000000a, 0 24px 32px -8px #0000000f`
- Radix-style elevations `--shadow-1` (inset) to `--shadow-6`; `--shadow-2` = `0 0 0 1px gray-a3, 0 0 0 .5px black-a1, 0 1px 1px gray-a2, 0 2px 1px -1px black-a1, 0 1px 3px black-a1` (dark island card)
- Product mock shadow (agent page) `--agent-product-shadow`: `0 1px 1px rgb(0 0 0/.05), 0 6px 12px -4px rgb(0 0 0/.024), 0 12px 24px -8px ..., 0 24px 48px -16px ..., 0 48px 96px -32px rgb(0 0 0/.024)`; floating payroll card adds `0 10px 28px -8px rgb(0 0 0/.07), 0 28px 56px -16px rgb(0 0 0/.05)` [A].
- Mock inner card: `0 0 0 1px #00000010, 0 0 0 .5px rgba(0,0,0,.05), 0 1px 1px #00000006, 0 2px 1px -1px rgba(0,0,0,.05), 0 1px 3px rgba(0,0,0,.05)` (`--agent-shadow`) [A]; dashboard `--warp-shadow-4` [CSS-D].
- Dark buttons get an inset top highlight `inset 0 1px 0 rgba(255,255,255,.3)` or `inset 0 1px 1px rgba(255,255,255,.1), 0 1px 2px rgba(0,0,0,.3)` [CSS arbitrary shadows].

Borders: 1 px `#e8e8e8` (`--border`) on light, `#ffffff14` on dark; nav bottom border appears on scroll as `foreground/9` (`rgba(32,32,32,.09)`) [INT `scrolledNav`]; logo strip top border `gray-a4` [H]; dashboard mock borders `#e5e5e5` [CSS-D].

## 6. Iconography and imagery

- Icons: thin line icons, about 1.5 px stroke, 16 px in nav/menus/mocks and 16 to 20 px in feature tiles, rounded joins, gray-11 on light. The agent's symbol is a navigation-cursor arrow (outlined pointer) in accent [S-home tile 3] [MENU]. Weft: use `lucide-react` (ISC) at stroke-width 1.5.
- Icon tiles: 36 px rounded-lg square, gray-3 fill, icon gray-12 (mega menu, feature trio); 56 px rounded-xl tile on dark cards with inset highlight [MENU] [S-home tile 1].
- Routine tiles on /agent: 36 px squares filled with saturated step-9 colors (green, blue, purple, pink, amber, cyan) with white glyph and a tiny offset "pixel" square at one corner [S-agent tile 4].
- Pixel motifs: dot-matrix squares fading at the edges of the testimonial block, a small 6 x 3 pixel glyph above section headings on /agent, and a 3 x 3 grid spinner (`routine-grid-chase`) [S-agent] [CSS-R].
- Hero background: a full-width `<canvas>` (desktop only, `max-tablet:hidden`) drawing a field of monospaced currency glyphs (`$ € £ ¥ ₹ ₱ ₸ ₺ ₿ d`) in very light gray with a few accent-tinted glyphs, denser on the right [INT `canvases`] [S-home fold].
- Imagery: customer photography and customer logos (we must not copy either); product UI mockups are the dominant imagery. Abstract art only in the CTA band (large curved stripes in accent, white and black) and the footer wordmark [S-home tile 6].
- Avatars: 20 to 24 px circles with initials on colored backgrounds (dashboard), or small photos (agent mock) [MOCK].
- Badges: compliance badges in the footer (AICPA SOC, G2) [S-home]; Weft must not show these.

## 7. Motion

Durations and easings [CSS] [MENU] [INT]:
- Default transition 150 ms `cubic-bezier(.4,0,.2,1)` (Tailwind default).
- `.press` buttons: 100 ms `cubic-bezier(.2,0,0,1)` on bg, shadow, color, transform; `:active { scale: .99 }`; disabled under `prefers-reduced-motion`.
- Mega menu (Base UI): popup and positioner 350 ms `cubic-bezier(0.22,1,0.36,1)`; enter from `scale-90 opacity-0`; the popup animates width and height when moving between triggers; trigger gets `bg-foreground/6` while open.
- Expo-out `cubic-bezier(0.16,1,0.3,1)` also present for reveals.
- Agent mock: `--duration-fast: .1s`, `--ease-standard: cubic-bezier(.2,0,0,1)` [CSS-AG].

Keyframes inventory [CSS] [CSS-AG] [CSS-R]:
- `shimmer` 2.5 s linear infinite: gradient sweep over gray text (status "working" labels) [INT].
- `agent-shimmer` 2 s linear infinite (110deg gradient), `agent-slack-shimmer` 1.35 s; `routine-working-shimmer` 1.8 s (100deg, `#7a7a7a` to `#f7f7f7`).
- `agent-caret`: 1.5 px wide caret, 1.05 s `step-end` blink for streaming text.
- `agent-fade-in` 250 ms; `agent-pop`: opacity 0, `translateY(6px) scale(.97)` to rest.
- `slideUp` 150 to 200 ms ease-out (12 px, scale .98); `dropdown-in` (scale .98, -2 px); `fadeIn`.
- `letter-in`: opacity 0, `blur(2px)`, `translateY(3px)` per letter (streamed text).
- `pill-glow` 3 s ease-in-out infinite (NEW pill).
- `routine-grid-chase` 1 s linear infinite over a 3 x 3 cell grid (cells step `#1d1c1d -> #4a4a4a -> #8a8a8a -> #b5b5b5 -> #d9d9d9`).
- `pay-row-shimmer` 1.2 s `cubic-bezier(.45,0,.2,1)`: green sweep `oklch(72% .17 145/.16)` across a payroll row when it updates.
- `glitch-before/after`: clip-path text glitch; `spin`, `ping`, `pulse`.
- All agent animations have `prefers-reduced-motion` fallbacks [CSS-AG] [CSS-R].

Scroll and ambient behavior:
- Header wrapper is `sticky top-0 z-50` (banner + nav stick together); nav bg `background/95` with `backdrop-blur-sm` (8 px); bottom border transitions from transparent to `foreground/9` after scrolling [INT].
- Logo strip under the hero is `sticky bottom-0 z-30` (pinned to the viewport bottom until the hero scrolls past) and its track scrolls left continuously at about 37 px/s (JS-driven transform, measured 73.5 px over 2.0 s), with background-colored edge fades [H] [probe6 output].
- Hero ticker [reference string, 6 words] increments continuously; digits are separate spans with tabular-nums [H] [S-home fold].
- /agent: tall sticky scroll scenes; chat mockups type themselves out when they enter (text appears with caret; panels empty in a static full-page shot) [S-agent tile 1 and 2].
- Home [reference string, 5 words] list autoplays: the active item expands with a one-line description and a dark progress line that fills, while the right panel cycles stacked "Confirm action" cards (center card crisp, neighbors faded) [S-home tile 3].
- Below-the-fold elements are mid-animation (opacity 0.26 to 0.41, translateY, scale 0.85) before entering, so there are scroll-in reveals [probe6 output].

## 8. Breakpoints and responsive behavior [CSS media queries] [S-*-390]

- Custom variants: `max-mobile-h` < 640 px, `max-tablet` < 768 px, `max-laptop` < 1024 px, desktop >= 1280 px; also 900 px and 1400 px queries. Tailwind v4 defaults `40rem / 48rem / 64rem / 80rem` present.
- < 1024 px: desktop nav list hidden (`max-laptop:hidden`); hamburger appears.
- Mobile nav [MOB]: full-width sheet below the bar; rows 61 px tall with 1 px dividers, labels 16/500, chevron-down for accordions (Products, Solutions, Resources); bottom row of two equal buttons "Log in" (white, bordered) and "Get Started" (ink fill), 42 px tall.
- Mobile hero: centered text, H1 32 to 40 px, email field and CTA stacked full width (each about 46 px tall), tour link centered, the dashboard mockup is scaled down as a whole (not reflowed) [S-home-390].
- Cards go 1-up; dark island columns stack; hero canvas hidden under 768 px.

## 9. Component inventory (anatomy)

### 9.1 Announcement bar [S-home fold] [PROBE-home]
44 px tall, bg `#242424`, centered: "New" in accent (14 px), a 1 px vertical divider, message 14/500 white at 85% with a chevron; close X 24 px at far right (white 70%).

### 9.2 Top nav with mega-menu [PROBE-home] [MENU] [nav-outer.html.txt]
- Bar: 56 px, content 1216 px; logo left (mark + wordmark, about 85 x 24); centered group of triggers "Products ⌄", "Solutions ⌄", "Customers", "Resources ⌄", "Pricing"; right "Log in" (ghost) and [reference string, 3 words] (32 px, padding 0 10 0 12, radius 7, 14/500; ink fill on home, accent `#ff3d00` on product pages).
- Triggers: 32 px tall, `px-3`, radius 8, 14/450, ink 80%, hover and open `bg-foreground/6`; chevron rotates on open.
- Popup: white, radius 12, `--shadow-menu`, padding 12, opens 0 px below the bar (y = 98 at 1440). Products: 624 x 284, label "Platform" (13 px gray), 2-column grid of 8 items; item = 36 px gray-3 icon tile + title 14/450 + description 14 gray-10; focused item shows a 2 px blue focus ring, radius 8. Solutions: 1193 x 284, two labeled groups "By size" and "By industry". Resources: 1193 x 404, groups "Discover", "Learn", "Company" plus a feature card.

### 9.3 Hero with CTAs [S-home fold] [H]
Left-aligned block (home) or centered (product pages). Order: ticker eyebrow (13/500 gray, live number) -> H1 two lines with lined accent phrase -> subcopy 18/27 max 600 px -> row: email capture pill (430 px, gray-3 bg `#efefef`, radius about 12, 56 px tall, placeholder [reference string, 4 words] 16 px gray, inner accent button [reference string, 4 words] 44 px tall, radius 9, 16 px white) and, right-aligned, [reference string, 4 words] (36 px round play icon in gray-3 + 14 px gray-11 label). Then the product mockup frame (rounded 12, hairline border, long soft shadow). Background canvas glyph field behind.

### 9.4 Logo strip [H] [S-home]
Full-bleed strip with top hairline; left label [reference string, 4 words] 14/450 gray-10 (max-w-sm); right a masked marquee of grayscale logos about 30 px tall, about 48 px apart, left and right gradient fades. Sticky to viewport bottom inside the hero.

### 9.5 Section heading (two-tone with dotted rule) [S-home tiles 1 to 5] [CSS]
Left `.border-lined` 1 px dotted accent rule, about 24 px left padding, H2 35/40/450: [reference string, 6 words] Optional right-aligned button pair (ink [reference string, 3 words] + white bordered [reference string, 3 words], both 40 px, radius 8, 14/500).

### 9.6 Product cards grid [S-home tile 2] [PROBE-home]
3 x 2 grid. Card = whole-card link: visual well 373 x 218, bg gray-2 `#f9f9f9`, radius 8, containing a cropped mini UI (task checklist, toast [reference string, 4 words], benefits ID card, tax states list with "✓ Resolved", workflow builder [reference string, 4 words], country flags), faded at the bottom/right edges; then 20 px gap, H3 16/500, body 16/24 gray-11 (3 lines), "Explore ›" 14 px gray-11 with chevron that nudges right on hover (`group-hover:translate-x-0.5`).

### 9.7 Agent showcase (dark island) [S-home tile 2] [H]
`.dark` card: bg `#2b2b2b`, radius 12, `shadow-2`, padding 48, 3 columns separated by dotted accent rules. Col 1: accent eyebrow "Agent" with cursor icon, H2 28/36/500 [reference string, 3 words], copy 16/24 gray-10, white button [reference string, 3 words] (40 px, radius 8, ink text). Cols 2 and 3: 56 px icon tile (gray-3 dark, radius 12, inset highlight), title 16/500 + accent "NEW" pill (11 px, white on accent, fully round), copy gray-10, small outlined button (32 px, radius 8, border `#ffffff14`, 14/500 white).

### 9.8 Agent showcase with routine log (light) [S-home tile 3] [S-agent tiles 2 to 4]
Two columns. Left: accent eyebrow, H2 35/40/500, copy 16/24, ink button [reference string, 3 words] (40 px), then a numbered list [reference string, 5 words] items 18 px separated by hairlines; numbers 13 px gray; active item ink with a sub-line 14 px gray and a progress bar; inactive items gray-9. Right: panel bg gray-2, radius 16, containing stacked "Confirm action" cards: card white, radius 12, ring border; header label "Confirm action" 13 px gray, title 17/500 [reference string, 7 words]; key-value rows (label 15 px gray-10 in a 108 px column, value 15 px ink, avatar 24 px); footer strip gray-2 with "Ask Agent" (white, ring, cursor icon), "Deny" (white, ring), "Confirm" (ink fill), all 32 px radius 6.
Routine card (agent page): "Routine" title 15/500, trigger chip row (bolt icon, chip "New Hire" with person icon, "&", chip "New York Office", "+"), label "Then", step list rows (28 px app icon tile + title 13/500 + description 12 gray), later steps fade out. Routines list card: rows (white, ring, radius 8) with a 3 x 3 grid spinner, title 13/500, status line with shimmer ("Confirming their start date"); queued rows faded.
Routine catalog: 2-column list rows (icon tile 36 px saturated color, title 16/450, description 14 gray-11, chevron right), 88 px row pitch [S-agent tile 4].

### 9.9 Testimonial block [S-home tile 3] [S-agent tile 3]
Home: full-width 16:10 video poster (radius 8) with white quote text 24 px overlaid bottom-left and name/title; below, a tab row of 3 company logos with an accent progress underline on the active tab. Agent: centered 24 px quote, attribution "Name, Title" with name in ink and role gray, dot-matrix squares fading on both sides. **Weft rule: no testimonials.** Replace with a "Run log" block (see blueprint).

### 9.10 Stats block [S-home tile 5]
Customer grid: 4 x 2 logo cells (each 202 x 192, hairline grid lines, small 24 px round "↗" button top-right on hover cells) plus a 404 x 384 dark photo tile with a big stat "50/50" (48 px white) + "states registered" caption and attribution. Below: a sentence with a bolded name and "Customer Stories →" link. Pricing and payroll pages use the 3-column "01 / 02 / 03" mono-numbered feature stats with dotted accent left rules [S-payroll].

### 9.11 Security block [S-home tile 4] [S-agent tile 5]
Home: dark island like 9.7 with a compliance seal, H3 28/36 [reference string, 2 words], white button; columns "Integrations" and "API" with icon tiles and outlined buttons. Agent page: light row, H3 24/30 + [reference string, 3 words] right, then 3 columns divided by vertical hairlines, each a 16 px icon + 16/450 label ([reference string, 4 words], [reference string, 6 words], [reference string, 6 words]).

### 9.12 Integrations grid
Not rendered as a grid on the four pages captured; integrations appear as icons inside mocks (Google, Okta, Slack PNGs from `cdn.prod.joinwarp.com/integrations/`) and as the "Integrations" column of the dark security island [home-images.txt] [S-home tile 4]. Weft blueprint below defines an original grid of simulated providers.

### 9.13 News / resources carousel [S-home tile 5]
3 cards visible: media well (radius 8, 1 px border) 218 px tall; meta row (category 14 gray left, date 14 gray right); title 18/500; description 14 gray-11; [reference string, 3 words] 14/500 ink; [reference string, 3 words] link bottom-left; prev/next 36 px round bordered buttons bottom-right.

### 9.14 CTA band [S-home tile 6] [H]
Rounded 24 px, bg `#242424`, 1 px `gray-3` border, padding 64, 352 px tall; left: H2 40/48/450 white, two lines, last phrase lined in gray; copy 18 px white/80; white [reference string, 3 words] button (40 px, radius 8, ink 14/500) + play-link [reference string, 4 words] (white/80). Right half: abstract large curved bands (accent, white, black with hatched stripes) bleeding off the edge.

### 9.15 Footer [S-home tile 6]
Top hairline; 4-column link grid starting at x = 464 (left 350 px column holds the mark and badges), 2 rows of column groups (Products, Solutions, Resources, Free Tools / Compare, Company, Legal, Social); headings 14/450 ink, links 14 gray-10 with 29 px pitch; copyright 12 px gray bottom-left; then a full-bleed giant wordmark (about 300 px cap height) filled with pale accent scanlines fading downward.

### 9.16 Pricing [S-pricing]
Centered H1 48 px with lined accent word, subcopy 18 px centered max 580 px. Three equal columns separated by vertical hairlines, middle column tinted (`rgba(0,0,0,.024)`-ish warm wash) with an ink "Most Popular" chip (radius 6, 13 px). Column: plan name 24/30/600, price "$X per person/mo" 18 px (number bold), description 14 gray; divider; fee lines 14 gray; divider; feature list with 18 px filled ink check circles and 14 px text, 34 px pitch; bottom full-width buttons 42 px radius 8 (ink, or accent for the featured plan). Add-on cards use `rgba(0,0,0,.024)` fill + `rgba(0,0,0,.09)` border, radius 8 [PROBE-pricing].

## 10. Logged-in app look (from the mockups) [MOCK] [CSS-D] [CSS-AG]

### 10.1 Dashboard shell (homepage mockup, Macan) [mock-home-dashboard@2x.png] [mock-probe.json]
Design size: sidebar 244 px, header 48 px (`h-12`), agent panel 340 px; the mockup is rendered at about 0.75 scale (183 / 36 / 255 px).
- Sidebar (bg `#fafafa`, no right border; the main pane has a 1 px `#e5e5e5` left border): workspace switcher (20 px blue rounded avatar "R", name 14/500, blue "Admin" badge with blue-3 bg and blue-11 text 10 px, chevron-down). Nav items 14 px with 16 px line icons, about 36 px pitch; active item bg `#efefef` radius 8; expandable items show a right chevron. Group labels "Products ▾", "Company ▾" 12/500 gray with caret. Items (alphabetical within each group here, not in screen order): Calendar, Dashboard, Payroll, People | Benefits, Expenses, IT, Learning Management, Time Off, Time Tracking | Contracts, Integrations, Reports, Taxes & Compliance; "Settings" pinned bottom.
- Header (48 px, bottom border): sidebar-toggle icon left; centered search field (about 540 px, radius 8, 1 px border, search icon, placeholder [reference string, 3 words], kbd chips "⌘" "K" 16 px with border); right help and theme icons.
- Content: padding about 88 top / 52 sides at design scale; greeting H1 28/600 [reference string, 3 words]; widget grid 2 columns then 3 columns, 24 to 32 px gaps.
- Widget anatomy: header row outside the card (16 px icon in a gray tile + label 14 gray-11 + chevron right); card white, radius 12, 1 px `#e5e5e5`, `shadow-xs`; footer line under the card 12 px gray ([reference string, 5 words] ... "Review"; [reference string, 3 words] ... "Manage method").
- Widgets: Upcoming Payrolls (rows 72 px: circular progress ring with flag/globe, [reference string, 5 words] 14/500 + [reference string, 3 words] 12 gray; right status "✓ Autopay in 2d" green-11 500 or [reference string, 3 words] gray 500); Payroll Volume (big number 28/600 "$15,000,000", [reference string, 3 words], legend squares violet "US" and blue "Global", area chart with violet and blue lines and pale fills, right-side axis labels 10 px); People (KPI "800" 28/600 + "+26" green + "30d" gray, mini area chart blue); Onboarding (KPI + stat rows "Invited 8", "Onboarding 15", [reference string, 4 words] in a bordered list, 31 px rows, 14 px); New Hires (rows with 28 px initials avatar + small status badge, name 14/500, title 12 gray, status right "Active" green-11 or "Onboarding" blue-11); also Calendar rows [reference string, 5 words], Time off [reference string, 3 words], Benefits [reference string, 3 words], "401(k) Live" [mock-probe items].
- Agent panel (bg `#fafafa`, left border): header 48 px [reference string, 2 words] 14/600 + history and plus icons; user bubble right-aligned, bg gray-3 `#efefef`, radius 16 16 6 16, 14 px, max 85%; agent prose 14/22.75 gray-a11; tool trace lines (a "Read" verb plus the notice's file name), [reference string, 6 words] (verb in gray-9, object lighter); "Suggested change" card (white, 1 px border, radius 12, title 14/500, body 14 gray, pill button [reference string, 3 words] 12/500 bordered); bottom task row: empty circle checkbox + [reference string, 4 words] 14 gray, ink "✓ Approve" button (13/500, radius 8, padding 4 x 10); composer: white, 1 px border, radius 12, `shadow-xs`, padding 10 x 12, placeholder [reference string, 3 words], attach icon, send button.

### 10.2 Agent workspace (agent page mockup, Inter) [mock-agent-app@2x.png] [mock-probe.json]
- Sidebar 210 px (scaled), bg gray-2 `#f9f9f9`, padding 8/8/8/12; workspace row (teal "R" tile, name 14/500, chevron); search field (white, radius 8, `shadow-2`, "Search...", ⌘ K) + square "+" button; nav items 13/450, row height 24 to 28, radius 6, inactive gray-11 `#696969`, active bg gray-4 `#ebebeb` + ink; group labels "Products ▾", "Company ▾" 12 px gray-11; items include (alphabetical within each group here) Agent, Dashboard, Payroll, People | Benefits, Expenses, IT, Learning, Time Off, Time Tracking | Accounting, Calendar, Custom Agreements, Reports, Taxes & Compliance, Workplaces; help icon pinned bottom.
- Content frame ("canvas-frame"): white, radius 10, inset about 7 px from the window edge, 0.5 px hairline ring + soft shadow (`--shadow-2`).
- Breadcrumb header 44 px: panel toggle, [reference string, 4 words] (13 px, gray-11 then ink), "+" at right; bottom border gray-3.
- Conversation column about 450 px (scaled) centered right; user bubble bg gray-3, radius 12, with inline mention chip (avatar + blue-11 name); agent answer 14/24, weight 450, ink `#2d2d2d`; collapsible step summary [reference string, 6 words] in gray-11; status line "Permission asked" gray-11; streaming caret and per-letter fade.
- Confirm-action card: radius 12, ring; "Confirm action" 12/500 gray-11, title 13/500; rows label (gray-11, about 80 px column) / value (ink) incl. avatar + blue name, amount, reason; footer strip gray-2 with "Deny" (white, ring, 12/500, h 21 at scale, radius 6) and "Confirm" (gray-12 fill, white).
- Composer: radius 12, ring, [reference string, 2 words] 14 px placeholder, "+" bottom-left, 24 px round send button bottom-right (gray-9 idle, ink with stop square while streaming).
- Floating side card ("agent-float"): payroll run table overlapping the frame edge, outer gray-2 padding with inner white card radius 12, header with spinner-check icon + [reference string, 5 words] 14/550 + [reference string, 3 words] 13/500 gray-11; a 2 px green-9 progress rule; table header 12 px gray (Employee / Hours / Gross Pay); rows 47 px: 20 px avatar, name 13/500, title 12 gray-11, right-aligned tabular numbers 13 px, deltas 11 px with arrows (crimson-11 down, green-11 up); footer row "Total (9)" on gray-2; changed rows flash with `pay-row-shimmer`.
- Other mock surfaces on /agent: expense table with grouped bands [reference string, 3 words] (amber dotted circle) and "Approved 4" (green check), merchant logos column; chat channel mock "# hiring" with message composer; permissions screen with "Human permissions" / "Agent permissions" lists (View / Edit / Approve rows with descriptions); toast [reference string, 3 words] with green check [S-agent tiles 2 to 5].

## 11. Brand and legal substitutions for Weft

| Warp element | Weft replacement |
|---|---|
| Name "Warp", striped fan logo, "warp" footer wordmark | Name "Weft". Original mark: a 2 x 2 over-under weave square (two vertical bars and two horizontal bars interlaced) in ink; wordmark "weft" set in Inter 600, tracking -0.04em. Footer giant wordmark "weft" using the same CSS scanline technique (our own text). |
| Restart Soft, Macan, Berkeley Mono, New York | Inter Variable, JetBrains Mono, Newsreader (all OFL, self-hosted via @fontsource) |
| Accent `#ff3d00` | Keep the mood with Weft "loom" vermilion `#fa4800` (same lightness/chroma steps as Warp's accent scale, hue rotated from 34 to 40 degrees). Scale in section 12. |
| Customer logos strip | Marquee of simulated providers, all labeled as simulators: "Sim IRS e-file", "Sim CA EDD", "Sim NY DOL", "Sim ACH Bank", "Sim Benefits Carrier", "Sim Identity (SSO)", "Sim Laptop Vendor", "Sim FX Rails" rendered as text plus original line icons, label "Everything runs against simulators in this repo". |
| Testimonials, customer photo stat tile, "Loved by" grid | "Run log" block: a real (seeded) agent run rendered as a timeline with timestamps and approvals; stats tile shows live numbers from the demo company ("50/50 states simulated", "1,284 synthetic employees"). Company names in demo data are visibly fictional, e.g. "Larkspur Robotics (demo)". |
| Compliance seals (AICPA SOC, G2) | None. Security block lists architecture facts that are true for Weft (self-hosted, audit log, human approvals, no data leaves your machine with the local model). |
| Hero currency-glyph canvas | Original "loom" canvas: a mono glyph field where columns of `|` (warp threads) and rows of `-` (weft threads) plus currency glyphs drift, accent-tinted where the agent is "working". |
| CTA band swoosh art | Original SVG: three interlaced bands (vermilion, white, ink with hatching) crossing over and under like a weave, bleeding off the right edge. |
| Photos | None; use product mockups and original SVG only. |
| Copy | Original (examples in section 13). |

## 12. Token file (ready to paste)

```css
/* weft-tokens.css: original Weft tokens mirroring the look of the reference. */
:root {
  /* neutrals (light) */
  --gray-1: #fcfcfc; --gray-2: #f9f9f9; --gray-3: #efefef; --gray-4: #e8e8e8;
  --gray-5: #e0e0e0; --gray-6: #d9d9d9; --gray-7: #cecece; --gray-8: #bbbbbb;
  --gray-9: #8d8d8d; --gray-10: #838383; --gray-11: #646464; --gray-12: #202020;
  --gray-a2: #00000006; --gray-a3: #00000010; --gray-a4: #00000017; --gray-a5: #0000001f;
  --gray-a6: #00000026; --gray-a9: #00000072; --gray-a10: #0000007c; --gray-a11: #0000009b; --gray-a12: #000000df;
  --black-a1: #0000000d; --black-a2: #0000001a; --black-a3: #00000026;

  /* Weft accent "loom" (12 steps) */
  --accent-1: #fffcfb; --accent-2: #fff7f4; --accent-3: #ffeae2; --accent-4: #ffd8c6;
  --accent-5: #ffc8af; --accent-6: #ffb99d; --accent-7: #ffa585; --accent-8: #f78a63;
  --accent-9: #fa4800; --accent-10: #ed3700; --accent-11: #dd2600; --accent-12: #5f2610;
  --accent-surface: #fff5f1cc; --accent-contrast: #ffffff;

  /* status */
  --green-3: #e6f6eb; --green-9: #30a46c; --green-11: #218358;
  --blue-3: #e6f4fe;  --blue-9: #0090ff;  --blue-11: #0d74ce;
  --amber-3: #fff8e7; --amber-9: #f59e0b; --amber-11: #ac6500;
  --red-3: #ffeae6;   --red-9: #e5484d;   --red-11: #ce2c31;
  --violet-9: #6e56cf; --purple-9: #8e4ec6; --cyan-9: #00a5b9; --pink-9: #d6409f;

  /* semantic */
  --background: #ffffff; --foreground: var(--gray-12); --muted: var(--gray-11); --subtle: var(--gray-10);
  --border: var(--gray-4); --card: #ffffff; --well: var(--gray-2); --ink-surface: #242424; --island: #2b2b2b;
  --primary: var(--accent-9); --primary-fg: #ffffff; --success: var(--green-11); --warning: var(--amber-9);
  --danger: var(--red-9); --info: var(--blue-11);

  /* app shell */
  --app-sidebar-bg: #fafafa; --app-sidebar-w: 244px; --app-header-h: 48px; --app-agent-w: 340px;
  --app-border: #e5e5e5; --app-item-active: #efefef;

  /* type */
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-serif: "Newsreader Variable", ui-serif, Georgia, serif;
  --font-weight-book: 450; --font-weight-medium-plus: 550;

  /* layout */
  --page-max-width: 1280px; --page-padding: 32px; --nav-h: 56px; --banner-h: 44px;

  /* radii */
  --radius-xs: 2px; --radius-sm: 4px; --radius-md: 6px; --radius-btn: 7px; --radius-lg: 8px;
  --radius-xl: 12px; --radius-2xl: 16px; --radius-3xl: 24px;

  /* shadows */
  --shadow-border: 0 0 0 1px #00000014;
  --shadow-xs: 0 1px 2px rgba(0,0,0,.05);
  --shadow-small: 0 2px 2px #0000000a;
  --shadow-medium: 0 2px 2px #0000000a, 0 8px 8px -8px #0000000a;
  --shadow-large: 0 2px 2px #0000000a, 0 8px 16px -4px #0000000a;
  --shadow-menu: var(--shadow-border), 0 1px 1px #00000005, 0 4px 8px -4px #0000000a, 0 16px 24px -8px #0000000f;
  --shadow-modal: var(--shadow-border), 0 1px 1px #00000005, 0 8px 16px -4px #0000000a, 0 24px 32px -8px #0000000f;
  --shadow-card: 0 0 0 1px #00000010, 0 0 0 .5px rgba(0,0,0,.05), 0 1px 1px #00000006, 0 2px 1px -1px rgba(0,0,0,.05), 0 1px 3px rgba(0,0,0,.05);
  --shadow-product: 0 1px 1px rgb(0 0 0/.05), 0 6px 12px -4px rgb(0 0 0/.024), 0 12px 24px -8px rgb(0 0 0/.024), 0 24px 48px -16px rgb(0 0 0/.024), 0 48px 96px -32px rgb(0 0 0/.024);
  --shadow-float: var(--shadow-product), 0 10px 28px -8px rgb(0 0 0/.07), 0 28px 56px -16px rgb(0 0 0/.05);
  --shadow-btn-dark: inset 0 1px 0 rgba(255,255,255,.12), 0 1px 2px rgba(0,0,0,.3);

  /* motion */
  --ease-standard: cubic-bezier(.2,0,0,1);
  --ease-out-expo: cubic-bezier(.16,1,.3,1);
  --ease-menu: cubic-bezier(.22,1,.36,1);
  --ease-default: cubic-bezier(.4,0,.2,1);
  --dur-press: 100ms; --dur-fast: 150ms; --dur-menu: 350ms; --dur-pop: 250ms;
}

/* Dark scope: apply .dark to a section (islands, CTA band) or to <html> for app dark mode */
.dark {
  --gray-1: #242424; --gray-2: #2b2b2b; --gray-3: #333333; --gray-4: #393939; --gray-5: #3e3e3e;
  --gray-6: #464646; --gray-7: #525252; --gray-8: #696969; --gray-9: #757575; --gray-10: #808080;
  --gray-11: #b6b6b6; --gray-12: #eeeeee;
  --gray-a3: #ffffff11; --gray-a4: #ffffff18; --gray-a6: #ffffff28; --gray-a11: #ffffffaa; --gray-a12: #ffffffeb;
  --accent-1: #2a221f; --accent-2: #302420; --accent-3: #4c2517; --accent-4: #632105; --accent-5: #712605;
  --accent-6: #7f3112; --accent-7: #96401f; --accent-8: #bd4f25; --accent-9: #fa4800; --accent-10: #ec3900;
  --accent-11: #ff8852; --accent-12: #ffd2c3; --accent-surface: #3e241f80;
  --background: #242424; --foreground: #eeeeee; --border: #ffffff14; --card: #2b2b2b; --well: #2b2b2b;
  --app-sidebar-bg: #1f1f1f; --app-border: #3d3d3d; --app-item-active: #333333;
}

/* Signature effects */
.text-lined { -webkit-text-fill-color: transparent; background: repeating-linear-gradient(0deg, currentColor 0 50%, transparent 50% 100%) 0 0 / 100% .05em; -webkit-background-clip: text; background-clip: text; }
.text-lined-strong { -webkit-text-fill-color: transparent; background: repeating-linear-gradient(0deg, currentColor 0 68%, transparent 68% 100%) 0 0 / 100% .05em; -webkit-background-clip: text; background-clip: text; }
.border-lined { border-left: 1px solid; border-image: repeating-linear-gradient(to bottom, var(--accent-9) 0 1px, transparent 1px 2px) 1; }
.shimmer-text { -webkit-text-fill-color: transparent; background-image: linear-gradient(90deg, #0a111180 0% 30%, #dcdcdcb3 50%, #0a111180 70% 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; animation: weft-shimmer 2.5s linear infinite; }
.press { transition: background-color var(--dur-press) var(--ease-standard), box-shadow var(--dur-press) var(--ease-standard), color var(--dur-press) var(--ease-standard), transform var(--dur-press) var(--ease-standard); }
.press:not(:disabled):active { scale: .99; }
.caret { display: inline-block; width: 1.5px; height: 1em; margin-left: 1px; background: currentColor; transform: translateY(2px); animation: weft-caret 1.05s step-end infinite; }
@keyframes weft-shimmer { 0% { background-position: 200% 0 } to { background-position: -200% 0 } }
@keyframes weft-caret { 0%, 49% { opacity: 1 } 50%, to { opacity: 0 } }
@keyframes weft-pop { 0% { opacity: 0; transform: translateY(6px) scale(.97) } to { opacity: 1; transform: none } }
@keyframes weft-slide-up { 0% { opacity: 0; transform: translateY(12px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes weft-letter-in { 0% { opacity: 0; filter: blur(2px); transform: translateY(3px) } to { opacity: 1; filter: none; transform: none } }
@keyframes weft-row-flash { from { transform: translateX(-100%) } to { transform: translateX(100%) } }
@keyframes weft-grid-chase { 0% { background-color: #1d1c1d } 12.5% { background-color: #4a4a4a } 25% { background-color: #8a8a8a } 37.5% { background-color: #b5b5b5 } 50%, to { background-color: #d9d9d9 } }
@media (prefers-reduced-motion: reduce) {
  .shimmer-text, .caret { animation: none; -webkit-text-fill-color: currentColor; background-image: none; }
  .press { transition: none; }
}
```

```css
/* Tailwind v4: app.css */
@import "tailwindcss";
@import "./weft-tokens.css";

@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, monospace;
  --font-serif: "Newsreader Variable", ui-serif, serif;
  --font-weight-book: 450;
  --font-weight-medium-plus: 550;

  --breakpoint-mobile: 40rem;   /* 640 */
  --breakpoint-tablet: 48rem;   /* 768 */
  --breakpoint-laptop: 64rem;   /* 1024 */
  --breakpoint-desktop: 80rem;  /* 1280 */

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-border: var(--border);
  --color-card: var(--card);
  --color-well: var(--well);
  --color-island: var(--island);
  --color-ink-surface: var(--ink-surface);
  --color-muted: var(--muted);
  --color-subtle: var(--subtle);
  --color-primary: var(--primary);
  --color-primary-fg: var(--primary-fg);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --color-info: var(--info);
  --color-gray-1: var(--gray-1);  --color-gray-2: var(--gray-2);  --color-gray-3: var(--gray-3);
  --color-gray-4: var(--gray-4);  --color-gray-5: var(--gray-5);  --color-gray-6: var(--gray-6);
  --color-gray-7: var(--gray-7);  --color-gray-8: var(--gray-8);  --color-gray-9: var(--gray-9);
  --color-gray-10: var(--gray-10); --color-gray-11: var(--gray-11); --color-gray-12: var(--gray-12);
  --color-gray-a3: var(--gray-a3); --color-gray-a4: var(--gray-a4); --color-gray-a11: var(--gray-a11);
  --color-accent-2: var(--accent-2); --color-accent-3: var(--accent-3); --color-accent-9: var(--accent-9);
  --color-accent-10: var(--accent-10); --color-accent-11: var(--accent-11);
  --color-green-3: var(--green-3); --color-green-9: var(--green-9); --color-green-11: var(--green-11);
  --color-blue-3: var(--blue-3); --color-blue-9: var(--blue-9); --color-blue-11: var(--blue-11);
  --color-amber-3: var(--amber-3); --color-amber-9: var(--amber-9); --color-amber-11: var(--amber-11);
  --color-red-3: var(--red-3); --color-red-9: var(--red-9); --color-red-11: var(--red-11);
  --color-violet-9: var(--violet-9);

  --radius-xs: 2px; --radius-sm: 4px; --radius-md: 6px; --radius-btn: 7px; --radius-lg: 8px;
  --radius-xl: 12px; --radius-2xl: 16px; --radius-3xl: 24px;

  --shadow-border: var(--shadow-border);
  --shadow-xs: var(--shadow-xs);
  --shadow-menu: var(--shadow-menu);
  --shadow-modal: var(--shadow-modal);
  --shadow-card: var(--shadow-card);
  --shadow-product: var(--shadow-product);
  --shadow-float: var(--shadow-float);

  --ease-standard: cubic-bezier(.2,0,0,1);
  --ease-out-expo: cubic-bezier(.16,1,.3,1);
  --ease-menu: cubic-bezier(.22,1,.36,1);

  /* named type scale (size / line-height / tracking) */
  --text-0: 11px;  --text-0--line-height: 16px; --text-0--letter-spacing: .003em;
  --text-1: 12px;  --text-1--line-height: 16px; --text-1--letter-spacing: .0025em;
  --text-2: 14px;  --text-2--line-height: 20px;
  --text-3: 16px;  --text-3--line-height: 24px;
  --text-4: 18px;  --text-4--line-height: 26px; --text-4--letter-spacing: -.0025em;
  --text-5: 20px;  --text-5--line-height: 28px; --text-5--letter-spacing: -.005em;
  --text-6: 24px;  --text-6--line-height: 30px; --text-6--letter-spacing: -.00625em;
  --text-7: 28px;  --text-7--line-height: 36px; --text-7--letter-spacing: -.0075em;
  --text-8: 35px;  --text-8--line-height: 40px; --text-8--letter-spacing: -.01em;
  --text-hero: 46px; --text-hero--line-height: 1.1; --text-hero--letter-spacing: -.01em;
  --text-9: 60px;  --text-9--line-height: 60px; --text-9--letter-spacing: -.025em;

  --animate-shimmer: weft-shimmer 2.5s linear infinite;
  --animate-pop: weft-pop .25s var(--ease-standard) both;
  --animate-slide-up: weft-slide-up .2s ease-out both;
  --animate-grid-chase: weft-grid-chase 1s linear infinite;
}

@layer base {
  html { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; scrollbar-gutter: stable; }
  body { background: var(--background); color: var(--foreground); }
  .tabular { font-variant-numeric: tabular-nums; }
}
```

Inter note: Inter's x-height is larger than Restart Soft's; at display sizes enable the display optical size with `font-variation-settings: "opsz" 32` and keep tracking at -0.01em to -0.02em so headlines read as tight as the reference.

## 13. Page blueprints (original copy)

All copy below is original. Demo names are fictional and marked as demo.

### 13.1 Landing page `/`

1. Announcement bar (44 px, `bg-ink-surface`): "New" in accent | "Weft 0.1: an open-source HR agent you can run on a laptop ›" | close X.
2. Sticky nav (56 px, `bg-background/95 backdrop-blur-sm`, border appears on scroll): Weft mark + wordmark | Product ⌄ (mega menu: Agent, People, Payroll, Tax Compliance, Benefits, IT, Contractors, Routines; each 36 px icon tile + title + one-line description) | Developers ⌄ (API, MCP server, Simulators, Self-hosting) | Docs | GitHub | right: "Open the demo" (ghost) + "Run locally ›" (ink, 32 px, radius 7).
3. Hero (pt-20, gap-11, loom canvas behind on desktop): ticker eyebrow "Synthetic payroll processed in this demo: $4,812,330.17" (live, tabular); H1 46/1.1/500, two lines: "People operations," / "`<span class="text-accent-9 text-lined-strong">handled</span>`." (do not reuse the reference's "runs itself" phrasing); subcopy 18/27 gray-a11: "Weft is an open-source HRIS, payroll and benefits platform with an agent that does the admin work and asks before it acts. Everything runs on synthetic data and in-repo simulators."; CTA row: command pill (gray-3 bg, mono `pnpm dlx weft demo` with copy button) + accent button "Open the demo →" (44 px, radius 9); right link "Watch a 90-second run" with play circle.
4. Product mockup frame (1216 wide, radius 12, `shadow-product`): live app shell screenshot component (Dashboard + agent panel showing a seeded run: "A CA EDD notice arrived in the shared inbox. I matched it to 30 employees and drafted an SUI rate fix.").
5. Simulators strip (sticky bottom in hero, marquee 37 px/s): label "Runs against simulators, not real agencies" + text-and-icon items from section 11.
6. Two-tone heading (dotted rule): "Payroll, compliance, benefits and IT on autopilot. Built in the open, run on your own machine."
7. Product grid 3 x 2 (cards per 9.6): People ("From offer to day one in minutes."), Payroll ("Gross to net, taxes and pay stubs for every state in the simulator."), Benefits ("Enroll, change and renew plans against a simulated carrier."), Tax Compliance ("Notices are read, matched and resolved with an audit trail."), IT ("Accounts and laptops provisioned on hire, revoked on exit."), Contractors ("Pay contractors in 40 simulated currencies."). Each visual well is an original mini UI.
8. Dark island (9.7): "Hand off the work." | Routines (NEW pill): "Jobs that start on an event or a schedule and run until they finish." button "See routines" | MCP + API: "Drive Weft from Claude or any MCP client, or call the REST API." button "Read the docs".
9. Two-tone heading: "A different default. The agent does the work and you make the calls."
10. Feature trio with dotted rules and mono numerals 01/02/03: "Agent first", "Simulated end to end", "Yours to run".
11. Agent showcase with routine log (9.8): eyebrow "Agent", H2 "Routines that see the job through.", autoplay list "01. Onboarding a new hire" "02. Checking a payroll run" "03. Answering a tax notice" "04. A routine you write"; right panel cycles Confirm-action cards from the seeded demo ("Add Priya Nair's missed overtime?" with Person / Amount / Reason rows; Deny / Confirm / Ask agent).
12. Run log block (replaces testimonial): full-width card, timeline of one real seeded run with timestamps, tool calls, the approval, and the result; header "What a run looks like".
13. Security / architecture dark island: "Private by default." | "Audit log" | "Human approvals" | "Local model support".
14. Stats block (live from demo DB): 4 tiles "50 states in the tax simulator", "1,284 synthetic employees", "312 agent runs logged", "0 real agencies contacted".
15. CTA band (radius 24, `#242424`, p-64): H2 40/48 white "Run your company on <span class='text-lined' style='color:var(--gray-9)'>Weft</span>." copy "Clone it, seed it, and watch the agent work." buttons white "Open the demo" + "Read the setup guide"; right: original woven-bands SVG.
16. Footer: mark; columns Product, Developers, Project (GitHub, License, Changelog), Legal ("Demo data is fictional"); copyright "Weft contributors, MIT licensed"; giant scanline "weft" wordmark in accent-4 fading out.

### 13.2 Agent page `/agent` (page bg `gray-1 #fcfcfc`)

1. Hero, two columns: left eyebrow (cursor icon) "Weft agent", H1 44/1.05/450 "The HR teammate that reads the notice and drafts the fix"; right paragraph 18/27 with key phrases in ink and the rest in gray-a10: "It sets up new hires, prepares each pay run, works through agency notices and handles benefit enrollment, then shows you its work and waits for your sign-off before any money moves." CTA: command pill + accent "Try the agent ›" (40 px, radius 7).
2. Live agent workspace mock (section 10.2) at 1043 x 678 with the floating payroll card on the right; conversation types itself out on enter.
3. Feature trio with tall wells (`bg-well`, radius 12): "Always on", "Routines", "Guardrails"; "Explore ›".
4. Scroll scenes 01 / 02 / 03 (sticky left mock, numerals 48 px gray-9): "Ask about your people data", "Grounded in your records", "Mention @weft in team chat (simulated)".
5. Routines: eyebrow "Routines", H2 "Jobs that begin on their own"; 3 cards (routine builder, running routines list with grid spinners and shimmer, chat approval card with Approve / Deny); "Starter routines" 2 big cards + 8-row catalog with colored icon tiles: Weekly people report, Payroll anomaly check, Expense policy review, Open enrollment, Time-off routing, New hire readiness, Monthly exec summary, Work anniversaries.
6. Permissions and audit: H2 "Decide exactly what the agent may do"; permissions matrix mock (Human vs Agent: View / Edit / Approve), feature pair "Audit log" and "Undo any action".
7. Architecture row (3 columns, vertical hairlines): "Self-hosted", "Bring your own model (Claude, local Qwen, scripted)", "Every tool call logged".
8. Centered CTA: H2 44 px "Give the agent a real task" + accent button + "Watch a run".

### 13.3 App shell `/app`

- Layout: CSS grid `grid-template-columns: var(--app-sidebar-w) 1fr var(--app-agent-w)`; rows `var(--app-header-h) 1fr`; agent panel collapsible (toggle in header), sidebar collapsible to 56 px icons.
- Sidebar (`bg-[--app-sidebar-bg]`): workspace switcher ("Larkspur Robotics (demo)" + "Admin" blue badge) | Home, Inbox (agent approvals count badge in accent), Payroll ›, People ›, Calendar | group "Products ▾": Benefits, IT, Expenses, Time Off ›, Time Tracking › | group "Company ▾": Taxes & Compliance ›, Reports, Documents, Integrations (simulators) | bottom: Settings, Routines, help. Items 32 px, 14 px, 16 px lucide icons stroke 1.5, active `bg-[--app-item-active]` radius 8, hover gray-a3.
- Header (48 px, bottom border `--app-border`): sidebar toggle; breadcrumb (gray-11 › ink); right: one environment pill (model, simulated clock, Viewing as) and the agent panel toggle. Wave 3 superseded the centered command search: search moved to the top of the sidebar (a 32 px field with one ⌘K chip and a square New agent thread button), and the bar shows a ghost search icon only while the sidebar is hidden. Full spec in `research/wave3/topbar-design.md`.
- Main: max content width about 1040, padding 32 (88 top on Home); Home greeting 28/600 "Good afternoon, Dana"; widget grid (Upcoming payrolls, Payroll volume, Headcount, Onboarding, New hires, Approvals waiting) per 10.1 anatomy.
- Tables (People, Payroll run): header row 12/500 gray-11, rows 48 px with 24 px avatar + name 14/500 + title 12 gray-11, right-aligned tabular money, status text colors (green-11 Active, blue-11 Onboarding, amber-11 Needs review, red-11 Failed), grouped bands with 20% color washes (`.group-band-wash` technique), row flash on agent change.
- Agent panel (340 px, `bg-[--app-sidebar-bg]`, left border): header "Agent" + history + new; messages per 10.1 and 10.2 (user bubble gray-3 radius 16/16/6/16, agent prose 14/22, tool trace lines, shimmer "Working..." status, Confirm-action cards with Deny / Confirm, inline approval tasks); composer radius 12 with attach and send.
- Dark mode: `.dark` on `<html>` using the dark token block (sidebar `#1f1f1f`, borders `#3d3d3d`), as in [CSS-D] `dark:bg-[#1F1F1F] dark:border-[#3D3D3D]`.

## 14. Gaps and caveats

- Mega-menu hover did not open under Playwright hover; it opened via keyboard (Enter), so the open-state geometry is from keyboard focus (blue focus ring visible on the first item) [MENU].
- /agent scroll scenes render empty in static full-page shots because they animate on scroll; their content was read from the 2x element shot and visible tiles [S-agent].
- Restart Soft vs Inter: Inter is wider with a larger x-height; expect headlines to run about 3 to 5% wider. Geist is the fallback if the team prefers a slightly softer, narrower feel.
- No integrations grid page was captured (not in the four requested pages); 9.12 describes how integrations appear on these pages and 13.1 defines Weft's own.
- Marquee speed (about 37 px/s) is measured, not read from code.
