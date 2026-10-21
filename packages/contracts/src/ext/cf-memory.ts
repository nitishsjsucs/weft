// Weft on Cloudflare, round 0 contract (track cf0-contracts; docs/cloudflare/design.md 4.1 and 4.3). Additive only.
// The memory repository port under the memory store (harness 6.7 and 9). GitRepo wraps today's hardened git CLI;
// SqlRepo writes real git blob, tree and commit objects into mem_objects, mem_refs and mem_log, so with the same
// inputs both give the same commit SHAs byte for byte. The store keeps every path rule, the PII and secret refusals,
// the tainted-run refusal and the Weft-Chain-Head trailers in shared code above this port. Implemented by cf1-db in
// packages/executor/src/memory (GitRepo, SqlRepo, gitobj.ts and store.ts over the port). Types and constants only.
import type { MemoryFolder } from "../memory";

export type MemoryRepoKind = "git" | "sql";
/** `WEFT_MEMORY=sqlite` selects SqlRepo on Node (unused otherwise); the durable platform always uses SqlRepo. */
export const WEFT_MEMORY_SQLITE = "sqlite";

export type GitObjectType = "blob" | "tree" | "commit";
/** The only ref either repo writes. */
export const MEMORY_MAIN_REF = "refs/heads/main";

export interface MemoryAuthor { name: string; email: string }

/** One commit's worth of changes. Every write commits at once, so there is never an uncommitted working tree. */
export interface MemoryCommitInput {
  /** Files to create or replace (text) or remove (null). Paths are normalized repo-relative paths with "/". */
  changes: ReadonlyArray<{ path: string; text: string | null }>;
  message: string;
  /** Defaults to the committer, Weft Agent <agent@weft.example>. */
  author?: MemoryAuthor;
  /** Sim-clock ISO time. Author and committer dates are "@<epoch seconds> +0000", so SHAs are reproducible. */
  date: string;
}

export interface MemoryGrepQuery {
  /** Fixed strings (never patterns), any of which matches a line, as `git grep --fixed-strings -e t1 -e t2`. */
  terms: readonly string[];
  folders: readonly MemoryFolder[];
  /** A 40-hex commit; HEAD when absent. */
  at?: string;
  /** ASCII case folding, as `git grep -i`. */
  ignoreCase?: boolean;
  /** Matching paths only (one entry per file, line 0), as `git grep -l`. */
  filesOnly?: boolean;
}
/** In git grep's order: by path, then by line. */
export interface MemoryGrepLine { path: string; line: number; text: string }

export interface MemoryLogQuery {
  n: number;
  /** Only commits that touch this path. */
  path?: string;
  /** Only commits whose message contains this fixed string, as `git log --grep` on a plain string. */
  grep?: string;
  /** Include the commit's unified diff (limited to `path` when given), as `git log -p --no-color --no-ext-diff`. */
  patch?: boolean;
}
export interface MemoryLogEntry {
  commit: string;
  parent: string | null;
  /** Committer date in git's strict ISO form (`%cI` as git 2.45.0 and later print it), for example 2026-10-26T15:30:00Z. */
  date: string;
  author: string;
  subject: string;
  /** The whole message (`%B`), trailers included. */
  body: string;
  diff?: string;
}

/**
 * The repository port. The store calls it under its own serial lock, so implementations need not serialize. Commit
 * ids, `list`, `read`, `grep` and `log` output must match between GitRepo and SqlRepo for the same history (cf1's
 * acceptance compares HEAD, all 36 rich-world commit SHAs, search, read-at, history, tree and recall output).
 */
export interface MemoryRepo {
  readonly kind: MemoryRepoKind;
  exists(): Promise<boolean>;
  /** Creates the repository holding `files` in one commit and returns that commit. */
  init(files: ReadonlyArray<{ path: string; text: string }>, meta: Omit<MemoryCommitInput, "changes">): Promise<string>;
  head(): Promise<string>;
  /** File text at HEAD or at a commit; null when the path does not exist there. */
  read(path: string, at?: string): Promise<string | null>;
  /** Tracked paths at HEAD or at a commit, sorted as `git ls-files` sorts them. */
  list(opts?: { prefix?: string; at?: string }): Promise<string[]>;
  /** Applies the changes and commits; null (and no commit) when the tree would not change. */
  commit(input: MemoryCommitInput): Promise<string | null>;
  grep(q: MemoryGrepQuery): Promise<MemoryGrepLine[]>;
  /** Newest first. */
  log(q: MemoryLogQuery): Promise<MemoryLogEntry[]>;
  /** A `git fast-import` stream of the whole history; importing it into an empty repo reproduces every SHA. */
  exportFastImport(): Promise<Uint8Array>;
}

/** The hosted tables SqlRepo owns (migration 0008_hosted.sql). `mem_log.chain_seq` and `chain_hash` mirror the
 * commit's Weft-Chain-Head trailer, so verifyChain reads the git lag without parsing messages. */
export const MEMORY_TABLES = ["mem_objects", "mem_refs", "mem_log"] as const;
