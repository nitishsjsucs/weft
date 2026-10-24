// The two memory repositories behind the MemoryRepo port (docs/cloudflare/design.md 4.3): GitRepo (the git CLI) and
// SqlRepo (git objects in SQL). For the rich world's 36 commits SqlRepo produces the same SHAs, the same HEAD and the
// same search, read-at, history, tree, links and recall output, and `git fast-import` of its export reproduces every
// commit. A store driven through the same writes on both repos gives the same commits. Owner: cf1-db.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { MemoryFrontmatter, SimClock } from "@weft/contracts";
import { closeDb, migrate, openDb, withWriteLock, type Db } from "@weft/db";
import { createWeft } from "../../../../apps/api/src/compose";
import { seedWorldProfile } from "../../../seed/src/profile";
import { blob, cleanupMessage, commit as commitObject, EMPTY_BLOB_SHA, parseCommit, strictIso, tree, FILE_MODE, TREE_MODE } from "../../src/memory/gitobj";
import { GitRepo } from "../../src/memory/repo-git";
import { SqlRepo } from "../../src/memory/repo-sql";
import { createMemoryStore, memoryRepoFactory, type LocalMemory } from "../../src/memory/store";
import { Redactor } from "../../src/vault/redact";
import { GIT_FLAGS, gitEnv } from "../../src/memory/git";

const CMP = "cmp_larkspur";
const git = (root: string, args: string[], input?: Uint8Array | string) =>
  execFileSync("git", [...GIT_FLAGS, "-C", root, ...args], { env: gitEnv(), encoding: "utf8", input, maxBuffer: 64 << 20 });
