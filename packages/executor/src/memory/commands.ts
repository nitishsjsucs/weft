// memory.search, memory.read, memory.write_note, vault.list and vault.request (SPEC 9.2, harness 5.6, 6.7, 9).
// write_note and vault.request are refused in tainted runs (TAINTED_WRITE, in policy()).
import { posix } from "node:path";
import { z } from "zod";
import { MODEL_WRITE_DENY, MODEL_WRITE_PREFIXES, type MemoryFolder } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { digestOf } from "../digest";
import type { Engine } from "../engine";
import { MEMORY_FOLDERS, MemoryError, normalizeMemoryPath } from "./store";

const base = {
  compactDescription: "", amountCents: null, ceilingKey: null, reversible: false as const, lease: null, sandbox: "hidden" as const, access: "all" as const,
  untrustedFields: [] as string[], afterPending: "run" as const, errorHints: {}, preview: null, autoAllow: "never" as const, approval: "never" as const,
  tiers: { main: "executable" as const, task: "executable" as const },
};
const folder = z.enum(MEMORY_FOLDERS as [MemoryFolder, ...MemoryFolder[]]);

/** Model write rules: exact prefixes, never the one-pager, .md, then the store's generic and realpath rules. */
export function modelWritePath(p: string): string {
  const n = normalizeMemoryPath(p);
  if (!MODEL_WRITE_PREFIXES.some((x) => n.startsWith(x))) throw new MemoryError("INVALID_INPUT", `notes go under ${MODEL_WRITE_PREFIXES.join(", ")}`);
  if ((MODEL_WRITE_DENY as readonly string[]).includes(n)) throw new MemoryError("INVALID_INPUT", `${n} is written by the digest only`);
  if (posix.normalize(p) !== p) throw new MemoryError("INVALID_INPUT", "path must already be normalized");
  return n;
}

