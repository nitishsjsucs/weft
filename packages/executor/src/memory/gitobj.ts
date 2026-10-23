// Git objects in plain TypeScript (docs/cloudflare/design.md 4.1 and 4.3): blob, tree and commit bodies and their
// SHA-1 ids exactly as git writes them, so the SQL memory repo (repo-sql.ts) produces the same commit ids as the git
// CLI for the same files, messages, authors and sim-clock dates. No node:fs, no child process: it runs in a Durable
// Object too.
import { createHash } from "node:crypto";
import type { GitObjectType, MemoryAuthor } from "../../../contracts/src/ext/cf-memory";

export const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
export const FILE_MODE = "100644";
export const TREE_MODE = "40000";

const enc = new TextEncoder();
export const utf8 = (s: string) => enc.encode(s);
const dec = new TextDecoder();
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);

export interface GitObject { sha: string; type: GitObjectType; body: Uint8Array }

/** The object id: sha1 of "<type> <size>\0" followed by the body. */
export function objectSha(type: GitObjectType, body: Uint8Array): string {
  return createHash("sha1").update(utf8(`${type} ${body.byteLength}\0`)).update(body).digest("hex");
}

export function gitObject(type: GitObjectType, body: Uint8Array): GitObject {
  return { sha: objectSha(type, body), type, body };
}

export const blob = (text: string | Uint8Array) => gitObject("blob", typeof text === "string" ? utf8(text) : text);

export interface TreeEntry { mode: typeof FILE_MODE | typeof TREE_MODE; name: string; sha: string }

const nameBytes = (e: TreeEntry) => utf8(e.mode === TREE_MODE ? `${e.name}/` : e.name);
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** git's tree order: by name bytes, a subtree compared as if its name ended in "/". */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((x, y) => compareBytes(nameBytes(x), nameBytes(y)));
}

export function tree(entries: readonly TreeEntry[]): GitObject {
  const parts: Uint8Array[] = [];
  for (const e of sortTreeEntries(entries)) {
    parts.push(utf8(`${e.mode} ${e.name}\0`));
    parts.push(hexBytes(e.sha));
  }
  return gitObject("tree", concat(parts));
}

export function parseTree(body: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const nul = body.indexOf(0, sp);
    const mode = fromUtf8(body.subarray(i, sp));
    const name = fromUtf8(body.subarray(sp + 1, nul));
    const sha = Array.from(body.subarray(nul + 1, nul + 21), (b) => b.toString(16).padStart(2, "0")).join("");
    out.push({ mode: mode === TREE_MODE ? TREE_MODE : FILE_MODE, name, sha });
    i = nul + 21;
  }
  return out;
}

/** git's signature line: "Name <email> <epoch seconds> +0000" (dates come from the sim clock in UTC). */
export function signature(who: MemoryAuthor, iso: string): string {
  return `${who.name} <${who.email}> ${Math.floor(Date.parse(iso) / 1000)} +0000`;
}

/**
 * The message as `git commit -m` stores it (cleanup mode "whitespace" when the message is not edited): trailing
 * whitespace stripped from every line, leading and trailing blank lines dropped, runs of blank lines collapsed to
 * one, and a final newline. Comment lines are kept in this mode.
 */
export function cleanupMessage(message: string): string {
  const lines = message.split("\n").map((l) => l.replace(/[ \t\r\f\v]+$/, ""));
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.length ? `${out.join("\n")}\n` : "";
}

export interface CommitFields { tree: string; parent: string | null; author: MemoryAuthor; committer: MemoryAuthor; date: string; message: string }

export function commit(f: CommitFields): GitObject {
  const head = [`tree ${f.tree}`, ...(f.parent ? [`parent ${f.parent}`] : []), `author ${signature(f.author, f.date)}`, `committer ${signature(f.committer, f.date)}`];
  return gitObject("commit", utf8(`${head.join("\n")}\n\n${cleanupMessage(f.message)}`));
}

export interface ParsedCommit { tree: string; parent: string | null; author: { name: string; email: string; epoch: number; tz: string }; committer: { name: string; email: string; epoch: number; tz: string }; message: string }

const SIG = /^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/;
export function parseCommit(body: Uint8Array): ParsedCommit {
  const text = fromUtf8(body);
  const split = text.indexOf("\n\n");
  const headers = (split >= 0 ? text.slice(0, split) : text).split("\n");
  const message = split >= 0 ? text.slice(split + 2) : "";
  let treeSha = "";
  let parent: string | null = null;
  const sig = (s: string) => { const m = SIG.exec(s); if (!m) throw new Error(`bad signature ${s}`); return { name: m[1]!, email: m[2]!, epoch: Number(m[3]), tz: m[4]! }; };
  let author = { name: "", email: "", epoch: 0, tz: "+0000" };
  let committer = author;
  for (const h of headers) {
    if (h.startsWith("tree ")) treeSha = h.slice(5);
    else if (h.startsWith("parent ")) parent = parent ?? h.slice(7);
    else if (h.startsWith("author ")) author = sig(h.slice(7));
    else if (h.startsWith("committer ")) committer = sig(h.slice(10));
  }
  return { tree: treeSha, parent, author, committer, message };
}

/** git's %cI: strict ISO 8601 in the commit's own zone; git 2.45.0 and later write a zero offset as "Z", for
 * example 2026-10-26T15:30:00Z (older git wrote "+00:00"), and any other offset as +hh:mm. GitRepo formats its dates
 * with this function too, so both repositories print the same text whatever the installed git. */
export function strictIso(epoch: number, tz: string): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const d = new Date((epoch + minutes * 60) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const zone = minutes === 0 ? "Z" : `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${zone}`;
}

/** git's %s: the first paragraph of the message, each line right-trimmed, joined with spaces. */
export function subjectOf(message: string): string {
  const out: string[] = [];
  for (const line of message.split("\n")) {
    const l = line.replace(/\s+$/, "");
    if (!l) break;
    out.push(l);
  }
  return out.join(" ");
}

export function hexBytes(sha: string): Uint8Array {
  const out = new Uint8Array(sha.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(sha.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
