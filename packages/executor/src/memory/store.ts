// The memory repo (SPEC 9.4, harness 9 and 6.7): Markdown with frontmatter in a per-company repository. The
// executor is the only writer. Dates come from the sim clock, so commit SHAs are reproducible. Every path rule, the PII
// and secret refusals, the tainted-run refusal and the Weft-Chain-Head trailers live here, above the MemoryRepo port
// (docs/cloudflare/design.md 4.3): GitRepo is today's git CLI repository, SqlRepo the same git objects in SQL
// (WEFT_MEMORY=sqlite on Node, always on the durable platform). Both give the same commit ids and the same output.
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import type { MemoryFolder, MemoryFrontmatter, MemoryHit, MemoryStore, MemoryWrite, SimClock } from "@weft/contracts";
import { withWriteLock, type Db } from "@weft/db";
import { WEFT_MEMORY_SQLITE, type MemoryRepo } from "../../../contracts/src/ext/cf-memory";
import type { Redactor } from "../vault/redact";
import { COMMITTER, serialGit } from "./git";
import { GitRepo, MemoryPathError } from "./repo-git";
import { SqlRepo } from "./repo-sql";
import { digestKey, planCoarsen } from "./coarsen";
import { renderDossiers, type DigestSources } from "./dossiers";
import { companyDay } from "./time";
import { BACKLINKS_HEADING, backlinkIndex, bodyWithoutBacklinks, extractLinks, linkify, linkPath, withBacklinks, type LinkContext } from "./links";
import { excerptOf, noteKindOf, pickSubjects, recallTerms, renderRecall, CAPS, type AliasEntry, type RecallCandidate } from "./recall";
import { stripLinks } from "./links";
import { TIER_ORDER, folderRank, matchLine, queryWords, type MatchTier } from "./terms";
import { RECALL_BUDGET } from "@weft/contracts";

export const MEMORY_FOLDERS: MemoryFolder[] = ["entities", "comms", "timeline", "workstreams", "knowledge"];
export const SHA_RE = /^[0-9a-f]{40}$/;
export const MAX_QUERY = 200;

export class MemoryError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "PII_IN_MEMORY" | "SECRET_IN_MEMORY" | "MISSING_SOURCE" | "NOT_PERMITTED", message: string) { super(message); }
}

/** Generic path rules for every write: normalized, relative, no `..`, no dot segments, a `.md` file. */
export function normalizeMemoryPath(p: string): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) throw new MemoryError("INVALID_INPUT", "path is required (at most 200 characters)");
  if (p.includes("\0") || p.includes("\\")) throw new MemoryError("INVALID_INPUT", "path has an invalid character");
  if (p.startsWith("/")) throw new MemoryError("INVALID_INPUT", "path must be relative");
  if (p.split("/").some((s) => s === ".." || s.startsWith("."))) throw new MemoryError("INVALID_INPUT", "path may not contain .. or segments starting with .");
  const n = posix.normalize(p);
  if (n.startsWith("..") || n.startsWith("/") || n.split("/").some((s) => s === ".." || s.startsWith("."))) throw new MemoryError("INVALID_INPUT", "path escapes the memory root");
  if (!n.endsWith(".md")) throw new MemoryError("INVALID_INPUT", "path must end in .md");
  return n;
}

export function renderDoc(fm: MemoryFrontmatter, body: string): string {
  const lines = [
    "---", `id: ${JSON.stringify(fm.id)}`, `type: ${JSON.stringify(fm.type)}`, `aliases: ${JSON.stringify(fm.aliases)}`, `links: ${JSON.stringify(fm.links)}`,
    `sources: ${JSON.stringify(fm.sources)}`, `status: ${JSON.stringify(fm.status)}`, `updated: ${JSON.stringify(fm.updated)}`, `tainted_by: ${JSON.stringify(fm.taintedBy)}`, "---",
  ];
  return `${lines.join("\n")}\n${body.endsWith("\n") ? body : body + "\n"}`;
}

export function parseDoc(text: string): { frontmatter: MemoryFrontmatter; body: string } {
  const fm: MemoryFrontmatter = { id: "", type: "fact", aliases: [], links: [], sources: [], status: null, updated: "", taintedBy: null };
  if (!text.startsWith("---\n")) return { frontmatter: fm, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: fm, body: text };
  for (const line of text.slice(4, end).split("\n")) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v: unknown = m[2];
    try { v = JSON.parse(m[2]!); } catch { /* bare string */ }
    const key = m[1] === "tainted_by" ? "taintedBy" : m[1]!;
    (fm as unknown as Record<string, unknown>)[key] = v;
  }
  return { frontmatter: fm, body: text.slice(end + 5) };
}

