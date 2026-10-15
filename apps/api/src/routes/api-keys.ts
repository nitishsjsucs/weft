// POST /v1/api-keys (SPEC 10): create a scoped key, shown once. Owner: t3-governance. UI session and admin only;
// the plaintext joins the redactor at creation and only its sha256 is stored.
import { Hono } from "hono";
import { z } from "zod";
import { Forbidden, Unauthorized } from "@weft/contracts";
import { AdminRefused, createApiKey, executorInternals } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";

export function apiKeysRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.post("/v1/api-keys", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const body = z.object({ label: z.string().min(1).max(60), scope: z.enum(["mcp", "cli", "admin"]) }).parse(await c.req.json().catch(() => ({})));
    const e = executorInternals(weft.executor)?.engine;
    if (!e) throw new Forbidden("executor unavailable");
    try {
      const key = await createApiKey(e, s, body);
      return c.json({ ...key, note: "Shown once. Weft stores only a hash of this key." }, 201);
    } catch (err) {
      if (err instanceof AdminRefused) throw new Forbidden(err.message, { code: err.code });
      throw err;
    }
  });
  return r;
}