const gitRaw = (root: string, args: string[]) => execFileSync("git", [...GIT_FLAGS, "-C", root, ...args], { env: gitEnv(), maxBuffer: 64 << 20 });

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const dbs: Db[] = [];
async function sqlDb(): Promise<Db> {
  const db = openDb({ dataDir: tmp("weft-memsql-") });
  await migrate(db);
  dbs.push(db);
  return db;
}
afterAll(async () => { for (const db of dbs.splice(0)) await closeDb(db); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixedClock(start = "2026-10-26T15:30:00.000Z"): SimClock & { at(iso: string): void } {
  let now = start;
  return { now: () => now, rate: () => 0, set: async (iso: string) => { now = iso; }, advance: async (iso: string) => { now = iso; }, at: (iso: string) => { now = iso; } } as unknown as SimClock & { at(iso: string): void };
}

describe("gitobj", () => {
  it("blob, tree and commit ids match git", () => {
    const root = tmp("weft-gitobj-");
    git(root, ["init", "-q"]);
    writeFileSync(join(root, "a.md"), "alpha\n");
    execFileSync("mkdir", ["-p", join(root, "d")]);
    writeFileSync(join(root, "d", ".keep.md"), "");
    writeFileSync(join(root, "d", "b.md"), "beta\nno newline");
    writeFileSync(join(root, "a.mdx"), "x");
    git(root, ["add", "-A"]);
    const env = { ...gitEnv({ date: "2026-10-26T15:30:00.000Z" }) };
    execFileSync("git", [...GIT_FLAGS, "-C", root, "commit", "-q", "-m", "  first line  \n\n\n# kept as text\n\ntrailer: x\n\n"], { env });
    const d = tree([{ mode: FILE_MODE, name: ".keep.md", sha: EMPTY_BLOB_SHA }, { mode: FILE_MODE, name: "b.md", sha: blob("beta\nno newline").sha }]);
    const t = tree([{ mode: FILE_MODE, name: "a.md", sha: blob("alpha\n").sha }, { mode: TREE_MODE, name: "d", sha: d.sha }, { mode: FILE_MODE, name: "a.mdx", sha: blob("x").sha }]);
    expect(t.sha).toBe(git(root, ["rev-parse", "HEAD^{tree}"]).trim());
    const c = commitObject({ tree: t.sha, parent: null, author: { name: "Weft Agent", email: "agent@weft.example" }, committer: { name: "Weft Agent", email: "agent@weft.example" }, date: "2026-10-26T15:30:00.000Z", message: "  first line  \n\n\n# kept as text\n\ntrailer: x\n\n" });
    expect(c.sha).toBe(git(root, ["rev-parse", "HEAD"]).trim());
    expect(cleanupMessage("a  \n\n\n\nb\n\n")).toBe("a\n\nb\n");
    expect(parseCommit(c.body).message).toBe(git(root, ["log", "-1", "--format=%B"]).replace(/\n$/, ""));
  });

  it("GitRepo prints dates as SqlRepo does on every git version: Z for a zero offset, +hh:mm for any other", async () => {
    const root = tmp("weft-gitdates-");
    const repo = new GitRepo(root);
    const first = await repo.init([{ path: "a.md", text: "a\n" }], { message: "init", date: "2026-10-26T15:30:00.000Z" });
    // git 2.45.0 and later print a zero offset in %cI as "Z", older git as "+00:00"; GitRepo prints "Z" on both.
    expect(await repo.commitDate(first)).toBe("2026-10-26T15:30:00Z");
    // A commit made in another zone (Weft's own commits are always +0000) keeps git's own %cI text.
    writeFileSync(join(root, "b.md"), "b\n");
    git(root, ["add", "-A"]);
    execFileSync("git", [...GIT_FLAGS, "-C", root, "commit", "-q", "-m", "zoned"], { env: { ...gitEnv(), GIT_AUTHOR_DATE: "@1792857600 -0700", GIT_COMMITTER_DATE: "@1792857600 -0700" } });
    const zoned = git(root, ["log", "-1", "--format=%cI"]).trim();
    expect(zoned).toBe("2026-10-24T09:00:00-07:00");
    expect((await repo.log({ n: 2 })).map((e) => e.date)).toEqual([zoned, "2026-10-26T15:30:00Z"]);
    expect(strictIso(1792857600, "-0700")).toBe(zoned);
  });
});

// ---- a store over each repository, driven through the same writes -------------------------------------------------

const fm = (id: string, type: MemoryFrontmatter["type"], extra: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter =>
  ({ id, type, aliases: [], links: [], sources: ["seed"], status: null, updated: "2026-10-20", taintedBy: null, ...extra });

async function twinStores(): Promise<{ g: LocalMemory; s: LocalMemory; clock: ReturnType<typeof fixedClock>; gitRoot: string; db: Db }> {
  const clock = fixedClock("2026-10-19T16:00:00.000Z");
  const redactor = new Redactor();
  const initialFiles = async () => [
    { path: "entities/people/wrk_0002.md", text: `---\nid: "wrk_0002"\ntype: "person"\naliases: ["Theo"]\nlinks: []\nsources: ["seed"]\nstatus: null\nupdated: "2026-10-19"\ntainted_by: null\n---\n# Theo Marsh\n\n- Works in CA (2026-10-19, src: seed)\n` },
    { path: "entities/states/CA.md", text: `---\nid: "state-CA"\ntype: "state"\naliases: []\nlinks: []\nsources: ["seed"]\nstatus: null\nupdated: "2026-10-19"\ntainted_by: null\n---\n# California\n` },
  ];
  const gitDir = tmp("weft-twin-git-");
  const db = await sqlDb();
  const base = { dataDir: gitDir, clock, redactor, defaultCompanyId: async () => CMP, initialFiles };
  const g = createMemoryStore({ ...base, repo: (root) => new GitRepo(root) });
  const s = createMemoryStore({ ...base, repo: () => new SqlRepo(db) });
  return { g, s, clock, gitRoot: join(gitDir, "companies", CMP, "memory"), db };
}

describe("a store over GitRepo and over SqlRepo", () => {
  it("makes the same commits and gives the same output for the same writes", async () => {
    const { g, s, clock } = await twinStores();
    const both = async <T>(fn: (m: LocalMemory) => Promise<T>): Promise<[T, T]> => [await fn(g), await fn(s)];
    const same = async <T>(fn: (m: LocalMemory) => Promise<T>) => { const [a, b] = await both(fn); expect(b).toEqual(a); return a; };
    await both((m) => m.init(CMP));
    await same((m) => m.head());
    clock.at("2026-10-20T15:30:00.000Z");
    await same((m) => m.write({ path: "knowledge/procedures/sui.md", frontmatter: fm("knowledge-procedures-sui", "procedure"), body: "# SUI notices\n\n1. Read the notice.\n2. Propose the rate [[entities/states/CA]].\n", message: "note: sui", author: { name: "Weft Agent", email: "agent@weft.example" } }));
    await same((m) => m.write({ path: "workstreams/ca.md", frontmatter: fm("ws-ca", "workstream", { links: ["entities/people/wrk_0002"] }), body: "# CA rollout\n\n- Owner [[entities/people/wrk_0002|Theo]] (2026-10-20, src: action:1)\n", message: "  workstream: CA\n\n\nmore detail  \n", author: { name: "svc_digest", email: "agent@weft.example" } }));
    for (let i = 1; i <= 6; i++) {
      await same((m) => m.appendTimeline({ at: `2026-10-20T1${i}:15:00.000Z`, command: i % 2 ? "people.update" : "tax.update_rate", text: `Updated wrk_0002 in CA, step ${i} with $1,200.00`, importance: (i % 4) as 0 | 1 | 2 | 3, source: `action:${i}`, chainHead: { seq: i, hash: `${i}`.repeat(64).slice(0, 64) } }));
    }
    // Rewriting a note with new text, then with the same text (no commit: both refuse alike).
    await same((m) => m.write({ path: "knowledge/procedures/sui.md", frontmatter: fm("knowledge-procedures-sui", "procedure"), body: "# SUI notices\n\n1. Read the notice.\n2. Check the effective date.\n3. Propose the rate.\n", message: "note: sui v2", author: { name: "Weft Agent", email: "agent@weft.example" } }));
    const [e1, e2] = await Promise.all([g, s].map((m) => m.write({ path: "knowledge/procedures/sui.md", frontmatter: fm("knowledge-procedures-sui", "procedure"), body: "# SUI notices\n\n1. Read the notice.\n2. Check the effective date.\n3. Propose the rate.\n", message: "again", author: { name: "Weft Agent", email: "agent@weft.example" } }).then(() => "ok", (e: Error) => e.message)));
    expect(e2).toBe(e1);
    await same((m) => m.seedFiles([{ path: "comms/oct.md", text: "# October\n\nDigest posted.\n" }, { path: "knowledge/facts/company.md", text: "---\nid: \"facts\"\ntype: \"fact\"\naliases: []\nlinks: []\nsources: [\"seed\"]\nstatus: null\nupdated: \"2026-10-20\"\ntainted_by: null\n---\n# Facts\n\n- Payday is the 15th (2026-10-20, src: seed)\n" }], "seed: facts"));
    const sources = {
      people: [{ id: "wrk_0002", name: "Theo Marsh", aliases: ["Theo Marsh"], facts: [{ text: "Work state CA", date: "2026-10-20", src: "worker:wrk_0002" }] }],
      states: [{ code: "CA", facts: [{ text: "Active employees 1", date: "2026-10-20", src: "workers:state=CA" }] }],
      agencies: [], notices: [],
      onePager: { companyName: "Larkspur Robotics, Inc.", asOf: "2026-10-20", headcount: [{ text: "CA 1 active", date: "2026-10-20", src: "workers:state=CA" }], openItems: [], workstreams: [], autonomy: [] },
    };
    clock.at("2026-10-28T00:00:00.000Z");
    const d1 = await same((m) => m.digest({ now: "2026-10-28T00:00:00.000Z", sources, companyRef: CMP }));
    expect(d1.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await same((m) => m.digest({ now: "2026-10-28T00:00:00.000Z", sources, companyRef: CMP }))).commit).toBeNull();
    await compareOutputs(g, s, ["Theo Marsh", "SUI", "rate", "CA", "Read the notice", "effective date check", "nothing here", "wrk_0002", "[[entities/states/CA"]);
    expect(s.chainHeadSeq()).toBe(g.chainHeadSeq());
  }, 120_000);

  it("refuses the same paths and content on both", async () => {
    const { g, s } = await twinStores();
    await g.init(CMP); await s.init(CMP);
    for (const path of ["knowledge/../.git/config", "/etc/passwd", "a\\b.md", "knowledge/x.txt", ".hidden/x.md"]) {
      const [a, b] = await Promise.all([g, s].map((m) => m.read(path).then(() => "ok", (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`)));
      expect(b).toBe(a);
    }
    const secretWrite = (m: LocalMemory) => m.write({ path: "knowledge/facts/pay.md", frontmatter: fm("x", "fact"), body: "- base pay is $90,000 a year (2026-10-20, src: x)\n", message: "x", author: { name: "Weft Agent", email: "agent@weft.example" } }).then(() => "ok", (e: { code?: string }) => e.code);
    expect(await secretWrite(s)).toBe(await secretWrite(g));
  }, 60_000);
});

/** Every read surface of the store, compared between the two. */
async function compareOutputs(g: LocalMemory, s: LocalMemory, queries: string[]): Promise<void> {
  const head = await g.head();
  expect(await s.head()).toBe(head);
  const tree = await g.tree();
  expect(await s.tree()).toEqual(tree);
  expect(await s.tree("entities/")).toEqual(await g.tree("entities/"));
  for (const p of tree) {
    expect(await s.read(p), p).toEqual(await g.read(p));
    expect(await s.history(p, 50), `history ${p}`).toEqual(await g.history(p, 50));
    expect(await s.links(p), `links ${p}`).toEqual(await g.links(p));
  }
  const firstCommit = (await g.history(tree[0]!, 50)).at(-1)!.commit;
  for (const p of tree.slice(0, 20)) expect(await s.read(p, firstCommit), `read-at ${p}`).toEqual(await g.read(p, firstCommit));
  expect(await s.aliasIndex()).toEqual(await g.aliasIndex());
  for (const q of queries) {
    expect(await s.search({ query: q, folders: null, at: null, limit: 50 }), `search ${q}`).toEqual(await g.search({ query: q, folders: null, at: null, limit: 50 }));
    expect(await s.search({ query: q, folders: ["knowledge", "timeline"], at: firstCommit, limit: 10 }), `search-at ${q}`).toEqual(await g.search({ query: q, folders: ["knowledge", "timeline"], at: firstCommit, limit: 10 }));
    expect(await s.recall({ request: q, subjectRefs: ["wrk_0002"] }), `recall ${q}`).toEqual(await g.recall({ request: q, subjectRefs: ["wrk_0002"] }));
    expect(await s.recall({ request: q, subjectRefs: [], trustedOnly: true })).toEqual(await g.recall({ request: q, subjectRefs: [], trustedOnly: true }));
  }
}

// ---- the rich world -------------------------------------------------------------------------------------------------

describe("the rich world's memory on SqlRepo", () => {
  let richDir: string;
  let gitRoot: string;
  let commits: string[];
  let sqlRepoDb: Db;
  let sqlRepo: SqlRepo;
  beforeAll(async () => {
    richDir = tmp("weft-rich-mem-");
    // The reference history comes from the git repository, whatever WEFT_MEMORY says for the rest of the run.
    const memoryEnv = process.env.WEFT_MEMORY;
    delete process.env.WEFT_MEMORY;
    try {
      const weft = await createWeft({ dataDir: richDir, testMode: true });
      try { await seedWorldProfile(weft, "rich"); } finally { await weft.close(); }
    } finally { if (memoryEnv !== undefined) process.env.WEFT_MEMORY = memoryEnv; }
    gitRoot = join(richDir, "companies", CMP, "memory");
    commits = git(gitRoot, ["rev-list", "--reverse", "HEAD"]).trim().split("\n");
    // Replay every commit through the port: the same files, message, author and date.
    sqlRepoDb = await sqlDb();
    sqlRepo = new SqlRepo(sqlRepoDb);
    let prev = new Map<string, string>();
    for (const c of commits) {
      const parsed = parseCommit(new Uint8Array(gitRaw(gitRoot, ["cat-file", "commit", c])));
      const files = new Map(git(gitRoot, ["ls-tree", "-r", c]).trim().split("\n").map((l) => { const [meta, path] = l.split("\t"); return [path!, meta!.split(" ")[2]!] as [string, string]; }));
      const text = (sha: string) => gitRaw(gitRoot, ["cat-file", "blob", sha]).toString("utf8");
      const meta = { message: parsed.message, author: { name: parsed.author.name, email: parsed.author.email }, date: new Date(parsed.committer.epoch * 1000).toISOString() };
      const changes = [...[...files].filter(([p, s]) => prev.get(p) !== s).map(([p, s]) => ({ path: p, text: text(s) })), ...[...prev.keys()].filter((p) => !files.has(p)).map((p) => ({ path: p, text: null }))];
      const got = prev.size === 0 ? await sqlRepo.init(changes.map((x) => ({ path: x.path, text: x.text! })), meta) : await sqlRepo.commit({ changes, ...meta });
      expect(got, `commit ${c}`).toBe(c);
      prev = files;
    }
  }, 180_000);

  it("reproduces all 36 commit SHAs and HEAD", async () => {
    expect(commits).toHaveLength(36);
    expect(await sqlRepo.head()).toBe(commits.at(-1));
    expect(await sqlRepo.list()).toEqual(git(gitRoot, ["ls-files"]).trim().split("\n"));
    expect((await sqlRepo.list())).toHaveLength(90);
  });

  it("gives the same search, read-at, history, tree, links and recall output as the git repo", async () => {
    const clock = fixedClock();
    const redactor = new Redactor();
    const g = createMemoryStore({ dataDir: richDir, clock, redactor, defaultCompanyId: async () => CMP, repo: (root) => new GitRepo(root) });
    const s = createMemoryStore({ dataDir: richDir, clock, redactor, defaultCompanyId: async () => CMP, repo: () => sqlRepo });
    await compareOutputs(g, s, ["Theo Marsh", "SUI rate", "payroll", "October payroll", "Colorado", "wrk_0026", "Lena Brooks", "approve", "When do we pay salaries?", "expense", "weekly digest", "CA"]);
    expect(s.chainHeadSeq()).toBe(g.chainHeadSeq());
    // Every commit's patch, as git log -p prints it.
    expect(await sqlRepo.log({ n: 100, patch: true })).toEqual(await new GitRepo(gitRoot).log({ n: 100, patch: true }));
    expect(await sqlRepo.log({ n: 5, grep: "Weft-Chain-Head:" })).toEqual(await new GitRepo(gitRoot).log({ n: 5, grep: "Weft-Chain-Head:" }));
  }, 120_000);

  it("exports a fast-import stream that git imports into the same SHAs", { timeout: 60_000 }, async () => {
    const stream = await sqlRepo.exportFastImport();
    const fresh = tmp("weft-fastimport-");
    git(fresh, ["init", "-q"]);
    execFileSync("git", [...GIT_FLAGS, "-C", fresh, "fast-import", "--quiet"], { env: gitEnv(), input: stream });
    expect(git(fresh, ["rev-list", "--reverse", "refs/heads/main"]).trim().split("\n")).toEqual(commits);
    git(fresh, ["fsck", "--no-progress", "--no-dangling"]);
    // The git repo's own export round-trips too (the reference).
    const ref = await new GitRepo(gitRoot).exportFastImport();
    const again = tmp("weft-fastimport-ref-");
    git(again, ["init", "-q"]);
    execFileSync("git", [...GIT_FLAGS, "-C", again, "fast-import", "--quiet"], { env: gitEnv(), input: ref });
    expect(git(again, ["rev-parse", "refs/heads/main"]).trim()).toBe(commits.at(-1));
  });
});

// ---- transactions and selection -------------------------------------------------------------------------------------

describe("SqlRepo inside transactions", () => {
  it("a commit made inside a transaction that rolls back is rolled back too", { timeout: 30_000 }, async () => {
    const db = await sqlDb();
    const repo = new SqlRepo(db);
    const first = await repo.init([{ path: "a.md", text: "a\n" }], { message: "init", date: "2026-10-26T15:30:00.000Z" });
    await expect(withWriteLock(() => db.transaction(async () => {
      await repo.commit({ changes: [{ path: "b.md", text: "b\n" }], message: "inside", date: "2026-10-26T15:31:00.000Z" });
      expect(await repo.list()).toEqual(["a.md", "b.md"]);
      throw new Error("roll back");
    }))).rejects.toThrow("roll back");
    repo.clearCache();
    expect(await repo.head()).toBe(first);
    expect(await repo.list()).toEqual(["a.md"]);
    expect((await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM mem_log`))[0]!.n).toBe(1);
    // And one that commits stays.
    const second = await withWriteLock(() => db.transaction(async () => repo.commit({ changes: [{ path: "c.md", text: "c\n" }], message: "kept", date: "2026-10-26T15:32:00.000Z" })));
    expect(await repo.head()).toBe(second);
  });

  it("WEFT_MEMORY=sqlite with a Db selects SqlRepo; otherwise GitRepo", async () => {
    const db = await sqlDb();
    expect(memoryRepoFactory({ db, env: { WEFT_MEMORY: "sqlite" } })("/x", CMP).kind).toBe("sql");
    expect(memoryRepoFactory({ db, env: {} })("/x", CMP).kind).toBe("git");
    expect(memoryRepoFactory({ env: { WEFT_MEMORY: "sqlite" } })("/x", CMP).kind).toBe("git");
    expect(memoryRepoFactory({ repo: () => new SqlRepo(db), env: {} })("/x", CMP).kind).toBe("sql");
  });
});
