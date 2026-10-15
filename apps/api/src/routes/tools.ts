// /v1 tools routes (SPEC 9.8). Owner: t3-governance. GET lists registry entries for a surface; POST executes as the
// caller's principal. The surface comes from the API key's bound scope, never from the request.
import { Hono } from "hono";
import { Unauthorized, ValidationError } from "@weft/contracts";
import { executorInternals, wireName } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";
import { kick, redactJson } from "./proposals";

export interface ToolListing { name: string; registryName: string; description: string; parameters: Record<string, unknown>; tier: string; mcp: "hidden" | "read" | "propose"; effect: string }

export function toolsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  r.get("/v1/tools", (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const surface = s.keyScope === "mcp" ? "mcp" : (c.req.query("surface") ?? "main");
    if (surface !== "mcp" && surface !== "main") throw new ValidationError("surface is mcp or main");
    const reg = executorInternals(weft.executor)?.engine.registry;
    if (!reg) return c.json([]);
    const out: ToolListing[] = [];
    for (const d of reg.all()) {
      if (d.access !== "all") continue;
      if (surface === "mcp" ? d.mcp === "hidden" : d.tiers.main === "unavailable") continue;
      out.push({ name: wireName(d.name), registryName: d.name, description: d.description, parameters: reg.schema(d.name), tier: d.tiers.main, mcp: d.mcp, effect: d.effect });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return c.json(out);
  });

  r.post("/v1/tools/:name", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const args = await c.req.json().catch(() => ({}));
    const outcome = await weft.executor.human.exec(s, c.req.param("name"), args ?? {});
    await kick(weft);
    if (!outcome.ok) return c.json({ ...outcome, _tag: "Refused", code: outcome.refusal.code, message: outcome.refusal.message }, 422);
    return c.json(redactJson(weft, outcome));
  });
  return r;
}
