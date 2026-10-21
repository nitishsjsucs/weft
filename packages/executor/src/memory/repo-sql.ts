// SqlRepo: the MemoryRepo port over SQL (docs/cloudflare/design.md 4.1 and 4.3). It writes real git blob, tree and
// commit objects into mem_objects, the branch head into mem_refs and one mem_log row per commit, so for the same inputs
// it gives the same commit ids as the git CLI, and `git fast-import` of its export reproduces every one of them.
// Search, read-at, history and tree output match GitRepo's: grep follows `git grep --fixed-strings` (ASCII case
// folding), log follows `git log` with its path filter, and the patch text comes from the xdiff port (xdiff.ts).
// It runs on any Weft Db: libsql on Node (WEFT_MEMORY=sqlite) or the durable facade. Inside a transaction its writes
// join it (currentTransaction), so a note written by a command that then rolls back is rolled back too.
import { sql } from "drizzle-orm";
import { currentTransaction, type Db, type DbTx } from "@weft/db";
import { MEMORY_MAIN_REF, type MemoryCommitInput, type MemoryGrepLine, type MemoryGrepQuery, type MemoryLogEntry, type MemoryLogQuery, type MemoryRepo } from "../../../contracts/src/ext/cf-memory";
import { COMMITTER } from "./git";
import { blob, commit as commitObject, concat, FILE_MODE, fromUtf8, gitObject, parseCommit, parseTree, strictIso, subjectOf, tree as treeObject, TREE_MODE, utf8, type GitObject, type TreeEntry } from "./gitobj";
import { unifiedHunks } from "./xdiff";

const CHAIN = /Weft-Chain-Head: (\d+) ([0-9a-f]+)/;
const MAX_CACHE = 20_000;

type Flat = Map<string, string>;

