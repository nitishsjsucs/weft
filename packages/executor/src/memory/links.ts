// Wiki-links and backlinks (harness 18 item 2). Fact and event bullets link the entities they mention as
// [[entities/people/wrk_0002|Theo Marsh (demo)]], [[entities/states/CA]] or [[entities/notices/ntc_0002]].
// Everything here is a pure, deterministic text transform: the store reads files, these functions rewrite them.

export const WIKI_LINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
export const BACKLINKS_HEADING = "## Backlinks";

export interface LinkContext {
  /** wrk_ id to display name, from the people entity titles. */
  people: Map<string, string>;
  /** Two-letter state codes that have a state entity (or will get one this digest). */
  states: Set<string>;
}

/** Link targets mentioned in a text, deduplicated and sorted. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(WIKI_LINK_RE)) out.add(m[1]!.trim());
  return [...out].sort();
}

/** The memory path a link target resolves to. */
export function linkPath(target: string): string {
  return target.endsWith(".md") ? target : `${target}.md`;
}

/** Replaces wiki-links with their display text (for search snippets and plain rendering). */
export function stripLinks(text: string): string {
  return text.replace(WIKI_LINK_RE, (_m, target: string, label?: string) => label ?? target.split("/").pop()!);
}

/**
 * Links bare entity ids in an event or fact line. Ids already inside a link are left alone. People get their
 * display name as the label; notices link by id; state codes link only in "state XX" or "in XX" phrasing so
 * ordinary capitalised words never turn into links.
 */
export function linkify(line: string, ctx: LinkContext): string {
  // The trailing "(YYYY-MM-DD, src: ...)" or "(src: ...)" names a source record, not a mention: never linked.
  const src = /\s\((?:\d{4}-\d{2}-\d{2}, )?src: [^)]*\)\s*$/.exec(line);
  if (src) return linkify(line.slice(0, src.index), ctx) + line.slice(src.index);
  const parts = line.split(/(\[\[[^\]]*\]\])/);
  return parts.map((p) => {
    if (p.startsWith("[[")) return p;
    let s = p.replace(/\b(wrk_\d{4})\b/g, (id) => ctx.people.has(id) ? `[[entities/people/${id}|${ctx.people.get(id)}]]` : id);
    s = s.replace(/\b(ntc_\d{4})\b/g, (id) => `[[entities/notices/${id}]]`);
    s = s.replace(/\b(state|in|to|from) ([A-Z]{2})\b/g, (m, w: string, code: string) => ctx.states.has(code) ? `${w} [[entities/states/${code}]]` : m);
    return s;
  }).join("");
}

/** Body with its ## Backlinks section replaced (or removed when there are no sources). */
export function withBacklinks(body: string, sources: string[]): string {
  const idx = body.indexOf(`\n${BACKLINKS_HEADING}\n`);
  const base = (idx >= 0 ? body.slice(0, idx) : body).replace(/\s+$/, "");
  if (sources.length === 0) return `${base}\n`;
  const lines = [...new Set(sources)].sort().map((s) => `- [[${s.replace(/\.md$/, "")}]]`);
  return `${base}\n\n${BACKLINKS_HEADING}\n\n${lines.join("\n")}\n`;
}

/** The body without its backlinks section, so links inside backlinks never count as outgoing links. */
export function bodyWithoutBacklinks(body: string): string {
  const idx = body.indexOf(`\n${BACKLINKS_HEADING}\n`);
  return idx >= 0 ? body.slice(0, idx) : body;
}

/**
 * Backlink index: for every target path, the sorted source paths that link to it. Timeline summaries and raw
 * files are sources too, so a person's dossier lists the days that mention them.
 */
export function backlinkIndex(files: { path: string; body: string }[]): Map<string, string[]> {
  const idx = new Map<string, Set<string>>();
  for (const f of files) {
    for (const t of extractLinks(bodyWithoutBacklinks(f.body))) {
      const p = linkPath(t);
      if (p === f.path) continue;
      if (!idx.has(p)) idx.set(p, new Set());
      idx.get(p)!.add(f.path);
    }
  }
  return new Map([...idx.entries()].map(([k, v]) => [k, [...v].sort()]));
}
