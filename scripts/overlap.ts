// Pure helpers behind `pnpm brand:overlap` (scripts/brand-overlap.ts): pull the visible text out of an HTML page,
// normalize text into words, and find every run of N or more consecutive words that two texts share.
// No file or process access here, so tests/brand-overlap.test.ts can exercise it with synthetic strings.

export const MIN_RUN = 8;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "...", mdash: " ", ndash: " ", middot: " ", copy: " ", reg: " ", trade: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Attributes whose values a visitor sees or hears (alt text, labels, placeholders, tooltips). */
const VISIBLE_ATTRS = /\s(?:alt|aria-label|placeholder|title)\s*=\s*("([^"]*)"|'([^']*)')/gi;
/** Meta tags whose content is page copy (search snippet and social cards). */
const META_COPY = /<meta\b[^>]*\b(?:name|property)\s*=\s*["'](?:description|og:title|og:description|twitter:title|twitter:description)["'][^>]*>/gi;

/**
 * The text a visitor can read on the page: text nodes outside script, style and template data, the page title,
 * descriptive meta tags, and the alt, aria-label, placeholder and title attributes. Block element boundaries become
 * newlines and inline tags vanish (so a word split across spans stays one word); `words()` treats every newline as
 * plain whitespace, so a run can cross elements, which errs toward reporting more.
 */
export function visibleText(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(META_COPY)) {
    const c = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[0]);
    if (c) parts.push(c[2] ?? c[3] ?? "");
  }
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, (head) => (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "") + "\n");
  for (const m of body.matchAll(/<[a-z][^>]*>/gi)) {
    for (const a of m[0].matchAll(VISIBLE_ATTRS)) parts.push(a[2] ?? a[3] ?? "");
  }
  const inline = /^(a|abbr|b|bdi|bdo|cite|code|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/i;
  parts.push(body.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_m, tag: string) => (inline.test(tag) ? "" : "\n")));
  return parts.map(decodeEntities).join("\n");
}

/** One normalized word and the 1-based line it starts on in the original text. */
export interface Word { w: string; line: number }

/**
 * Lowercase words of letters and digits. Curly quotes fold to straight ones and apostrophes inside a word are
 * dropped ("don't" and "dont" match), so punctuation, markdown markup and line wrapping never hide a shared run.
 * Newlines and blank lines are not boundaries: runs are word-based only.
 */
export function words(text: string): Word[] {
  const out: Word[] = [];
  const lines = text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ`]/g, "'").split("\n");
  lines.forEach((l, i) => {
    for (const m of l.replace(/(\p{L})'(\p{L})/gu, "$1$2").matchAll(/[\p{L}\p{N}]+/gu)) out.push({ w: m[0], line: i + 1 });
  });
  return out;
}

export function shingles(ws: readonly string[], n = MIN_RUN): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(" "));
  return out;
}

export interface Run { line: number; words: number; phrase: string }

/**
 * Every maximal run of at least `n` consecutive words in `text` whose every n-word window is in `reference`
 * and not in `allowed`. Overlapping matched windows merge into one run.
 */
export function sharedRuns(text: string, reference: ReadonlySet<string>, allowed: ReadonlySet<string> = new Set(), n = MIN_RUN): Run[] {
  const ws = words(text);
  const hit: boolean[] = [];
  for (let i = 0; i + n <= ws.length; i++) {
    const key = ws.slice(i, i + n).map((x) => x.w).join(" ");
    hit[i] = reference.has(key) && !allowed.has(key);
  }
  const runs: Run[] = [];
  let i = 0;
  while (i < hit.length) {
    if (!hit[i]) { i++; continue; }
    let j = i;
    while (j + 1 < hit.length && hit[j + 1]) j++;
    const span = ws.slice(i, j + n);
    runs.push({ line: span[0]!.line, words: span.length, phrase: span.map((x) => x.w).join(" ") });
    i = j + 1;
  }
  return runs;
}

/** Allowlist entry: `phrase  # reason`. Every entry needs a reason; returns the parse problems too. */
export function parseAllowlist(src: string): { phrases: string[]; problems: string[] } {
  const phrases: string[] = [];
  const problems: string[] = [];
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const hash = line.indexOf(" # ");
    const phrase = hash < 0 ? line : line.slice(0, hash).trim();
    const reason = hash < 0 ? "" : line.slice(hash + 3).trim();
    const n = words(phrase).length;
    if (!reason) problems.push(`allowlist line ${i + 1}: add a reason after " # "`);
    else if (n < MIN_RUN) problems.push(`allowlist line ${i + 1}: phrase has ${n} words; entries need at least ${MIN_RUN}`);
    else phrases.push(phrase);
  });
  return { phrases, problems };
}
