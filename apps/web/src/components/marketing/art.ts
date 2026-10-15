// Original Weft art, generated from code so it is reproducible and owns no outside asset. Owner: t6-site.
// Pure geometry plus SVG string serializers; brand.tsx renders the same data as JSX, and
// `pnpm exec tsx apps/web/src/components/marketing/export-brand.ts` writes the static files in public/brand/.

export const INK = "#202020";
export const INK_BAND = "#242424";
export const PAPER = "#fcfcfc";
export const MADDER = "#d6264b";

// ---- weave mark ------------------------------------------------------------------------------------------------
// A 2x2 over-under weave on a 32 unit square: two vertical threads (paper) and two horizontal weft threads (madder).
// Top-left and bottom-right crossings: the weft passes over; the other two: the vertical thread passes over.

export interface Stroke { d: string; stroke: string; width: number }

export function weaveMarkStrokes(opts: { ground?: string; vertical?: string; weft?: string } = {}): Stroke[] {
  const ground = opts.ground ?? INK, v = opts.vertical ?? PAPER, w = opts.weft ?? MADDER;
  const T = 5.5, H = 8.5;   // thread width and halo width (the halo leaves a 1.5 unit gap each side)
  return [
    { d: "M11 3.5V28.5", stroke: v, width: T },
    { d: "M21 3.5V28.5", stroke: v, width: T },
    { d: "M3.5 11H28.5", stroke: ground, width: H },
    { d: "M3.5 11H28.5", stroke: w, width: T },
    { d: "M3.5 21H28.5", stroke: ground, width: H },
    { d: "M3.5 21H28.5", stroke: w, width: T },
    { d: "M21 6.75V15.25", stroke: ground, width: H },
    { d: "M21 6.25V15.75", stroke: v, width: T },
    { d: "M11 16.75V25.25", stroke: ground, width: H },
    { d: "M11 16.25V25.75", stroke: v, width: T },
  ];
}