export function memoryCommands(e: Engine): WeftCommand[] {
  const search: WeftCommand<{ query: string; folders?: MemoryFolder[]; at?: string; limit?: number }> = {
    ...base, name: "memory.search", namespace: "memory", summary: "Search company memory",
    description: "Search the company memory (Markdown in git) for a phrase. Returns hits with path, line, snippet and a cite like knowledge/procedures/x.md#L4. Example: { \"query\": \"SUI rate\", \"folders\": [\"knowledge\"] }",
    compactDescription: "Search memory for a phrase.",
    input: z.object({ query: z.string().min(1).max(200), folders: z.array(folder).optional(), at: z.string().optional(), limit: z.number().int().min(1).max(20).optional() }),
    domain: "company", needs: "view", effect: "read", risk: () => "R0", mcp: "read", sandbox: "read",
    errorHints: { INVALID_INPUT: { hint: "at is a 40-character hex commit; folders are entities, comms, timeline, workstreams, knowledge", example: { query: "SUI rate", folders: ["knowledge"] } } },
    async run(i) {
      const hits = await e.memory.search({ query: i.query, folders: i.folders ?? null, at: i.at ?? null, limit: i.limit ?? 10 });
      const tainted = hits.find((h) => h.taintedBy);
      const out = { data: { hits }, summary: `${hits.length} memory hits for the query` };
      return tainted ? Object.assign(out, { taintedBy: `memory:${tainted.path}`, untrusted: ["hits.snippet"] }) : out;
    },
  };
  const read: WeftCommand<{ path: string; at?: string }> = {
    ...base, name: "memory.read", namespace: "memory", summary: "Read one memory file",
    description: "Read one memory file by path (from memory.search). Returns frontmatter, body and links (outgoing wiki-links with whether each resolves, and the files that link here). Example: { \"path\": \"knowledge/procedures/state-sui-rate-notice.md\" }",
    compactDescription: "Read a memory file.",
    input: z.object({ path: z.string().min(1).max(200), at: z.string().optional() }), domain: "company", needs: "view", effect: "read", risk: () => "R0", mcp: "read", sandbox: "read",
    errorHints: { INVALID_INPUT: { hint: "use a path from memory.search", example: { path: "knowledge/procedures/state-sui-rate-notice.md" } } },
    async run(i) {
      const doc = await e.memory.read(i.path, i.at);
      if (!doc) throw new MemoryError("INVALID_INPUT", `No memory file ${i.path}`);
      const links = (e.memory as { links?: (p: string) => Promise<unknown> }).links && !i.at ? await (e.memory as unknown as { links(p: string): Promise<unknown> }).links(i.path).catch(() => null) : null;
      const out = { data: { path: i.path, frontmatter: doc.frontmatter, body: doc.body, ...(links ? { links } : {}) }, summary: `Read ${i.path}` };
      const untrusted = doc.frontmatter.taintedBy ?? (i.path.startsWith("knowledge/decisions/") ? `memory:${i.path}` : null);
      return untrusted ? Object.assign(out, { taintedBy: untrusted, untrusted: ["body"] }) : out;
    },
  };
  const writeNote: WeftCommand<{ path: string; title: string; body: string; sources: string[] }> = {
    ...base, name: "memory.write_note", namespace: "memory", summary: "Write a procedure, fact or workstream note",
    description: "Write a Markdown note under knowledge/procedures/, knowledge/facts/ or workstreams/. Fact bullets need (YYYY-MM-DD, src: ...). Never in a run that read untrusted content. Example: { \"path\": \"knowledge/procedures/x.md\", \"title\": \"X\", \"body\": \"1. ...\", \"sources\": [\"action:12\"] }",
    compactDescription: "Write a memory note.",
    input: z.object({ path: z.string().min(1).max(200), title: z.string().min(1).max(120), body: z.string().min(1).max(4000), sources: z.array(z.string().max(80)).max(10) }),
    domain: "company", needs: "view", effect: "draft", risk: () => "R1", mcp: "hidden",
    errorHints: { INVALID_INPUT: { hint: `paths start with ${MODEL_WRITE_PREFIXES.join(" or ")} and end in .md`, example: { path: "knowledge/procedures/state-sui-rate-notice.md", title: "SUI notices", body: "1. Read the notice.", sources: ["action:1"] } } },
    async run(i, ctx) {
      const path = modelWritePath(i.path);
      const type = path.startsWith("knowledge/procedures/") ? "procedure" : path.startsWith("knowledge/facts/") ? "fact" : "workstream";
      const { commit } = await e.memory.write({
        path, body: `# ${i.title}\n\n${i.body}\n`, message: `note: ${path}`, author: { name: "Weft Agent", email: "agent@weft.example" },
        frontmatter: { id: path.replace(/\.md$/, "").replace(/\//g, "-"), type, aliases: [], links: [], sources: i.sources, status: null, updated: ctx.now.slice(0, 10), taintedBy: null },
      });
      return { data: { path, commit }, summary: `Wrote memory note ${path}` };
    },
  };
  const vaultList: WeftCommand<Record<string, never>> = {
    ...base, name: "vault.list", namespace: "vault", summary: "List stored simulator credentials",
    description: "List the names and kinds of stored simulator credentials (never the values). Example: {}",
    compactDescription: "List vault names.", input: z.object({}), domain: "company", needs: "view", effect: "read", risk: () => "R0", mcp: "hidden",
    async run() { const rows = await e.vault.list(); return { data: { secrets: rows.map((r) => ({ name: r.name, kind: r.kind })) }, summary: `${rows.length} stored credentials` }; },
  };
  const vaultRequest: WeftCommand<{ name: string; kind: "portal_password" | "api_token"; reason: string }> = {
    ...base, name: "vault.request", namespace: "vault", summary: "Ask a human to store a simulator credential",
    description: "Ask a human to store a missing simulator credential. Creates a card; the human enters the value in the Weft app. Never in a run that read untrusted content. Example: { \"name\": \"co-dor-portal\", \"kind\": \"portal_password\", \"reason\": \"needed to register CO\" }",
    compactDescription: "Request a credential from a human.",
    input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), kind: z.enum(["portal_password", "api_token"]), reason: z.string().min(1).max(400) }),
    domain: "company", needs: "view", effect: "draft", risk: () => "R1", approval: "always", mcp: "hidden",
    errorHints: { INVALID_INPUT: { hint: "name is lowercase letters, digits and dashes; it must not exist yet", example: { name: "co-dor-portal", kind: "portal_password", reason: "needed to register CO" } } },
    async preview(i) {
      if (await e.vault.exists(i.name)) throw new MemoryError("INVALID_INPUT", `A credential named ${i.name} already exists`);
      return { title: `Store a simulator credential named ${i.name}`, diff: [], content: [{ label: "Note", text: "Weft stores simulator credentials only; never enter a real password." }],
        moneyCents: null, subjectRef: `vault:${i.name}`, subjectHash: digestOf({ name: i.name }), evidence: [] };
    },
    async run(i) { return { data: { name: i.name, requested: true }, summary: `Requested credential ${i.name}` }; },
  };
  return [search, read, writeNote, vaultList, vaultRequest] as WeftCommand[];
}
