// The memory repo (SPEC 9.4, harness 9 and 6.7): Markdown with frontmatter in a per-company git repo. The executor
// is the only git caller. Dates come from the sim clock, so commit SHAs are reproducible.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import type { MemoryFolder, MemoryFrontmatter, MemoryHit, MemoryStore, MemoryWrite, SimClock } from "@weft/contracts";
import type { Redactor } from "../vault/redact";
import { COMMITTER, git, serialGit } from "./git";
import { digestKey, planCoarsen } from "./coarsen";
import { renderDossiers, type DigestSources } from "./dossiers";
import { companyDay } from "./time";
import { BACKLINKS_HEADING, backlinkIndex, bodyWithoutBacklinks, extractLinks, linkify, linkPath, withBacklinks, type LinkContext } from "./links";
import { excerptOf, pickSubjects, recallTerms, renderRecall, CAPS, type AliasEntry, type RecallCandidate } from "./recall";
import { stripLinks } from "./links";
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

export function createMemoryStore(opts: { dataDir: string; clock: SimClock; redactor: Redactor; defaultCompanyId: () => Promise<string | null>;
  initialFiles?: (companyId: string, now: string) => Promise<{ path: string; text: string }[]> }): LocalMemory {
  let root: string | null = null;
  let headSeq: number | null = null;
  let linkCache: LinkContext | null = null;
  let aliasCache: { head: string; entries: AliasEntry[] } | null = null;
  const titleOf = (body: string) => /^# (.+)$/m.exec(body)?.[1]?.trim() ?? null;
  /** People names and state codes from the working tree, for linking event bullets. Rebuilt after any write. */
  const linkContext = (r: string): LinkContext => {
    if (linkCache) return linkCache;
    const people = new Map<string, string>();
    const states = new Set<string>();
    const list = (dir: string) => { try { return readdirSync(join(r, ...dir.split("/"))).filter((f) => f.endsWith(".md") && !f.startsWith(".")); } catch { return []; } };
    for (const f of list("entities/people")) {
      const t = titleOf(parseDoc(readFileSync(join(r, "entities", "people", f), "utf8")).body);
      if (t) people.set(f.slice(0, -3), t.replace(/[[\]|]/g, ""));
    }
    for (const f of list("entities/states")) states.add(f.slice(0, -3));
    linkCache = { people, states };
    return linkCache;
  };
  const ensureRoot = async (): Promise<string> => {
    if (root) return root;
    const cmp = await opts.defaultCompanyId();
    const r = cmp ? join(opts.dataDir, "companies", cmp, "memory") : null;
    if (!r || !existsSync(join(r, ".git"))) throw new MemoryError("NOT_PERMITTED", "the memory repo is not initialised");
    root = r;
    return r;
  };
  const resolveInside = (r: string, rel: string): string => {
    const abs = join(r, ...rel.split("/"));
    let dir = dirname(abs);
    while (!existsSync(dir)) dir = dirname(dir);
    const real = realpathSync(dir);
    const realRoot = realpathSync(r);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new MemoryError("INVALID_INPUT", "path resolves outside the memory root");
    if (real === join(realRoot, ".git") || real.startsWith(join(realRoot, ".git") + sep)) throw new MemoryError("INVALID_INPUT", "path resolves inside .git");
    if (existsSync(abs)) {
      const rf = realpathSync(abs);
      if (!rf.startsWith(realRoot + sep) || rf.startsWith(join(realRoot, ".git") + sep)) throw new MemoryError("INVALID_INPUT", "path resolves outside the memory root");
    }
    return abs;
  };
  const checkContent = (text: string) => {
    if (opts.redactor.hasSecret(text)) throw new MemoryError("SECRET_IN_MEMORY", "memory may not hold a secret");
    if (opts.redactor.hasPattern(text)) throw new MemoryError("PII_IN_MEMORY", "memory may not hold SSNs, EINs, routing or account numbers");
    if (COMP.test(text)) throw new MemoryError("PII_IN_MEMORY", "memory may not hold compensation amounts");
    if (BENEFIT.test(text)) throw new MemoryError("PII_IN_MEMORY", "memory may not hold benefit election details");
  };
  const head = async (r: string) => (await git(r, ["rev-parse", "HEAD"])).trim();
  const readHeadSeq = async (r: string) => {
    const out = await git(r, ["log", "-n", "1", "--grep", "Weft-Chain-Head:", "--format=%B"]).catch(() => "");
    const m = /Weft-Chain-Head: (\d+) [0-9a-f]+/.exec(out);
    return m ? Number(m[1]) : null;
  };

  return {
    root: () => root,
    chainHeadSeq: () => headSeq,
    async init(companyId) {
      return serialGit(async () => {
        const r = join(opts.dataDir, "companies", companyId, "memory");
        root = r;
        linkCache = null; aliasCache = null;
        if (existsSync(join(r, ".git"))) { headSeq = await readHeadSeq(r); return; }
        headSeq = null;   // a fresh repo (first seed or after a reset) has no chain head yet
        mkdirSync(r, { recursive: true });
        for (const f of MEMORY_FOLDERS) mkdirSync(join(r, f), { recursive: true });
        writeFileSync(join(r, "README.md"), "# Weft memory (demo)\n\nMarkdown memory for a fictional company. Facts live in entities/ and knowledge/, events in timeline/ and comms/. Written only by the Weft executor.\n");
        for (const f of MEMORY_FOLDERS) writeFileSync(join(r, f, ".keep.md"), "");
        for (const f of (await opts.initialFiles?.(companyId, opts.clock.now())) ?? []) {
          const rel = normalizeMemoryPath(f.path);
          checkContent(f.text);
          mkdirSync(dirname(join(r, rel)), { recursive: true });
          writeFileSync(join(r, rel), f.text);
        }
        await git(r, ["init", "-q"]);
        await git(r, ["add", "-A"]);
        await git(r, ["commit", "-q", "-m", "memory: initialise"], { date: opts.clock.now() });
      });
    },
    async head() { const r = await ensureRoot(); return serialGit(() => head(r)); },
    async read(path, at) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(path);
      if (at !== undefined && at !== null) {
        if (!SHA_RE.test(at)) throw new MemoryError("INVALID_INPUT", "at must be a 40-character hex commit");
        const text = await serialGit(() => git(r, ["show", `${at}:${rel}`])).catch(() => null);
        return text === null ? null : parseDoc(text);
      }
      const abs = resolveInside(r, rel);
      if (!existsSync(abs)) return null;
      return parseDoc(readFileSync(abs, "utf8"));
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
      const query = q.query.trim();
      const expanded = q.at ? [] : expandQuery(query, await this.aliasIndex());
      const terms = [query, ...expanded.filter((t) => t.toLowerCase() !== query.toLowerCase())];
      return serialGit(async () => {
        const commit = q.at ?? (await head(r));
        const args = ["grep", "-n", "-i", "--fixed-strings", ...terms.flatMap((t) => ["-e", t]), ...(q.at ? [q.at] : []), "--", ...folders];
        const out = await git(r, args).catch((e: { exitCode?: number | null }) => { if (e.exitCode === 1) return ""; throw e; });
        const date = (await git(r, ["log", "-1", "--format=%cI", commit])).trim();
        const all: (MemoryHit & { score: number })[] = [];
        for (const line of out.split("\n")) {
          if (!line) continue;
          const rest = q.at && line.startsWith(`${q.at}:`) ? line.slice(q.at.length + 1) : line;
          const m = /^([^:]+):(\d+):(.*)$/.exec(rest);
          if (!m) continue;
          const lower = m[3]!.toLowerCase();
          const score = terms.filter((t) => lower.includes(t.toLowerCase())).length;
          all.push({ path: m[1]!, line: Number(m[2]), snippet: opts.redactor.redact(m[3]!.slice(0, 240)), commit, date, cite: `${m[1]}#L${m[2]}`, taintedBy: null, score });
        }
        // One term keeps git grep order (wave 1); expanded queries rank by matched terms, then path order.
        const ranked = terms.length > 1 ? all.map((h, i) => ({ h, i })).sort((a, b) => b.h.score - a.h.score || a.i - b.i).map((x) => x.h) : all;
        const hits: MemoryHit[] = ranked.slice(0, limit).map(({ score: _s, ...h }) => h);
        for (const h of hits) {
          const text = await git(r, ["show", `${commit}:${h.path}`]).catch(() => "");
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
      return serialGit(async () => {
        const abs = resolveInside(r, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text);
        await git(r, ["add", "--", rel]);
        await git(r, ["commit", "-q", "-m", opts.redactor.redact(w.message).slice(0, 200)], { author: w.author, date: opts.clock.now() });
        return { commit: await head(r) };
      });
    },
    async appendTimeline(b) {
      const r = await ensureRoot();
      const day = b.at.slice(0, 10);
      const rel = `timeline/raw/${day}.md`;
      return serialGit(async () => {
        // Memory never holds pay amounts (harness 9.2): money in an action summary is masked on the way in.
        const line = opts.redactor.redact(`- ${b.at} [i${b.importance}] ${b.command}: ${maskAmounts(linkify(b.text.replace(/\s+/g, " "), linkContext(r)))} (src: ${b.source})`);
        const abs = join(r, "timeline", "raw", `${day}.md`);
        mkdirSync(dirname(abs), { recursive: true });
        if (!existsSync(abs)) writeFileSync(abs, `${renderDoc({ id: `timeline-${day}`, type: "timeline_raw", aliases: [], links: [], sources: [], status: null, updated: day, taintedBy: null }, `# ${day}\n`)}`);
        appendFileSync(abs, line + "\n");
        await git(r, ["add", "--", rel]);
        await git(r, ["commit", "-q", "-m", `timeline: ${b.command}\n\nWeft-Chain-Head: ${b.chainHead.seq} ${b.chainHead.hash}`], { date: b.at });
        headSeq = b.chainHead.seq;
        return { commit: await head(r) };
      });
    },
    async remove() { throw new MemoryError("NOT_PERMITTED", "memory.forget is P1 (human only)"); },
    async tree(prefix) {
      const r = await ensureRoot();
      const out = await serialGit(() => git(r, ["ls-files"]));
      return out.split("\n").filter((p) => p && !p.endsWith(".keep.md") && (!prefix || p.startsWith(prefix))).sort();
    },
    async seedFiles(files, message) {
      const r = await ensureRoot();
      return serialGit(async () => {
        for (const f of files) {
          const rel = normalizeMemoryPath(f.path);
          checkContent(f.text);
          const abs = resolveInside(r, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, f.text);
        }
        await git(r, ["add", "-A"]);
        await git(r, ["commit", "-q", "-m", message], { date: opts.clock.now() });
        linkCache = null; aliasCache = null;
        return { commit: await head(r) };
      });
    },
    async digest(input) {
      const r = await ensureRoot();
      return serialGit(() => runDigest(r, input));
    },
    async links(path) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(path);
      const abs = resolveInside(r, rel);
      if (!existsSync(abs)) throw new MemoryError("INVALID_INPUT", `No memory file ${rel}`);
      const doc = parseDoc(readFileSync(abs, "utf8"));
      const outgoing = extractLinks(bodyWithoutBacklinks(doc.body)).map((target) => ({ target, path: linkPath(target), resolved: existsSync(join(r, ...linkPath(target).split("/"))) }));
      const target = `[[${rel.replace(/\.md$/, "")}`;
      const out = await serialGit(() => git(r, ["grep", "-l", "--fixed-strings", "-e", target, "--", ...MEMORY_FOLDERS]).catch((e: { exitCode?: number | null }) => { if (e.exitCode === 1) return ""; throw e; }));
      const backlinks = out.split("\n").filter((p) => p && p !== rel).filter((p) => {
        const d = parseDoc(readFileSync(join(r, ...p.split("/")), "utf8"));
        return extractLinks(bodyWithoutBacklinks(d.body)).some((t) => linkPath(t) === rel);
      }).sort();
      return { outgoing, backlinks };
    },
    async recall(input) {
      const onePager = await this.read(RECALL_BUDGET.onePager);
      if (!onePager) return { block: "", items: [], searches: [] };
      const index = await this.aliasIndex();
      const subjects = pickSubjects(input.request, input.subjectRefs, index).slice(0, RECALL_BUDGET.maxSearches - 1);
      const terms = recallTerms(input.request, subjects, RECALL_BUDGET.maxSearches);
      const untrusted = (path: string, fm: string | null) => fm ?? (path.startsWith("knowledge/decisions/") ? `memory:${path}` : null);
      const cands: RecallCandidate[] = [{ kind: "one_pager", path: RECALL_BUDGET.onePager, title: "Company one-pager", excerpt: excerptOf(onePager.body, CAPS.onePager), score: 100, asOf: onePager.frontmatter.updated || "", taintedBy: untrusted(RECALL_BUDGET.onePager, onePager.frontmatter.taintedBy) }];
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
        hits.forEach((h, hi) => {
          // One hit per file, never frontmatter or a bare backlink bullet, and never the same event twice (the
          // hourly, daily and weekly summaries repeat important events).
          if (included.has(h.path) || h.snippet.startsWith("---") || /^[a-z_]+: /.test(h.snippet) || /^- \[\[[^\]]+\]\]$/.test(h.snippet.trim())) return;
          const excerpt = maskAmounts(stripLinks(h.snippet).replace(/ \(ref: [^)]+\)$/, "")).trim();
          if (!excerpt || seenText.has(excerpt)) return;
          included.add(h.path);
          seenText.add(excerpt);
          cands.push({ kind: "hit", path: h.cite, title: h.path, excerpt: excerpt.length > CAPS.hit * 4 ? `${excerpt.slice(0, CAPS.hit * 4 - 12)} [clipped]` : excerpt, score: (RECALL_BUDGET.maxSearches - ti) * 10 - hi, asOf: h.date, taintedBy: untrusted(h.path, h.taintedBy) });
        });
      }
      const { block, kept } = renderRecall(input.trustedOnly ? cands.filter((c) => !c.taintedBy) : cands, RECALL_BUDGET.maxTokens);
      return { block, items: kept.map((c) => ({ path: c.path, kind: c.kind, taintedBy: c.taintedBy })), searches: terms };
    },
    async history(path, limit = 20) {
      const r = await ensureRoot();
      const rel = normalizeMemoryPath(path);
      const n = Math.max(1, Math.min(50, Math.floor(limit)));
      return serialGit(async () => {
        const out = await git(r, ["log", `-n${n}`, "--format=%x1e%H%x1f%cI%x1f%an%x1f%s", "-p", "--no-color", "--no-ext-diff", "--", rel]).catch(() => "");
        return out.split("\x1e").filter((c) => c.trim()).map((chunk) => {
          const nl = chunk.indexOf("\n");
          const [commit, date, author, subject] = (nl >= 0 ? chunk.slice(0, nl) : chunk).split("\x1f");
          const diff = nl >= 0 ? chunk.slice(nl + 1).trim() : "";
          return { commit: commit!, date: date!, author: author!, subject: opts.redactor.redact(subject ?? ""), diff: opts.redactor.redact(diff.length > 8000 ? `${diff.slice(0, 8000)}\n[diff clipped]` : diff) };
        });
      });
    },
    async aliasIndex() {
      const r = await ensureRoot();
      return serialGit(async () => {
        const h = await head(r);
        if (aliasCache && aliasCache.head === h) return aliasCache.entries;
        const files = (await git(r, ["ls-files", "--", "entities", "knowledge"])).split("\n").filter((p) => p.endsWith(".md") && !p.endsWith(".keep.md"));
        const entries: AliasEntry[] = [];
        for (const p of files.sort()) {
          const abs = join(r, ...p.split("/"));
          if (!existsSync(abs)) continue;
          const d = parseDoc(readFileSync(abs, "utf8"));
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
  async function runDigest(r: string, input: { now: string; sources: DigestSources; companyRef: string; windowDays?: number }): Promise<DigestOutcome> {
    const before = await head(r);
    const tracked = (await git(r, ["ls-files"])).split("\n").filter((p) => p.endsWith(".md") && !p.endsWith(".keep.md"));
    const readText = (p: string) => { const abs = join(r, ...p.split("/")); return existsSync(abs) ? readFileSync(abs, "utf8") : null; };
    const raw = tracked.filter((p) => /^timeline\/raw\/\d{4}-\d{2}-\d{2}\.md$/.test(p)).map((p) => ({ path: p, text: readText(p) ?? "" }));
    const daily = tracked.filter((p) => p.startsWith("timeline/daily/")).map((p) => ({ path: p, body: parseDoc(readText(p) ?? "").body }));
    const plan = planCoarsen({ now: input.now, raw, daily, windowDays: input.windowDays, rawCommit: before });
    const day = companyDay(input.now);

    // Dossiers: people mentioned in the raw events still in the tree (or without a dossier yet), every state,
    // agency and notice row passed in, and the one-pager. Links use every known person and state.
    const mentioned = new Set(raw.flatMap((f) => [...f.text.matchAll(/\bwrk_\d{4}\b/g)].map((m) => m[0])));
    const sources: DigestSources = { ...input.sources, people: input.sources.people.filter((p) => mentioned.has(p.id) || !tracked.includes(`entities/people/${p.id}.md`)) };
    const ctx = linkContext(r);
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
    for (const [p, text] of [...next.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rel = normalizeMemoryPath(p);
      const abs = resolveInside(r, rel);
      if (existsSync(abs) && readFileSync(abs, "utf8") === text) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      await git(r, ["add", "--", rel]);
      written.push(rel);
    }
    for (const p of plan.removes) {
      const abs = resolveInside(r, normalizeMemoryPath(p));
      if (existsSync(abs)) unlinkSync(abs);
      await git(r, ["rm", "-q", "--cached", "--ignore-unmatch", "--", p]);
    }
    const key = digestKey(plan.periods);
    const dossiers = docs.filter((d) => d.subjectRef && ENTITY_ID_RE.test(d.subjectRef) && next.has(d.path)).map((d) => ({ subjectRef: d.subjectRef!, path: d.path, sourceDigest: sha(next.get(d.path)!) }));
    const staged = (await git(r, ["diff", "--cached", "--name-only"])).trim();
    const periods = plan.periods.map((p) => `${p.level}:${p.key}`);
    linkCache = null; aliasCache = null;
    if (!staged) return { commit: null, key, periods, removed: [], written: [], dossiers, skipped };
    const named = plan.periods.length ? plan.periods.filter((p) => p.level !== "hourly").map((p) => `${p.level} ${p.key}`).join(", ") || `hourly through ${plan.periods.at(-1)!.key}` : `dossiers as of ${day}`;
    await git(r, ["commit", "-q", "-m", `memory digest: ${named}\n\nWeft-Digest: ${key || `dossiers:${day}`}`], { date: input.now });
    return { commit: await head(r), key, periods, removed: plan.removes, written, dossiers, skipped };
  }
}

export { COMMITTER };
