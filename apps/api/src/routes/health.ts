// GET /v1/health. Owner: t3-governance (working in the scaffold).
import { Hono } from "hono";
import type { Health } from "@weft/contracts";
import type { Weft, WeftEnv } from "../http/context";

export const API_VERSION = "0.0.0";

export function healthRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/health", (c) => {
    const p = weft.provider;
    const body: Health = {
      ok: true, version: API_VERSION,
      provider: { id: p.id, model: p.model, label: p.label, live: p.live },
      clock: { now: weft.clock.now(), rate: weft.clock.rate() },
      testMode: weft.testMode, stubs: [...weft.stubs],
    };
    return c.json(body);
  });
  return r;
}
