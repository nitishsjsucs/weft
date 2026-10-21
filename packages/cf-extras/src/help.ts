// Help search in Cmd+K (design 6.3 and 7.1): AI Search `weft-help` over Weft's own docs in R2 `help/`, capped at
// HOSTED_SETTINGS.helpQueriesPerDay (30, Nitish's 2026-10-20 setting) by a Lobby counter, well under the 1,000 queries
// a month AI Search includes, and behind the `extras.help` kill flag. Results are titles, paths and short snippets of
// Weft's public docs; no visitor data is searched. The corpus itself is defined here and built by
// scripts/cf/help-corpus.ts. Track cf6-extras.
import { HOSTED_SETTINGS } from "../../contracts/src/ext/cf-hosted";
import { R2_PREFIXES, type HelpHit, type HelpSearch, type HelpSearchResult } from "../../contracts/src/ext/cf-extras";
import type { AiSearchLike } from "./bindings";
import { cleanText } from "./bytes";
import { COUNTERS, type DailyCounters } from "./counters";

export const HELP_QUERY_MAX = 200;
export const HELP_MAX_RESULTS = 5;

/** The help corpus: visitor-facing docs only (no internal design, review or eval notes). */
export interface HelpDoc { source: string; key: string; title: string }
export const HELP_CORPUS: readonly HelpDoc[] = [
  { source: "docs/tour.md", key: `${R2_PREFIXES.help}tour.md`, title: "Guided tour" },
  { source: "docs/demo-scenarios.md", key: `${R2_PREFIXES.help}demo-scenarios.md`, title: "Demo scenarios" },
  { source: "docs/simulators.md", key: `${R2_PREFIXES.help}simulators.md`, title: "Simulators" },
  { source: "docs/architecture.md", key: `${R2_PREFIXES.help}architecture.md`, title: "How Weft works" },
  { source: "docs/models.md", key: `${R2_PREFIXES.help}models.md`, title: "Models and spend caps" },
  { source: "docs/api.md", key: `${R2_PREFIXES.help}api.md`, title: "API and MCP" },
  { source: "README.md", key: `${R2_PREFIXES.help}readme.md`, title: "About Weft" },
];
const TITLE_BY_KEY = new Map(HELP_CORPUS.map((d) => [d.key, d.title]));

export interface HelpDeps {
  search: AiSearchLike | null | undefined;
  counters: DailyCounters;
  /** The `extras.help` kill flag. */
  enabled: () => boolean | Promise<boolean>;
  perDay?: number;
}

const snippetOf = (t: string) => {
  const s = cleanText(t, 400).replace(/\s+/g, " ").replace(/^#+\s*/, "");
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
};

export function createHelpSearch(deps: HelpDeps): HelpSearch {
  const cap = deps.perDay ?? HOSTED_SETTINGS.helpQueriesPerDay;
  return {
    async search(query: string): Promise<HelpSearchResult> {
      if (!deps.search || !(await deps.enabled())) return { ok: false, code: "HELP_DISABLED", message: "Help search is switched off" };
      const q = query.replace(/\s+/g, " ").trim().slice(0, HELP_QUERY_MAX);
      if (!q) return { ok: true, hits: [], leftToday: Math.max(0, cap - (await deps.counters.peek(COUNTERS.help))) };
      const t = await deps.counters.take(COUNTERS.help, 1, cap);
      if (!t.ok) return { ok: false, code: "HELP_DAILY_CAP", message: `Help search answers ${cap} questions a day; it is back after 00:00 UTC` };
      let res: Awaited<ReturnType<AiSearchLike["search"]>>;
      try {
        res = await deps.search.search({
          query: q,
          ai_search_options: { retrieval: { max_num_results: HELP_MAX_RESULTS * 2, match_threshold: 0.35, return_on_failure: true }, query_rewrite: { enabled: false }, reranking: { enabled: false } },
        });
      } catch {
        return { ok: false, code: "HELP_DISABLED", message: "Help search is unavailable right now" };
      }
      const byKey = new Map<string, HelpHit>();
      for (const c of res.chunks ?? []) {
        const key = c.item?.key ?? "";
        if (!key.startsWith(R2_PREFIXES.help)) continue;
        const prev = byKey.get(key);
        if (prev && prev.score >= c.score) continue;
        byKey.set(key, { title: TITLE_BY_KEY.get(key) ?? key.slice(R2_PREFIXES.help.length).replace(/\.md$/, ""), path: key, snippet: snippetOf(c.text ?? ""), score: Math.round(c.score * 1000) / 1000 });
      }
      const hits = [...byKey.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, HELP_MAX_RESULTS);
      return { ok: true, hits, leftToday: t.left };
    },
  };
}

// Corpus ----------------------------------------------------------------------------------------------------------

export interface CorpusFile { key: string; title: string; source: string; body: string; bytes: number }

/** Secret-shaped strings a doc must never carry into the public corpus. */
const SECRET_SHAPES = [/sk-[A-Za-z0-9_-]{16,}/, /wk_(live|mcp)_[A-Za-z0-9_]{16,}/, /\b[0-9a-f]{32}\b/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(OPENAI_API_KEY|CF_SETUP_TOKEN|TURNSTILE_SECRET|WEFT_[A-Z_]*(SECRET|TOKEN|KEY))\s*=\s*[A-Za-z0-9_-]{12,}/];

/**
 * Builds the corpus files from the docs' text: a title line, the source path, and the doc with HTML comments and
 * image embeds removed. Throws when a doc is missing or holds a secret-shaped string.
 */
export function buildHelpCorpus(read: (source: string) => string | null, docs: readonly HelpDoc[] = HELP_CORPUS): CorpusFile[] {
  return docs.map((d) => {
    const raw = read(d.source);
    if (raw === null) throw new Error(`help corpus: ${d.source} is missing`);
    const text = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n{3,}/g, "\n\n").trim();
    for (const re of SECRET_SHAPES) if (re.test(text)) throw new Error(`help corpus: ${d.source} holds a secret-shaped string (${re.source})`);
    const body = `# ${d.title}\n\nSource: ${d.source} in the Weft repository.\n\n${text}\n`;
    return { key: d.key, title: d.title, source: d.source, body, bytes: new TextEncoder().encode(body).length };
  });
}