export function weaveMarkSvg(opts: { size?: number; title?: string } = {}): string {
  const size = opts.size ?? 32;
  const strokes = weaveMarkStrokes().map((s) => `<path d="${s.d}" stroke="${s.stroke}" stroke-width="${s.width}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" role="img" aria-label="Weft"><title>${opts.title ?? "Weft mark: a 2x2 over-under weave"}</title><rect width="32" height="32" rx="7" fill="${INK}"/><g fill="none" stroke-linecap="butt">${strokes}</g></svg>`;
}

export function wordmarkSvg(opts: { color?: string } = {}): string {
  const color = opts.color ?? INK;
  const strokes = weaveMarkStrokes().map((s) => `<path d="${s.d}" stroke="${s.stroke}" stroke-width="${s.width}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 112 32" width="112" height="32" role="img" aria-label="Weft"><title>Weft wordmark</title><rect width="32" height="32" rx="7" fill="${INK}"/><g fill="none" stroke-linecap="butt">${strokes}</g><text x="42" y="24" fill="${color}" font-family="Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif" font-size="25" font-weight="600" letter-spacing="-1">weft</text></svg>`;
}

// ---- woven bands (CTA band art) ---------------------------------------------------------------------------------
// Three wide bands sweep up and off the right edge and cross each other over and under, like threads on a loom.
// Each crossing alternates which band is on top. Bands are drawn in order; an "over" crossing for an earlier band is
// drawn again on top as a short segment with a dark halo so the gap between threads reads.

type Pt = [number, number];
type Cubic = [Pt, Pt, Pt, Pt];

export interface Band { id: string; color: string; hatch: boolean; curve: Cubic }
export interface Over { band: Band; d: string; under: string; cx: number; cy: number; r: number }
export interface WovenBands { width: number; height: number; bandWidth: number; ground: string; bands: { band: Band; d: string }[]; overs: Over[] }

const BANDS: Band[] = [
  { id: "ink", color: "#141414", hatch: true, curve: [[300, -60], [370, 110], [470, 270], [580, 420]] },
  { id: "paper", color: "#f3efea", hatch: false, curve: [[-40, 120], [200, 160], [430, 290], [660, 330]] },
  { id: "madder", color: MADDER, hatch: false, curve: [[120, 400], [260, 260], [440, 90], [620, -40]] },
];

function at(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

const N = 240;
function sample(c: Cubic): Pt[] { return Array.from({ length: N + 1 }, (_, i) => at(c, i / N)); }
const fmt = (p: Pt) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
const cubicPath = (c: Cubic) => `M${fmt(c[0])}C${fmt(c[1])} ${fmt(c[2])} ${fmt(c[3])}`;

function segIntersect(p: Pt, p2: Pt, q: Pt, q2: Pt): Pt | null {
  const r: Pt = [p2[0] - p[0], p2[1] - p[1]], s: Pt = [q2[0] - q[0], q2[1] - q[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
  const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p[0] + t * r[0], p[1] + t * r[1]] : null;
}

function crossings(a: Pt[], b: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) {
    const x = segIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
    if (x) out.push(x);
  }
  return out;
}

/**
 * Bands are drawn in order (later bands on top). At every other crossing the earlier band is drawn again on top,
 * masked to the later band's footprint near the crossing (a circle clip keeps it local), with a ground-colored halo
 * so the gap between threads reads.
 */
export function wovenBands(opts: { width?: number; height?: number; bandWidth?: number; ground?: string } = {}): WovenBands {
  const width = opts.width ?? 600, height = opts.height ?? 352, bandWidth = opts.bandWidth ?? 60, ground = opts.ground ?? INK_BAND;
  const pts = BANDS.map((b) => sample(b.curve));
  const overs: Over[] = [];
  let flip = false;
  for (let i = 0; i < BANDS.length; i++) for (let j = i + 1; j < BANDS.length; j++) {
    for (const [cx, cy] of crossings(pts[i]!, pts[j]!)) {
      flip = !flip;
      if (flip && cx > -bandWidth && cx < width + bandWidth && cy > -bandWidth && cy < height + bandWidth) {
        overs.push({ band: BANDS[i]!, d: cubicPath(BANDS[i]!.curve), under: cubicPath(BANDS[j]!.curve), cx, cy, r: bandWidth * 1.5 });
      }
    }
  }
  return { width, height, bandWidth, ground, bands: BANDS.map((b) => ({ band: b, d: cubicPath(b.curve) })), overs };
}

export const HATCH_ID = "weft-band-hatch";

export function wovenBandsSvg(opts: Parameters<typeof wovenBands>[0] = {}): string {
  const w = wovenBands(opts);
  const draw = (x: { band: Band; d: string }) =>
    `<path d="${x.d}" stroke="${w.ground}" stroke-width="${w.bandWidth + 10}"/><path d="${x.d}" stroke="${x.band.color}" stroke-width="${w.bandWidth}"/>${x.band.hatch ? `<path d="${x.d}" stroke="url(#${HATCH_ID})" stroke-width="${w.bandWidth}"/>` : ""}`;
  const defs = w.overs.map((o, k) => `<clipPath id="weft-over-c${k}"><circle cx="${o.cx.toFixed(1)}" cy="${o.cy.toFixed(1)}" r="${o.r.toFixed(1)}"/></clipPath><mask id="weft-over-m${k}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w.width}" height="${w.height}"><path d="${o.under}" fill="none" stroke="#fff" stroke-width="${w.bandWidth + 14}"/></mask>`).join("");
  const overs = w.overs.map((o, k) => `<g clip-path="url(#weft-over-c${k})"><g mask="url(#weft-over-m${k})">${draw(o)}</g></g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.width} ${w.height}" width="${w.width}" height="${w.height}" role="img" aria-label="Three woven bands"><title>Woven bands</title><defs><pattern id="${HATCH_ID}" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 1H5" stroke="#ffffff" stroke-opacity=".34" stroke-width="1"/></pattern>${defs}</defs><rect width="${w.width}" height="${w.height}" fill="${w.ground}"/><g fill="none" stroke-linecap="butt">${w.bands.map(draw).join("")}${overs}</g></svg>`;
}

// ---- loom glyph field (hero background) ----------------------------------------------------------------------------
// A mono glyph grid: vertical threads as '|' columns, weft rows as '-', and currency glyphs scattered through it,
// denser toward the right, with a few madder glyphs where the agent is "working". Deterministic (seeded PRNG).

export interface Glyph { x: number; y: number; ch: string; accent: boolean; o: number }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CURRENCY = ["$", "€", "£", "¥", "₹", "₩", "¢", "₣", "₱", "%"];

export function loomGlyphs(opts: { cols?: number; rows?: number; seed?: number } = {}): { cols: number; rows: number; glyphs: Glyph[] } {
  const cols = opts.cols ?? 72, rows = opts.rows ?? 26;
  const rand = mulberry32(opts.seed ?? 20261015);
  const glyphs: Glyph[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const right = c / cols;                       // 0 at the left edge, 1 at the right
    const density = 0.08 + right * right * 0.7;
    const roll = rand();
    if (roll > density) continue;
    let ch: string;
    if (c % 6 === 0) ch = "|";
    else if (r % 4 === 0) ch = "-";
    else ch = rand() < 0.35 ? CURRENCY[Math.floor(rand() * CURRENCY.length)]! : rand() < 0.5 ? "·" : "+";
    glyphs.push({ x: c, y: r, ch, accent: rand() < 0.025 * right, o: 0.25 + right * 0.55 });
  }
  return { cols, rows, glyphs };
}

export function loomGlyphsSvg(opts: Parameters<typeof loomGlyphs>[0] = {}): string {
  const g = loomGlyphs(opts);
  const cw = 16, rh = 22;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const text = g.glyphs.map((x) => `<text x="${x.x * cw + cw / 2}" y="${x.y * rh + 16}" fill="${x.accent ? MADDER : "#bbbbbb"}" fill-opacity="${x.accent ? 0.9 : x.o.toFixed(2)}">${esc(x.ch)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.cols * cw} ${g.rows * rh}" width="${g.cols * cw}" height="${g.rows * rh}" role="img" aria-label="Loom glyph field"><title>Loom glyph field</title><g font-family="JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace" font-size="13" text-anchor="middle">${text}</g></svg>`;
}
