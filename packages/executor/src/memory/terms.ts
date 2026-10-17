// memory.search query terms (wave 4 FG4, FM4). A multi-word query is matched three ways and ranked in that order:
// the whole phrase (or an entity the whole query names), then lines holding every query word, then lines holding
// any query word. Words are lowercased, question and filler words are dropped, and a long word is cut to a short
// stem so "approves" also finds "approval" and "approved". Deterministic: plain substring checks, no index.

export type MatchTier = "phrase" | "all_terms" | "any_term";
export const TIER_ORDER: Record<MatchTier, number> = { phrase: 0, all_terms: 1, any_term: 2 };

/** Question words, fillers and habit adverbs: they carry no topic, so a line is never matched on them alone. */
const STOP = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "here", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or", "our",
  "ours", "please", "show", "should", "so", "tell", "that", "the", "their", "them", "there", "these", "they", "this",
  "those", "to", "us", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "whose", "why",
  "will", "with", "would", "you", "your", "about", "usually", "always", "often", "normally", "typically", "generally",
  "ever", "never", "still", "just", "really", "also", "get", "got", "know", "find", "look", "anything", "everything",
  "something", "someone", "anyone", "everyone", "today", "now",
]);
const SUFFIXES = ["ing", "ed", "es", "er", "al", "s"];
export const MAX_QUERY_WORDS = 8;

/** A short stem for a long plain word: one common suffix off, keeping at least four letters. Ids stay whole. */
export function stem(word: string): string {
  if (word.length < 6 || /[^a-z]/.test(word)) return word;
  for (const s of SUFFIXES) if (word.endsWith(s) && word.length - s.length >= 4) return word.slice(0, -s.length);
  return word;
}

export interface QueryWord { raw: string; stem: string }

/** The topic words of a query, in order, at most MAX_QUERY_WORDS: ids, codes and paths stay whole, plain words get a stem. */
export function queryWords(query: string): QueryWord[] {
  const raw = query.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  const out: QueryWord[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const isCode = /[_\d/]/.test(w);
    if (!isCode && (w.length < 3 || STOP.has(w))) continue;
    const s = isCode ? w : stem(w);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ raw: w, stem: s });
    if (out.length >= MAX_QUERY_WORDS) break;
  }
  return out;
}

export interface LineMatch { tier: MatchTier; score: number }

/**
 * How one line matches. `phraseTerms` are the query itself and the entity terms the whole query names (an id, a
 * wiki-link target); `wordTerms[i]` holds word i's stem plus the entity terms that word names on its own. Score
 * counts distinct concepts (the phrase once, then each word), so a line is not ranked up for repeating one entity.
 */
export function matchLine(line: string, phraseTerms: string[], wordTerms: string[][]): LineMatch | null {
  const lower = line.toLowerCase();
  const phrase = phraseTerms.some((t) => t && lower.includes(t.toLowerCase()));
  const words = wordTerms.filter((ts) => ts.some((t) => t && lower.includes(t.toLowerCase()))).length;
  if (!phrase && words === 0) return null;
  const tier: MatchTier = phrase ? "phrase" : words === wordTerms.length ? "all_terms" : "any_term";
  return { tier, score: (phrase ? 1 : 0) + words };
}

/** Folder order for a multi-word query: notes and decisions first, raw timeline last. */
export const FOLDER_RANK: Record<string, number> = { knowledge: 0, entities: 1, workstreams: 2, comms: 3, timeline: 4 };
export const folderRank = (path: string) => FOLDER_RANK[path.split("/")[0] ?? ""] ?? 5;

/** One line for the tool summary: how many hits matched each way. */
export function tierSummary(tiers: MatchTier[]): string {
  const n = (t: MatchTier) => tiers.filter((x) => x === t).length;
  const parts = [[n("phrase"), "phrase"], [n("all_terms"), "all words"], [n("any_term"), "some words"]] as const;
  return parts.filter(([c]) => c > 0).map(([c, l]) => `${c} ${l}`).join(", ");
}