const COMP = /(salary|compensation|pay rate|base pay|hourly rate|bonus)[^.\n]{0,40}(\$\s?\d|\d+\s?cents|\d{2,3},\d{3})/i;
const BENEFIT = /(enrolled in|elected|election)[^.\n]{0,40}(ppo|hdhp|hsa|401\(k\)|dental|vision)/i;

export interface DigestOutcome {
  /** The digest commit, or null when nothing changed (a repeat for the same periods). */
  commit: string | null;
  key: string; periods: string[]; removed: string[]; written: string[];
  dossiers: { subjectRef: string; path: string; sourceDigest: string }[];
  skipped: { path: string; reason: string }[];
}
export interface MemoryLinks { outgoing: { target: string; path: string; resolved: boolean }[]; backlinks: string[] }

export interface LocalMemory extends MemoryStore {
  root(): string | null;
  /** Seq of the last chain head written to the timeline (for gitLag), read from git at init. */
  chainHeadSeq(): number | null;
  /** Commits several seed files at once (seed only). */
  seedFiles(files: { path: string; text: string }[], message: string): Promise<{ commit: string }>;
  /** rt_memory_digest (harness 18 items 1 to 3): coarsening, dossiers, the one-pager and backlinks in one commit. */
  digest(input: { now: string; sources: DigestSources; companyRef: string; windowDays?: number }): Promise<DigestOutcome>;
  /** Outgoing wiki-links of a file (with whether each resolves) and the files that link to it. */
  links(path: string): Promise<MemoryLinks>;
  /** id and aliases of every entity and knowledge file, for recall and search expansion. */
  aliasIndex(): Promise<AliasEntry[]>;
  /**
   * Recall at run start (harness 9.5): "" when the one-pager does not exist yet (no digest has run), else a
   * <recall> block within RECALL_BUDGET that leads with the one-pager. `searches` is at most maxSearches.
   */
  /** `trustedOnly` (routine runs) leaves out every tainted candidate and the decision notes, so recall never taints
   * a routine run whose autoAllow writes depend on staying untainted (harness 5.3, section 8). */
  recall(input: { request: string; subjectRefs: string[]; trustedOnly?: boolean }): Promise<RecallOutcome>;
  /** Git log of one file, newest first, with each commit's diff for that file (clipped, redacted). */
  history(path: string, limit?: number): Promise<MemoryHistoryEntry[]>;
}
export interface MemoryHistoryEntry { commit: string; date: string; author: string; subject: string; diff: string }
/** A memory.search hit with how it matched the query (terms.ts): the phrase, every word, or some words. */
export type SearchHit = MemoryHit & { match: MatchTier };
export interface RecallOutcome { block: string; items: { path: string; kind: string; taintedBy: string | null }[]; searches: string[] }

/** Extra fixed-string terms for a query that names an entity: its id and its wiki-link target (at most 5 entities). */
export function expandQuery(query: string, index: AliasEntry[]): string[] {
  const q = query.toLowerCase().replace(/^\[\[|\]\]$/g, "");
  const out: string[] = [];
  for (const e of index) {
    const target = e.path.replace(/\.md$/, "");
    const words = e.aliases.flatMap((a) => a.toLowerCase().split(/\s+/));
    const hit = e.id.toLowerCase() === q || target.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q) || (q.length >= 4 && !q.includes(" ") && words.includes(q));
    if (!hit) continue;
    if (ENTITY_ID_RE.test(e.id)) out.push(e.id);
    out.push(`[[${target}`);
    for (const a of e.aliases) if (a.length >= 4) out.push(a);
    if (out.length >= 15) break;
  }
  return [...new Set(out)];
}

/** Money amounts become [amount]: memory holds no pay data (harness 9.2). */
export const maskAmounts = (s: string) => s.replace(/\$\s?\d[\d,]*(\.\d+)?/g, "[amount]");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ENTITY_ID_RE = /^(wrk|ntc|txa|bpl|cmp)_[A-Za-z0-9_]+$/;

/** What the store needs from a repository beyond the port: the date of any commit (both repos implement it). */
type StoreRepo = MemoryRepo & { commitDate?(sha: string): Promise<string> };

