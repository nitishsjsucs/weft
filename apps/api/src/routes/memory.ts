// /v1 memory routes (SPEC 10): a read-only memory browser. Owner: t3-governance; wave 2 memory (w2-memory) binds
// recall and the digest here and adds the links view.
import { Hono } from "hono";
import { Unauthorized, ValidationError, type MemoryFolder } from "@weft/contracts";
import { MEMORY_FOLDERS, MemoryError } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";
import { redactJson } from "./proposals";
import { bindMemory } from "../memory/binding";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof MemoryError) throw new ValidationError(e.message, { code: e.code });
    throw e;
  }
}

export function memoryRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  const bound = bindMemory(weft);
  r.get("/v1/memory/tree", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    return c.json(await guard(() => weft.executor.memory.tree(c.req.query("prefix") || undefined)));
  });
  r.get("/v1/memory/file", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const path = c.req.query("path") ?? "";
    const doc = await guard(() => weft.executor.memory.read(path, c.req.query("at") || undefined));
    if (!doc) return c.json({ _tag: "NotFound", message: `No memory file ${path}` }, 404);
    const links = bound && !c.req.query("at") ? await bound.memory.links(path).catch(() => null) : null;
    return c.json(redactJson(weft, { path, frontmatter: doc.frontmatter, body: doc.body, ...(links ? { links } : {}) }));
  });
  // Wave 2 (w2-memory): per-file git log with diffs for the read-only memory browser. Route table row requested
  // in .scratch/contract-requests/w2-memory.md.
  r.get("/v1/memory/history", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    if (!bound) return c.json({ _tag: "NotImplemented", message: "memory history is not available" }, 501);
    const limit = Number(c.req.query("limit") ?? 20);
    const path = c.req.query("path") ?? "";
    return c.json(redactJson(weft, await guard(() => bound.memory.history(path, Number.isFinite(limit) ? limit : 20))));
  });
  r.get("/v1/memory/search", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const folders = c.req.query("folders") ? (c.req.query("folders")!.split(",") as MemoryFolder[]) : null;
    if (folders && folders.some((f) => !MEMORY_FOLDERS.includes(f))) throw new ValidationError("folders are entities, comms, timeline, workstreams, knowledge");
    const limit = Number(c.req.query("limit") ?? 10);
    const hits = await guard(() => weft.executor.memory.search({ query: c.req.query("q") ?? "", folders, at: c.req.query("at") ?? null, limit: Number.isFinite(limit) ? limit : 10 }));
    return c.json(redactJson(weft, hits));
  });
  return r;
}
