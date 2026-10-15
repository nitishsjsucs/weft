// /v1 memory routes (SPEC 10): a read-only memory browser. Owner: t3-governance.
import { Hono } from "hono";
import { Unauthorized, ValidationError, type MemoryFolder } from "@weft/contracts";
import { MEMORY_FOLDERS, MemoryError } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";
import { redactJson } from "./proposals";

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof MemoryError) throw new ValidationError(e.message, { code: e.code });
    throw e;
  }
}

export function memoryRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/memory/tree", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    return c.json(await guard(() => weft.executor.memory.tree(c.req.query("prefix") || undefined)));
  });
  r.get("/v1/memory/file", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const path = c.req.query("path") ?? "";
    const doc = await guard(() => weft.executor.memory.read(path, c.req.query("at") || undefined));
    if (!doc) return c.json({ _tag: "NotFound", message: `No memory file ${path}` }, 404);
    return c.json(redactJson(weft, { path, frontmatter: doc.frontmatter, body: doc.body }));
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