export interface CreateMemoryStoreOptions {
  dataDir: string; clock: SimClock; redactor: Redactor; defaultCompanyId: () => Promise<string | null>;
  initialFiles?: (companyId: string, now: string) => Promise<{ path: string; text: string }[]>;
  /** The repository for a company's memory (the platform's memoryRepo). Absent: see `db` and WEFT_MEMORY. */
  repo?: (root: string, companyId: string) => MemoryRepo;
  /** With WEFT_MEMORY=sqlite and no `repo`, the SQL repository over this Db; otherwise the git repository. */
  db?: Db;
  env?: Readonly<Record<string, string | undefined>>;
}

/** The default repository choice (design 4.1): WEFT_MEMORY=sqlite and a Db give SqlRepo, anything else GitRepo. */
export function memoryRepoFactory(opts: Pick<CreateMemoryStoreOptions, "repo" | "db" | "env">): (root: string, companyId: string) => MemoryRepo {
  if (opts.repo) return opts.repo;
  const env = opts.env ?? process.env;
  if (env.WEFT_MEMORY === WEFT_MEMORY_SQLITE && opts.db) {
    const db = opts.db;
    return () => new SqlRepo(db);
  }
  return (root) => new GitRepo(root);
}

const NOTHING_TO_COMMIT = "nothing to commit: the memory files are unchanged";

