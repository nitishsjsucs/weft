// GitRepo: the MemoryRepo port over today's hardened git CLI (harness 6.7; git.ts). The working tree always equals
// HEAD (every write commits at once), so a read without `at` reads the file, behind the same realpath checks the store
// used before the port. This is the reference the SQL repo is compared against byte for byte.
import { dirname, join, sep } from "node:path";
import type { MemoryCommitInput, MemoryGrepLine, MemoryGrepQuery, MemoryLogEntry, MemoryLogQuery, MemoryRepo } from "../../../contracts/src/ext/cf-memory";
import { childProcess, COMMITTER, git, GIT_FLAGS, gitEnv, nodeFs } from "./git";

// node:fs on first use (git.ts explains why): these wrappers keep the code below reading as before.
const existsSync = (p: string) => nodeFs().existsSync(p);
const mkdirSync = (p: string, o: { recursive: true }) => nodeFs().mkdirSync(p, o);
const readFileSync = (p: string, enc: "utf8") => nodeFs().readFileSync(p, enc);
const realpathSync = (p: string) => nodeFs().realpathSync(p);
const unlinkSync = (p: string) => nodeFs().unlinkSync(p);
const writeFileSync = (p: string, data: string) => nodeFs().writeFileSync(p, data);

export class MemoryPathError extends Error {
  readonly code = "INVALID_INPUT" as const;
}

/** The pathspec git takes for folders: each folder and everything under it. */
const FOLDER_SPEC = (folders: readonly string[]) => (folders.length ? ["--", ...folders] : []);

export class GitRepo implements MemoryRepo {
  readonly kind = "git" as const;
  constructor(readonly root: string) {}

  async exists(): Promise<boolean> { return existsSync(join(this.root, ".git")); }

  /** Resolves a repo-relative path inside the working tree, refusing symlinks out of it and anything under .git. */
  resolveInside(rel: string): string {
    const r = this.root;
    const abs = join(r, ...rel.split("/"));
    let dir = dirname(abs);
    while (!existsSync(dir)) dir = dirname(dir);
    const real = realpathSync(dir);
    const realRoot = realpathSync(r);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new MemoryPathError("path resolves outside the memory root");
    if (real === join(realRoot, ".git") || real.startsWith(join(realRoot, ".git") + sep)) throw new MemoryPathError("path resolves inside .git");
    if (existsSync(abs)) {
      const rf = realpathSync(abs);
      if (!rf.startsWith(realRoot + sep) || rf.startsWith(join(realRoot, ".git") + sep)) throw new MemoryPathError("path resolves outside the memory root");
    }
    return abs;
  }

  async init(files: ReadonlyArray<{ path: string; text: string }>, meta: Omit<MemoryCommitInput, "changes">): Promise<string> {
    mkdirSync(this.root, { recursive: true });
    for (const f of files) {
      const abs = join(this.root, ...f.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.text);
    }
    await git(this.root, ["init", "-q"]);
    await git(this.root, ["add", "-A"]);
    await git(this.root, ["commit", "-q", "-m", meta.message], { author: meta.author, date: meta.date });
    return this.head();
  }

  async head(): Promise<string> { return (await git(this.root, ["rev-parse", "HEAD"])).trim(); }

  async read(path: string, at?: string): Promise<string | null> {
    if (at) return git(this.root, ["show", `${at}:${path}`]).catch(() => null);
    const abs = this.resolveInside(path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  async list(opts: { prefix?: string; at?: string } = {}): Promise<string[]> {
    const out = opts.at ? await git(this.root, ["ls-tree", "-r", "--name-only", "-z", opts.at]) : await git(this.root, ["ls-files", "-z"]);
    return out.split("\0").filter((p) => p && (!opts.prefix || p.startsWith(opts.prefix)));
  }

  async commit(input: MemoryCommitInput): Promise<string | null> {
    for (const c of input.changes) {
      const abs = this.resolveInside(c.path);
      if (c.text === null) {
        if (existsSync(abs)) unlinkSync(abs);
        await git(this.root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", c.path]);
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, c.text);
        await git(this.root, ["add", "--", c.path]);
      }
    }
    const staged = await git(this.root, ["diff", "--cached", "--quiet"]).then(() => false, (e: { exitCode?: number | null }) => { if (e.exitCode === 1) return true; throw e; });
    if (!staged) return null;
    await git(this.root, ["commit", "-q", "-m", input.message], { author: input.author ?? COMMITTER, date: input.date });
    return this.head();
  }

  async grep(q: MemoryGrepQuery): Promise<MemoryGrepLine[]> {
    if (q.terms.length === 0) return [];
    const args = ["grep", "-z", ...(q.filesOnly ? ["-l"] : ["-n"]), ...(q.ignoreCase ? ["-i"] : []), "--fixed-strings", ...q.terms.flatMap((t) => ["-e", t]), ...(q.at ? [q.at] : []), ...FOLDER_SPEC(q.folders)];
    const out = await git(this.root, args).catch((e: { exitCode?: number | null }) => { if (e.exitCode === 1) return ""; throw e; });
    const prefix = q.at ? `${q.at}:` : "";
    const lines: MemoryGrepLine[] = [];
    if (q.filesOnly) {
      for (const p of out.split("\0")) if (p) lines.push({ path: p.startsWith(prefix) ? p.slice(prefix.length) : p, line: 0, text: "" });
      return lines;
    }
    // -z -n: "<path>\0<line>\0<text>\n" per match.
    let i = 0;
    while (i < out.length) {
      const a = out.indexOf("\0", i);
      if (a < 0) break;
      const b = out.indexOf("\0", a + 1);
      const nl = out.indexOf("\n", b + 1);
      const end = nl < 0 ? out.length : nl;
      const path = out.slice(i, a);
      lines.push({ path: path.startsWith(prefix) ? path.slice(prefix.length) : path, line: Number(out.slice(a + 1, b)), text: out.slice(b + 1, end) });
      i = end + 1;
    }
    return lines;
  }

  async log(q: MemoryLogQuery): Promise<MemoryLogEntry[]> {
    const args = ["log", `-n${Math.max(1, Math.floor(q.n))}`, "--format=%x1e%H%x1f%P%x1f%cI%x1f%an%x1f%s%x1f%B%x1f",
      ...(q.grep !== undefined ? ["--fixed-strings", "--grep", q.grep] : []), ...(q.patch ? ["-p", "--no-color", "--no-ext-diff"] : []), ...(q.path ? ["--", q.path] : [])];
    const out = await git(this.root, args).catch(() => "");
    return out.split("\x1e").filter((c) => c.length > 0).map((chunk) => {
      const [commit, parents, date, author, subject, body, rest] = chunk.split("\x1f");
      const entry: MemoryLogEntry = { commit: commit!, parent: parents ? parents.split(" ")[0]! : null, date: date!, author: author!, subject: subject!, body: body! };
      if (q.patch) entry.diff = (rest ?? "").replace(/^\n+/, "");
      return entry;
    });
  }

  /** The date of one commit, as %cI. */
  async commitDate(sha: string): Promise<string> { return (await git(this.root, ["log", "-1", "--format=%cI", sha])).trim(); }

  async exportFastImport(): Promise<Uint8Array> {
    return gitBytes(this.root, ["fast-export", "--all"]);
  }
}

/** git with raw bytes on stdout (fast-export streams binary-safe data). */
async function gitBytes(root: string, args: string[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    childProcess().execFile("git", [...GIT_FLAGS, "-C", root, ...args], { env: gitEnv(), maxBuffer: 64 << 20, timeout: 30_000, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`));
      else resolve(new Uint8Array(stdout));
    });
  });
}