/** git's quote_c_style for a path in a diff header, as core.quotePath (on by default) prints it. */
export function quotePath(p: string): string {
  const bytes = utf8(p);
  let needs = false;
  let out = "";
  for (const b of bytes) {
    if (b === 0x22) { out += "\\\""; needs = true; }
    else if (b === 0x5c) { out += "\\\\"; needs = true; }
    else if (b === 0x07) { out += "\\a"; needs = true; }
    else if (b === 0x08) { out += "\\b"; needs = true; }
    else if (b === 0x09) { out += "\\t"; needs = true; }
    else if (b === 0x0a) { out += "\\n"; needs = true; }
    else if (b === 0x0b) { out += "\\v"; needs = true; }
    else if (b === 0x0c) { out += "\\f"; needs = true; }
    else if (b === 0x0d) { out += "\\r"; needs = true; }
    else if (b < 0x20 || b >= 0x7f) { out += `\\${b.toString(8).padStart(3, "0")}`; needs = true; }
    else out += String.fromCharCode(b);
  }
  return needs ? `"${out}"` : p;
}
const side = (prefix: "a/" | "b/", p: string) => { const q = quotePath(prefix + p); return q; };

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export class SqlRepo implements MemoryRepo {
  readonly kind = "sql" as const;
  private readonly objects = new Map<string, GitObject>();
  private readonly flats = new Map<string, Flat>();
  constructor(private readonly db: Db, private readonly refName: string = MEMORY_MAIN_REF) {}

  private h(): DbTx { return currentTransaction(this.db) ?? this.db; }

  // ---- objects ------------------------------------------------------------------------------------------------

  private remember(o: GitObject): void {
    if (this.objects.size >= MAX_CACHE) this.objects.clear();
    this.objects.set(o.sha, o);
  }

  async object(sha: string): Promise<GitObject | null> {
    const hit = this.objects.get(sha);
    if (hit) return hit;
    const rows = await this.h().all<{ type: string; body: ArrayBuffer | Uint8Array }>(sql`SELECT type, body FROM mem_objects WHERE sha = ${sha}`);
    const r = rows[0];
    if (!r) return null;
    const body = r.body instanceof Uint8Array ? new Uint8Array(r.body) : new Uint8Array(r.body as ArrayBuffer);
    const o: GitObject = { sha, type: r.type as GitObject["type"], body };
    this.remember(o);
    return o;
  }

  private async must(sha: string, type: GitObject["type"]): Promise<GitObject> {
    const o = await this.object(sha);
    if (!o || o.type !== type) throw new Error(`memory repo: missing ${type} ${sha}`);
    return o;
  }

  /** path -> blob sha for every file of a tree. */
  private async flatten(treeSha: string): Promise<Flat> {
    const hit = this.flats.get(treeSha);
    if (hit) return hit;
    const out: Flat = new Map();
    const walk = async (sha: string, prefix: string) => {
      for (const e of parseTree((await this.must(sha, "tree")).body)) {
        if (e.mode === TREE_MODE) await walk(e.sha, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, e.sha);
      }
    };
    await walk(treeSha, "");
    if (this.flats.size >= 512) this.flats.clear();
    this.flats.set(treeSha, out);
    return out;
  }

  private async treeOf(commitSha: string): Promise<string> { return parseCommit((await this.must(commitSha, "commit")).body).tree; }

  /** Builds the nested trees for a flat map; returns the root tree and every object written along the way. */
  private buildTrees(files: Flat): { root: string; objects: GitObject[] } {
    const objects: GitObject[] = [];
    interface Dir { files: Map<string, string>; dirs: Map<string, Dir> }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, sha] of files) {
      const parts = path.split("/");
      let d = root;
      for (const p of parts.slice(0, -1)) {
        let next = d.dirs.get(p);
        if (!next) { next = { files: new Map(), dirs: new Map() }; d.dirs.set(p, next); }
        d = next;
      }
      d.files.set(parts[parts.length - 1]!, sha);
    }
    const write = (d: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, sha] of d.files) entries.push({ mode: FILE_MODE, name, sha });
      for (const [name, sub] of d.dirs) entries.push({ mode: TREE_MODE, name, sha: write(sub) });
      const t = treeObject(entries);
      objects.push(t);
      return t.sha;
    };
    return { root: write(root), objects };
  }

  private async store(objects: readonly GitObject[], h: DbTx): Promise<void> {
    for (const o of objects) {
      await h.run(sql`INSERT INTO mem_objects (sha, type, body) VALUES (${o.sha}, ${o.type}, ${o.body}) ON CONFLICT (sha) DO NOTHING`);
      this.remember(o);
    }
  }

  // ---- the port -----------------------------------------------------------------------------------------------

  async exists(): Promise<boolean> {
    return (await this.h().all(sql`SELECT 1 FROM mem_refs WHERE name = ${this.refName}`)).length > 0;
  }

  async head(): Promise<string> {
    const r = (await this.h().all<{ sha: string }>(sql`SELECT sha FROM mem_refs WHERE name = ${this.refName}`))[0];
    if (!r) throw new Error("memory repo: no commits yet");
    return r.sha;
  }

  private async headOrNull(): Promise<string | null> {
    const r = (await this.h().all<{ sha: string }>(sql`SELECT sha FROM mem_refs WHERE name = ${this.refName}`))[0];
    return r?.sha ?? null;
  }

  async init(files: ReadonlyArray<{ path: string; text: string }>, meta: Omit<MemoryCommitInput, "changes">): Promise<string> {
    if (await this.headOrNull()) throw new Error("memory repo: already initialised");
    const out = await this.commit({ changes: files.map((f) => ({ path: f.path, text: f.text })), ...meta }, true);
    if (!out) throw new Error("memory repo: nothing to initialise");
    return out;
  }

  async read(path: string, at?: string): Promise<string | null> {
    const c = at ?? (await this.headOrNull());
    if (!c) return null;
    const o = await this.object(c);
    if (!o || o.type !== "commit") return null;
    const sha = (await this.flatten(parseCommit(o.body).tree)).get(path);
    if (!sha) return null;
    return fromUtf8((await this.must(sha, "blob")).body);
  }

  async list(opts: { prefix?: string; at?: string } = {}): Promise<string[]> {
    const c = opts.at ?? (await this.headOrNull());
    if (!c) return [];
    const flat = await this.flatten(await this.treeOf(c));
    return [...flat.keys()].filter((p) => !opts.prefix || p.startsWith(opts.prefix)).sort(byteOrder);
  }

  async commit(input: MemoryCommitInput, root = false): Promise<string | null> {
    const parent = root ? null : await this.headOrNull();
    const base: Flat = parent ? new Map(await this.flatten(await this.treeOf(parent))) : new Map();
    const blobs: GitObject[] = [];
    for (const c of input.changes) {
      if (c.text === null) { base.delete(c.path); continue; }
      const b = blob(c.text);
      blobs.push(b);
      base.set(c.path, b.sha);
    }
    const { root: treeSha, objects: trees } = this.buildTrees(base);
    if (parent && treeSha === (await this.treeOf(parent))) return null;
    const c = commitObject({ tree: treeSha, parent, author: input.author ?? COMMITTER, committer: COMMITTER, date: input.date, message: input.message });
    const chain = CHAIN.exec(fromUtf8(c.body));
    const write = async (h: DbTx) => {
      await this.store([...blobs, ...trees, c], h);
      await h.run(sql`INSERT INTO mem_refs (name, sha) VALUES (${this.refName}, ${c.sha}) ON CONFLICT (name) DO UPDATE SET sha = excluded.sha`);
      const next = Number((await h.all<{ n: number | null }>(sql`SELECT max(seq) AS n FROM mem_log`))[0]?.n ?? 0) + 1;
      await h.run(sql`INSERT INTO mem_log (seq, sha, parent, date, chain_seq, chain_hash) VALUES (${next}, ${c.sha}, ${parent}, ${input.date}, ${chain ? Number(chain[1]) : null}, ${chain ? chain[2]! : null})`);
    };
    // One transaction per commit: nested in the caller's when there is one.
    await this.h().transaction(async (tx) => write(tx));
    this.flats.set(treeSha, base);
    return c.sha;
  }

  async grep(q: MemoryGrepQuery): Promise<MemoryGrepLine[]> {
    if (q.terms.length === 0) return [];
    const c = q.at ?? (await this.headOrNull());
    if (!c) return [];
    const flat = await this.flatten(await this.treeOf(c));
    const inFolders = (p: string) => q.folders.length === 0 || q.folders.some((f) => p === f || p.startsWith(`${f}/`));
    const terms = q.ignoreCase ? q.terms.map(asciiLower) : [...q.terms];
    const out: MemoryGrepLine[] = [];
    for (const path of [...flat.keys()].filter(inFolders).sort(byteOrder)) {
      const text = fromUtf8((await this.must(flat.get(path)!, "blob")).body);
      const lines = text.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      for (const [i, line] of lines.entries()) {
        const hay = q.ignoreCase ? asciiLower(line) : line;
        if (!terms.some((t) => hay.includes(t))) continue;
        if (q.filesOnly) { out.push({ path, line: 0, text: "" }); break; }
        out.push({ path, line: i + 1, text: line });
      }
    }
    return out;
  }

  /** The commits from HEAD back to the root, newest first. */
  private async chain(): Promise<string[]> {
    const rows = await this.h().all<{ sha: string; parent: string | null }>(sql`SELECT sha, parent FROM mem_log ORDER BY seq DESC`);
    const head = await this.headOrNull();
    if (!head) return [];
    const parentOf = new Map(rows.map((r) => [r.sha, r.parent]));
    const out: string[] = [];
    for (let s: string | null = head; s; ) {
      out.push(s);
      if (parentOf.has(s)) s = parentOf.get(s)!;
      else s = parseCommit((await this.must(s, "commit")).body).parent;
    }
    return out;
  }

  async log(q: MemoryLogQuery): Promise<MemoryLogEntry[]> {
    const out: MemoryLogEntry[] = [];
    const n = Math.max(1, Math.floor(q.n));
    for (const sha of await this.chain()) {
      if (out.length >= n) break;
      const c = parseCommit((await this.must(sha, "commit")).body);
      const mine = await this.flatten(c.tree);
      const theirs: Flat = c.parent ? await this.flatten(await this.treeOf(c.parent)) : new Map();
      if (q.path && mine.get(q.path) === theirs.get(q.path)) continue;
      if (q.grep !== undefined && !c.message.includes(q.grep)) continue;
      const entry: MemoryLogEntry = { commit: sha, parent: c.parent, date: strictIso(c.committer.epoch, c.committer.tz), author: c.author.name, subject: subjectOf(c.message), body: c.message };
      if (q.patch) {
        const paths = q.path ? [q.path] : [...new Set([...mine.keys(), ...theirs.keys()])].filter((p) => mine.get(p) !== theirs.get(p)).sort(byteOrder);
        const parts: Uint8Array[] = [];
        for (const p of paths) parts.push(await this.fileDiff(p, theirs.get(p) ?? null, mine.get(p) ?? null));
        entry.diff = fromUtf8(concat(parts));
      }
      out.push(entry);
    }
    return out;
  }

  /** The shortest unique prefix of at least 7 characters among this repo's objects (git's default abbreviation). */
  private async abbrev(sha: string): Promise<string> {
    for (let len = 7; len < 40; len++) {
      const prefix = sha.slice(0, len);
      const rows = await this.h().all<{ n: number }>(sql`SELECT count(*) AS n FROM mem_objects WHERE substr(sha, 1, ${len}) = ${prefix}`);
      if (Number(rows[0]?.n ?? 0) <= 1) return prefix;
    }
    return sha;
  }

  /** One file's section of `git log -p`: the diff --git header and the hunks. */
  private async fileDiff(path: string, before: string | null, after: string | null): Promise<Uint8Array> {
    const lines: string[] = [`diff --git ${side("a/", path)} ${side("b/", path)}`];
    const zero = "0000000";
    if (before === null) lines.push(`new file mode ${FILE_MODE}`, `index ${zero}..${await this.abbrev(after!)}`);
    else if (after === null) lines.push(`deleted file mode ${FILE_MODE}`, `index ${await this.abbrev(before)}..${zero}`);
    else lines.push(`index ${await this.abbrev(before)}..${await this.abbrev(after)} ${FILE_MODE}`);
    const a = before ? (await this.must(before, "blob")).body : new Uint8Array(0);
    const b = after ? (await this.must(after, "blob")).body : new Uint8Array(0);
    const hunks = unifiedHunks(a, b);
    // git prints the ---/+++ lines only when there is content to diff (an empty new file has none).
    if (hunks.length > 0) {
      lines.push(`--- ${before === null ? "/dev/null" : side("a/", path)}`, `+++ ${after === null ? "/dev/null" : side("b/", path)}`);
    }
    return concat([utf8(`${lines.join("\n")}\n`), hunks]);
  }

  /** The date of one commit, as %cI. */
  async commitDate(sha: string): Promise<string> {
    const c = parseCommit((await this.must(sha, "commit")).body);
    return strictIso(c.committer.epoch, c.committer.tz);
  }

  async exportFastImport(): Promise<Uint8Array> {
    const commits = (await this.chain()).reverse();
    const parts: Uint8Array[] = [];
    const marks = new Map<string, number>();
    let next = 1;
    let prev: Flat = new Map();
    let prevMark = 0;
    for (const sha of commits) {
      const c = parseCommit((await this.must(sha, "commit")).body);
      const flat = await this.flatten(c.tree);
      const changed = [...flat.entries()].filter(([p, s]) => prev.get(p) !== s).sort(([x], [y]) => byteOrder(x, y));
      const removed = [...prev.keys()].filter((p) => !flat.has(p)).sort(byteOrder);
      for (const [, s] of changed) {
        if (marks.has(s)) continue;
        const body = (await this.must(s, "blob")).body;
        marks.set(s, next++);
        parts.push(utf8(`blob\nmark :${marks.get(s)}\ndata ${body.byteLength}\n`), body, utf8("\n"));
      }
      const mark = next++;
      const msg = utf8(c.message);
      const who = (w: typeof c.author) => `${w.name} <${w.email}> ${w.epoch} ${w.tz}`;
      parts.push(utf8(`commit ${this.refName}\nmark :${mark}\nauthor ${who(c.author)}\ncommitter ${who(c.committer)}\ndata ${msg.byteLength}\n`), msg, utf8("\n"));
      if (prevMark) parts.push(utf8(`from :${prevMark}\n`));
      for (const p of removed) parts.push(utf8(`D ${fastImportPath(p)}\n`));
      for (const [p, s] of changed) parts.push(utf8(`M ${FILE_MODE} :${marks.get(s)} ${fastImportPath(p)}\n`));
      parts.push(utf8("\n"));
      prev = flat;
      prevMark = mark;
    }
    return concat(parts);
  }

  /** Replaces the whole repository with these objects and this history (memory:restore and tests). */
  async replaceAll(objects: readonly { sha: string; type: GitObject["type"]; body: Uint8Array }[], history: readonly string[]): Promise<void> {
    await this.h().transaction(async (tx) => {
      await tx.run(sql`DELETE FROM mem_objects`);
      await tx.run(sql`DELETE FROM mem_refs`);
      await tx.run(sql`DELETE FROM mem_log`);
      this.objects.clear();
      this.flats.clear();
      for (const o of objects) {
        const check = gitObject(o.type, o.body);
        if (check.sha !== o.sha) throw new Error(`memory repo: object ${o.sha} does not hash to its id`);
      }
      await this.store(objects.map((o) => ({ sha: o.sha, type: o.type, body: o.body })), tx);
      let seq = 0;
      for (const sha of history) {
        const c = parseCommit((await this.must(sha, "commit")).body);
        const chain = CHAIN.exec(c.message);
        await tx.run(sql`INSERT INTO mem_log (seq, sha, parent, date, chain_seq, chain_hash) VALUES (${++seq}, ${sha}, ${c.parent}, ${new Date(c.committer.epoch * 1000).toISOString()}, ${chain ? Number(chain[1]) : null}, ${chain ? chain[2]! : null})`);
      }
      if (history.length) await tx.run(sql`INSERT INTO mem_refs (name, sha) VALUES (${this.refName}, ${history[history.length - 1]!})`);
    });
  }

  /** Forgets cached trees and objects (after a world reset swapped the tables underneath). */
  clearCache(): void { this.objects.clear(); this.flats.clear(); }
}

/** `git ls-files` order: by the bytes of the path. */
export function byteOrder(a: string, b: string): number {
  if (a === b) return 0;
  const x = utf8(a), y = utf8(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** fast-import quotes a path that starts with a quote or holds a newline (C style). */
function fastImportPath(p: string): string {
  return p.startsWith("\"") || p.includes("\n") ? `"${p.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"` : p;
}
