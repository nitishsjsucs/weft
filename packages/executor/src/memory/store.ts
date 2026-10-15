// The memory repo (SPEC 9.4, harness 9 and 6.7): Markdown with frontmatter in a per-company git repo. The executor
// is the only git caller. Dates come from the sim clock, so commit SHAs are reproducible.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import type { MemoryFolder, MemoryFrontmatter, MemoryHit, MemoryStore, MemoryWrite, SimClock } from "@weft/contracts";
import type { Redactor } from "../vault/redact";
import { COMMITTER, git, serialGit } from "./git";

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

export interface LocalMemory extends MemoryStore {
  root(): string | null;
  /** Seq of the last chain head written to the timeline (for gitLag), read from git at init. */
  chainHeadSeq(): number | null;
  /** Commits several seed files at once (seed only). */
  seedFiles(files: { path: string; text: string }[], message: string): Promise<{ commit: string }>;
}

export function createMemoryStore(opts: { dataDir: string; clock: SimClock; redactor: Redactor; defaultCompanyId: () => Promise<string | null>;
  initialFiles?: (companyId: string, now: string) => Promise<{ path: string; text: string }[]> }): LocalMemory {
  let root: string | null = null;
  let headSeq: number | null = null;
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
      return serialGit(async () => {
        const commit = q.at ?? (await head(r));
        const args = ["grep", "-n", "-i", "--fixed-strings", "-e", q.query.trim(), ...(q.at ? [q.at] : []), "--", ...folders];
        const out = await git(r, args).catch((e: { exitCode?: number | null }) => { if (e.exitCode === 1) return ""; throw e; });
        const date = (await git(r, ["log", "-1", "--format=%cI", commit])).trim();
        const hits: MemoryHit[] = [];
        for (const line of out.split("\n")) {
          if (!line) continue;
          const rest = q.at && line.startsWith(`${q.at}:`) ? line.slice(q.at.length + 1) : line;
          const m = /^([^:]+):(\d+):(.*)$/.exec(rest);
          if (!m) continue;
          hits.push({ path: m[1]!, line: Number(m[2]), snippet: opts.redactor.redact(m[3]!.slice(0, 240)), commit, date, cite: `${m[1]}#L${m[2]}`, taintedBy: null });
          if (hits.length >= limit) break;
        }
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
      const line = opts.redactor.redact(`- ${b.at} [i${b.importance}] ${b.command}: ${b.text.replace(/\s+/g, " ")} (src: ${b.source})`);
      return serialGit(async () => {
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
        return { commit: await head(r) };
      });
    },
  };
}

export { COMMITTER };