export function createMemoryStore(opts: CreateMemoryStoreOptions): LocalMemory {
  const makeRepo = memoryRepoFactory(opts);
  const repos = new Map<string, StoreRepo>();
  let root: string | null = null;
  let repo: StoreRepo | null = null;
  let headSeq: number | null = null;
  let linkCache: LinkContext | null = null;
  let aliasCache: { head: string; entries: AliasEntry[] } | null = null;
  const repoFor = (companyId: string): StoreRepo => {
    let r = repos.get(companyId);
    if (!r) { r = makeRepo(join(opts.dataDir, "companies", companyId, "memory"), companyId); repos.set(companyId, r); }
    return r;
  };
  const repoKind = makeRepo(join(opts.dataDir, "companies", "_", "memory"), "_").kind;
  /** One operation at a time: the git queue for the git repo; the world's write lock for the SQL repo, which a
   * command transaction already holds when it writes a note (re-entrant), so the two can never wait on each other. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => (repoKind === "sql" ? withWriteLock(fn) : serialGit(fn));
  const titleOf = (body: string) => /^# (.+)$/m.exec(body)?.[1]?.trim() ?? null;
  /** Path errors from the repository surface as the store's own INVALID_INPUT. */
  const guard = async <T>(p: Promise<T>): Promise<T> => {
    try { return await p; } catch (e) { if (e instanceof MemoryPathError) throw new MemoryError("INVALID_INPUT", e.message); throw e; }
  };
  /** People names and state codes from the tree, for linking event bullets. Rebuilt after any write. */
  const linkContext = async (r: StoreRepo): Promise<LinkContext> => {
    if (linkCache) return linkCache;
    const people = new Map<string, string>();
    const states = new Set<string>();
    const direct = (all: string[], dir: string) => all.filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    const all = await r.list();
    for (const f of direct(all, "entities/people")) {
      const t = titleOf(parseDoc((await r.read(`entities/people/${f}`)) ?? "").body);
      if (t) people.set(f.slice(0, -3), t.replace(/[[\]|]/g, ""));
    }
    for (const f of direct(all, "entities/states")) states.add(f.slice(0, -3));
    linkCache = { people, states };
    return linkCache;
  };
  const ensureRoot = async (): Promise<StoreRepo> => {
    if (root && repo) return repo;
    const cmp = await opts.defaultCompanyId();
    const r = cmp ? repoFor(cmp) : null;
    if (!r || !(await r.exists())) throw new MemoryError("NOT_PERMITTED", "the memory repo is not initialised");
    // A process that did not seed (the API after a restart) finds the repo here: read its chain head too, or
    // verifyChain would report a git lag of the whole log once anything touches memory.
    headSeq = await readHeadSeq(r);
    root = join(opts.dataDir, "companies", cmp!, "memory");
    repo = r;
    return r;
  };
  const checkContent = (text: string) => {
    if (opts.redactor.hasSecret(text)) throw new MemoryError("SECRET_IN_MEMORY", "memory may not hold a secret");
    if (opts.redactor.hasPattern(text)) throw new MemoryError("PII_IN_MEMORY", "memory may not hold SSNs, EINs, routing or account numbers");
    if (COMP.test(text)) throw new MemoryError("PII_IN_MEMORY", "memory may not hold compensation amounts");
    if (BENEFIT.test(text)) throw new MemoryError("PII_IN_MEMORY", "memory may not hold benefit election details");
  };
  const readHeadSeq = async (r: StoreRepo) => {
    const out = (await r.log({ n: 1, grep: "Weft-Chain-Head:" }).catch(() => []))[0]?.body ?? "";
    const m = /Weft-Chain-Head: (\d+) [0-9a-f]+/.exec(out);
    return m ? Number(m[1]) : null;
  };
  const commitDate = async (r: StoreRepo, sha: string) => {
    if (r.commitDate) return r.commitDate(sha);
    const entry = (await r.log({ n: 1_000_000 })).find((e) => e.commit === sha);
    return entry?.date ?? "";
  };

  return {
    root: () => root,
    chainHeadSeq: () => headSeq,
    async init(companyId) {
      return serial(async () => {
        const r = repoFor(companyId);
        root = join(opts.dataDir, "companies", companyId, "memory");
        repo = r;
        linkCache = null; aliasCache = null;
        if (await r.exists()) { headSeq = await readHeadSeq(r); return; }
        headSeq = null;   // a fresh repo (first seed or after a reset) has no chain head yet
        const files = new Map<string, string>();
        files.set("README.md", "# Weft memory (demo)\n\nMarkdown memory for a fictional company. Facts live in entities/ and knowledge/, events in timeline/ and comms/. Written only by the Weft executor.\n");
        for (const f of MEMORY_FOLDERS) files.set(`${f}/.keep.md`, "");
        for (const f of (await opts.initialFiles?.(companyId, opts.clock.now())) ?? []) {
          const rel = normalizeMemoryPath(f.path);
          checkContent(f.text);
          files.set(rel, f.text);
        }
        await guard(r.init([...files].map(([path, text]) => ({ path, text })), { message: "memory: initialise", date: opts.clock.now() }));
      });
    },
    async head() { const r = await ensureRoot(); return serial(() => r.head()); },
    async read(path, at) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(path);
      if (at !== undefined && at !== null) {
        if (!SHA_RE.test(at)) throw new MemoryError("INVALID_INPUT", "at must be a 40-character hex commit");
        const text = await serial(() => r.read(rel, at)).catch(() => null);
        return text === null ? null : parseDoc(text);
      }
      const text = await guard(r.read(rel));
      return text === null ? null : parseDoc(text);
    },
    async search(q) {
      const r = await ensureRoot();
      if (typeof q.query !== "string" || q.query.trim().length === 0 || q.query.length > MAX_QUERY) throw new MemoryError("INVALID_INPUT", `query is 1 to ${MAX_QUERY} characters`);
      if (q.at !== null && !SHA_RE.test(q.at)) throw new MemoryError("INVALID_INPUT", "at must be a 40-character hex commit");
      const folders = q.folders ?? MEMORY_FOLDERS;
      for (const f of folders) if (!MEMORY_FOLDERS.includes(f)) throw new MemoryError("INVALID_INPUT", `unknown folder ${String(f)}`);
      const limit = Math.max(1, Math.min(50, q.limit || 10));
      // Alias and wiki-link expansion (harness 18): a query naming an entity by alias or id also matches lines that
      // mention its id or link it, so "Theo Marsh" finds [[entities/people/wrk_0002|...]] and bare wrk_0002.
      // Wave 4 (FM4): a multi-word query is also split into its topic words (terms.ts), so a keyword question finds
      // lines that hold all of them, then lines that hold some; phrase hits still lead.
      const query = q.query.trim();
      const index = q.at ? [] : await this.aliasIndex();
      const phraseTerms = [query, ...expandQuery(query, index)];
      const words = queryWords(query);
      const wordTerms = words.length > 1 || (words[0] && words[0].raw !== query.toLowerCase())
        ? words.map((w) => [w.stem, ...(w.raw.length >= 4 ? expandQuery(w.raw, index) : [])]) : [];
      const terms = [...new Map([...phraseTerms, ...wordTerms.flat()].map((t) => [t.toLowerCase(), t])).values()];
      const multi = terms.length > 1;
      return serial(async () => {
        const commit = q.at ?? (await r.head());
        const lines = await r.grep({ terms, folders, ...(q.at ? { at: q.at } : {}), ignoreCase: true });
        const date = await commitDate(r, commit);
        const all: (SearchHit & { score: number; rank: number })[] = [];
        for (const l of lines) {
          const hit = matchLine(l.text, phraseTerms, wordTerms);
          // Frontmatter lines (id, aliases, links) count for a phrase or an entity, never for a loose word match.
          if (!hit || (hit.tier !== "phrase" && (l.text === "---" || /^[a-z_]+: /.test(l.text)))) continue;
          all.push({ path: l.path, line: l.line, snippet: opts.redactor.redact(l.text.slice(0, 240)), commit, date, cite: `${l.path}#L${l.line}`, taintedBy: null, match: hit.tier, score: hit.score, rank: words.length > 1 ? folderRank(l.path) : 0 });
        }
        // One term keeps git grep order (wave 1). Otherwise: phrase hits, then all words, then some words; within a
        // tier, more matched concepts first; for a multi-word query, notes before entities before the timeline.
        const ranked = multi
          ? all.map((h, i) => ({ h, i })).sort((a, b) => TIER_ORDER[a.h.match] - TIER_ORDER[b.h.match] || b.h.score - a.h.score || a.h.rank - b.h.rank || a.i - b.i).map((x) => x.h)
          : all;
        const hits: SearchHit[] = ranked.slice(0, limit).map(({ score: _s, rank: _r, ...h }) => h);
        for (const h of hits) {
          const text = (await r.read(h.path, commit).catch(() => null)) ?? "";
          h.taintedBy = parseDoc(text).frontmatter.taintedBy ?? null;
        }
        return hits;
      });
    },
    async write(w: MemoryWrite) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(w.path);
      const text = renderDoc(w.frontmatter, w.body);
      checkContent(text);
      if ((rel.startsWith("entities/") || rel.startsWith("knowledge/facts/")) && w.body.split("\n").some((l) => /^\s*- /.test(l) && !/\(\d{4}-\d{2}-\d{2}, src: [^)]+\)/.test(l))) {
        throw new MemoryError("MISSING_SOURCE", "every fact bullet needs a date and a source: (YYYY-MM-DD, src: ...)");
      }
      if (rel.startsWith("knowledge/procedures/") && w.frontmatter.sources.length === 0) throw new MemoryError("MISSING_SOURCE", "a procedure needs at least one source");
      return serial(async () => {
        const commit = await guard(r.commit({ changes: [{ path: rel, text }], message: opts.redactor.redact(w.message).slice(0, 200), author: w.author, date: opts.clock.now() }));
        if (!commit) throw new Error(NOTHING_TO_COMMIT);
        return { commit };
      });
    },
    async appendTimeline(b) {
      const r = await ensureRoot();
      const day = b.at.slice(0, 10);
      const rel = `timeline/raw/${day}.md`;
      return serial(async () => {
        // Memory never holds pay amounts (harness 9.2): money in an action summary is masked on the way in.
        const line = opts.redactor.redact(`- ${b.at} [i${b.importance}] ${b.command}: ${maskAmounts(linkify(b.text.replace(/\s+/g, " "), await linkContext(r)))} (src: ${b.source})`);
        const existing = await guard(r.read(rel));
        const before = existing ?? renderDoc({ id: `timeline-${day}`, type: "timeline_raw", aliases: [], links: [], sources: [], status: null, updated: day, taintedBy: null }, `# ${day}\n`);
        const commit = await guard(r.commit({ changes: [{ path: rel, text: `${before}${line}\n` }], message: `timeline: ${b.command}\n\nWeft-Chain-Head: ${b.chainHead.seq} ${b.chainHead.hash}`, date: b.at }));
        if (!commit) throw new Error(NOTHING_TO_COMMIT);
        headSeq = b.chainHead.seq;
        return { commit };
      });
    },
    async remove() { throw new MemoryError("NOT_PERMITTED", "memory.forget is P1 (human only)"); },
    async tree(prefix) {
      const r = await ensureRoot();
      const all = await serial(() => r.list());
      return all.filter((p) => p && !p.endsWith(".keep.md") && (!prefix || p.startsWith(prefix))).sort();
    },
    async seedFiles(files, message) {
      const r = await ensureRoot();
      return serial(async () => {
        const changes: { path: string; text: string }[] = [];
        for (const f of files) {
          const rel = normalizeMemoryPath(f.path);
          checkContent(f.text);
          changes.push({ path: rel, text: f.text });
        }
        const commit = await guard(r.commit({ changes, message, date: opts.clock.now() }));
        linkCache = null; aliasCache = null;
        if (!commit) throw new Error(NOTHING_TO_COMMIT);
        return { commit };
      });
    },
    async digest(input) {
      const r = await ensureRoot();
      return serial(() => runDigest(r, input));
    },
    async links(path) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(path);
      const text = await guard(r.read(rel));
      if (text === null) throw new MemoryError("INVALID_INPUT", `No memory file ${rel}`);
      const doc = parseDoc(text);
      const tracked = new Set(await r.list());
      const outgoing = extractLinks(bodyWithoutBacklinks(doc.body)).map((target) => ({ target, path: linkPath(target), resolved: tracked.has(posix.normalize(linkPath(target))) }));
      const target = `[[${rel.replace(/\.md$/, "")}`;
      const hits = await serial(() => r.grep({ terms: [target], folders: MEMORY_FOLDERS, filesOnly: true }));
      const backlinks: string[] = [];
      for (const p of hits.map((h) => h.path).filter((p) => p && p !== rel)) {
        const d = parseDoc((await r.read(p)) ?? "");
        if (extractLinks(bodyWithoutBacklinks(d.body)).some((t) => linkPath(t) === rel)) backlinks.push(p);
      }
      return { outgoing, backlinks: backlinks.sort() };
    },
    async recall(input) {
      // Wave 4 (FM4): the one-pager leads when the digest has written it; without it, recall still builds a block
      // from the subject dossiers, the preference lines and the term hits, so a world that never ran the digest
      // (a fresh install, an eval trial) still sees the notes its request names.
      const onePager = await this.read(RECALL_BUDGET.onePager);
      const index = await this.aliasIndex();
      const subjects = pickSubjects(input.request, input.subjectRefs, index).slice(0, RECALL_BUDGET.maxSearches - 1);
      const terms = recallTerms(input.request, subjects, RECALL_BUDGET.maxSearches);
      const untrusted = (path: string, fm: string | null) => fm ?? (path.startsWith("knowledge/decisions/") ? `memory:${path}` : null);
      const cands: RecallCandidate[] = onePager ? [{ kind: "one_pager", path: RECALL_BUDGET.onePager, title: "Company one-pager", excerpt: excerptOf(onePager.body, CAPS.onePager), score: 100, asOf: onePager.frontmatter.updated || "", taintedBy: untrusted(RECALL_BUDGET.onePager, onePager.frontmatter.taintedBy) }] : [];
      const ids = new Map(index.map((e) => [e.path, e.id]));
      for (const [i, sub] of subjects.entries()) {
        const d = await this.read(sub.path);
        if (d) cands.push({ kind: "dossier", path: sub.path, title: /^# (.+)$/m.exec(d.body)?.[1] ?? sub.path, excerpt: excerptOf(d.body, CAPS.dossier), score: 50 - i, asOf: d.frontmatter.updated || "", taintedBy: untrusted(sub.path, d.frontmatter.taintedBy) });
      }
      // Learned preferences: the approvals lines whose proposal kind shares a word with the request.
      const prefs = await this.read("knowledge/preferences/approvals.md");
      if (prefs) {
        const words = new Set(input.request.toLowerCase().match(/[a-z]{3,}/g) ?? []);
        const relevant = prefs.body.split("\n").filter((l) => /^- [A-Za-z0-9_.:-]+: approved/.test(l) && l.slice(2, l.indexOf(":")).toLowerCase().split(/[._]/).some((w) => w.length >= 3 && words.has(w)));
        if (relevant.length) cands.push({ kind: "dossier", path: "knowledge/preferences/approvals.md", title: "Approval preferences", excerpt: relevant.join(" / "), score: 10, asOf: prefs.frontmatter.updated || "", taintedBy: untrusted("knowledge/preferences/approvals.md", prefs.frontmatter.taintedBy) });
      }
      const included = new Set(cands.map((c) => c.path));
      const seenText = new Set<string>();
      for (const [ti, term] of terms.entries()) {
        const hits = await this.search({ query: term, folders: null, at: null, limit: 20 }).catch(() => [] as MemoryHit[]);
        for (const [hi, h] of hits.entries()) {
          // One hit per file, never frontmatter or a bare backlink bullet, and never the same event twice (the
          // hourly, daily and weekly summaries repeat important events).
          if (included.has(h.path) || h.snippet.startsWith("---") || /^[a-z_]+: /.test(h.snippet) || /^- \[\[[^\]]+\]\]$/.test(h.snippet.trim())) continue;
          const score = (RECALL_BUDGET.maxSearches - ti) * 10 - hi;
          // Wave 4 round 2 (R2): a procedure or decision note recalls as the note (its body excerpt, id and path),
          // since the matched line is often its heading and the steps below it are what the run needs. The path keeps
          // the cite of the matched line, as every hit does; a citation field takes the path without it.
          const noteKind = noteKindOf(h.path);
          const note = noteKind ? await this.read(h.path).catch(() => null) : null;
          if (noteKind && note) {
            const body = maskAmounts(stripLinks(opts.redactor.redact(excerptOf(note.body, CAPS.note)))).trim();
            if (!body || seenText.has(body)) continue;
            included.add(h.path);
            seenText.add(body);
            cands.push({ kind: noteKind, path: h.cite, title: titleOf(note.body) ?? h.path, excerpt: body, score, asOf: note.frontmatter.updated || h.date, taintedBy: untrusted(h.path, note.frontmatter.taintedBy ?? h.taintedBy), noteId: note.frontmatter.id || ids.get(h.path) || null });
            continue;
          }
          const excerpt = maskAmounts(stripLinks(h.snippet).replace(/ \(ref: [^)]+\)$/, "")).trim();
          if (!excerpt || seenText.has(excerpt)) continue;
          included.add(h.path);
          seenText.add(excerpt);
          cands.push({ kind: "hit", path: h.cite, title: h.path, excerpt: excerpt.length > CAPS.hit * 4 ? `${excerpt.slice(0, CAPS.hit * 4 - 12)} [clipped]` : excerpt, score, asOf: h.date, taintedBy: untrusted(h.path, h.taintedBy), noteId: ids.get(h.path) ?? null });
        }
      }
      const { block, kept } = renderRecall(input.trustedOnly ? cands.filter((c) => !c.taintedBy) : cands, RECALL_BUDGET.maxTokens);
      return { block, items: kept.map((c) => ({ path: c.path, kind: c.kind, taintedBy: c.taintedBy })), searches: terms };
    },
    async history(path, limit = 20) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(path);
      const n = Math.max(1, Math.min(50, Math.floor(limit)));
      return serial(async () => {
        const entries = await r.log({ n, path: rel, patch: true }).catch(() => []);
        return entries.map((e) => {
          const diff = (e.diff ?? "").trim();
          return { commit: e.commit, date: e.date, author: e.author, subject: opts.redactor.redact(e.subject ?? ""), diff: opts.redactor.redact(diff.length > 8000 ? `${diff.slice(0, 8000)}\n[diff clipped]` : diff) };
        });
      });
    },
    async aliasIndex() {
      const r = await ensureRoot();
      return serial(async () => {
        const h = await r.head();
        if (aliasCache && aliasCache.head === h) return aliasCache.entries;
        const files = (await r.list()).filter((p) => (p.startsWith("entities/") || p.startsWith("knowledge/")) && p.endsWith(".md") && !p.endsWith(".keep.md"));
        const entries: AliasEntry[] = [];
        for (const p of files.sort()) {
          const text = await r.read(p);
          if (text === null) continue;
          const d = parseDoc(text);
          const t = titleOf(d.body);
          const aliases = [...new Set([...(d.frontmatter.aliases ?? []), ...(t && p.startsWith("entities/people/") ? [t.replace(/ \(demo\)$/, "")] : [])])];
          entries.push({ path: p, id: d.frontmatter.id || p.replace(/\.md$/, ""), aliases });
        }
        aliasCache = { head: h, entries };
        return entries;
      });
    },
  };

  /** One digest commit: coarsened timeline, refreshed dossiers and one-pager, then the backlinks pass. */
  async function runDigest(r: StoreRepo, input: { now: string; sources: DigestSources; companyRef: string; windowDays?: number }): Promise<DigestOutcome> {
    const before = await r.head();
    const tracked = (await r.list()).filter((p) => p.endsWith(".md") && !p.endsWith(".keep.md"));
    const texts = new Map<string, string>();
    for (const p of tracked) { const t = await r.read(p); if (t !== null) texts.set(p, t); }
    const readText = (p: string) => texts.get(p) ?? null;
    const raw = tracked.filter((p) => /^timeline\/raw\/\d{4}-\d{2}-\d{2}\.md$/.test(p)).map((p) => ({ path: p, text: readText(p) ?? "" }));
    const daily = tracked.filter((p) => p.startsWith("timeline/daily/")).map((p) => ({ path: p, body: parseDoc(readText(p) ?? "").body }));
    const plan = planCoarsen({ now: input.now, raw, daily, windowDays: input.windowDays, rawCommit: before });
    const day = companyDay(input.now);

    // Dossiers: people mentioned in the raw events still in the tree (or without a dossier yet), every state,
    // agency and notice row passed in, and the one-pager. Links use every known person and state.
    const mentioned = new Set(raw.flatMap((f) => [...f.text.matchAll(/\bwrk_\d{4}\b/g)].map((m) => m[0])));
    const sources: DigestSources = { ...input.sources, people: input.sources.people.filter((p) => mentioned.has(p.id) || !tracked.includes(`entities/people/${p.id}.md`)) };
    const ctx = await linkContext(r);
    const lctx: LinkContext = { people: new Map([...ctx.people, ...input.sources.people.map((p) => [p.id, `${p.name} (demo)`] as [string, string])]), states: new Set([...ctx.states, ...input.sources.states.map((x) => x.code)]) };
    const docs = renderDossiers(sources, day, input.companyRef);
    const skipped: DigestOutcome["skipped"] = [];
    const next = new Map<string, string>();   // path -> full text
    for (const d of docs) {
      const prior = readText(d.path);
      const priorFm = prior ? parseDoc(prior).frontmatter : null;
      const body = d.body.split("\n").map((l) => (l.startsWith("- ") ? linkify(l, lctx) : l)).join("\n");
      const fm = { ...d.frontmatter, aliases: [...new Set([...(priorFm?.aliases ?? []), ...d.frontmatter.aliases])].sort(), links: extractLinks(body) };
      const text = renderDoc(fm, body);
      try { checkContent(text); } catch (e) { skipped.push({ path: d.path, reason: e instanceof MemoryError ? e.code : "INVALID_INPUT" }); continue; }
      next.set(d.path, text);
    }
    for (const w of plan.writes) next.set(w.path, maskAmounts(opts.redactor.redact(renderDoc(w.frontmatter, w.body))));
    const removed = new Set(plan.removes);

    // Backlinks pass over the tree as it will be after this digest.
    const view = new Map<string, string>();
    for (const p of tracked) if (!removed.has(p)) { const t = readText(p); if (t !== null) view.set(p, t); }
    for (const [p, t] of next) view.set(p, t);
    // Untrusted files (tainted_by, human decision notes) never feed a dossier, not even as a backlink path.
    const trustedSource = (p: string, t: string) => !p.startsWith("knowledge/decisions/") && !parseDoc(t).frontmatter.taintedBy;
    const idx = backlinkIndex([...view.entries()].filter(([path, text]) => trustedSource(path, text)).map(([path, text]) => ({ path, body: parseDoc(text).body })));
    for (const [p, t] of view) {
      if (!(p.startsWith("entities/") || p.startsWith("knowledge/")) || p.startsWith("knowledge/decisions/") || !t.startsWith("---\n")) continue;
      const d = parseDoc(t);
      const sources = idx.get(p) ?? [];
      // Files nobody links to (and without a section to clear) stay byte-identical unless this digest wrote them.
      if (sources.length === 0 && !d.body.includes(`\n${BACKLINKS_HEADING}\n`) && !next.has(p)) continue;
      const body = withBacklinks(d.body, sources);
      // Keep non-path links (a decision's proposal id, for example) and add the wiki-link targets in the body.
      const links = [...new Set([...(d.frontmatter.links ?? []).filter((l) => !l.includes("/")), ...extractLinks(bodyWithoutBacklinks(body))])].sort();
      const text = renderDoc({ ...d.frontmatter, links }, body);
      if (text !== t) next.set(p, text);
    }

    const written: string[] = [];
    const changes: { path: string; text: string | null }[] = [];
    for (const [p, text] of [...next.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rel = normalizeMemoryPath(p);
      if (readText(rel) === text) continue;
      changes.push({ path: rel, text });
      written.push(rel);
    }
    for (const p of plan.removes) changes.push({ path: normalizeMemoryPath(p), text: null });
    const key = digestKey(plan.periods);
    const dossiers = docs.filter((d) => d.subjectRef && ENTITY_ID_RE.test(d.subjectRef) && next.has(d.path)).map((d) => ({ subjectRef: d.subjectRef!, path: d.path, sourceDigest: sha(next.get(d.path)!) }));
    const periods = plan.periods.map((p) => `${p.level}:${p.key}`);
    linkCache = null; aliasCache = null;
    const named = plan.periods.length ? plan.periods.filter((p) => p.level !== "hourly").map((p) => `${p.level} ${p.key}`).join(", ") || `hourly through ${plan.periods.at(-1)!.key}` : `dossiers as of ${day}`;
    const commit = changes.length ? await guard(r.commit({ changes, message: `memory digest: ${named}\n\nWeft-Digest: ${key || `dossiers:${day}`}`, date: input.now })) : null;
    if (!commit) return { commit: null, key, periods, removed: [], written: [], dossiers, skipped };
    return { commit, key, periods, removed: plan.removes, written, dossiers, skipped };
  }
}

export { COMMITTER };
