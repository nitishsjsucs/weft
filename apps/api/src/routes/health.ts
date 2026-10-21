// GET /v1/health. Owner: t3-governance (working in the scaffold).
import { Hono } from "hono";
import type { Health } from "@weft/contracts";
import type { Weft, WeftEnv } from "../http/context";
import type { HealthSeedProfile } from "../../../../packages/contracts/src/ext/tour";
import type { HostedHealthFields } from "../../../../packages/contracts/src/ext/cf-hosted";
import { readSeedProfile } from "@weft/seed/profile";

export const API_VERSION = "0.0.0";

export function healthRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/health", async (c) => {
    const p = weft.provider;
    // Additive (Weft on Cloudflare, docs/cloudflare/design.md 11.6): the runtime and the slot and generation, on hosted only,
    // so Node's body is unchanged.
    const hosted: Partial<HostedHealthFields> = weft.platform?.kind === "durable" ? { runtime: "cloudflare", ...(weft.platform.world ? { world: weft.platform.world } : {}) } : {};
    const body: Health & HealthSeedProfile & Partial<HostedHealthFields> = {
      ok: true, version: API_VERSION,
      provider: { id: p.id, model: p.model, label: p.label, live: p.live },
      clock: { now: weft.clock.now(), rate: weft.clock.rate() },
      testMode: weft.testMode, stubs: [...weft.stubs],
      // Additive (tour): which seed profile this world was built with.
      seedProfile: await readSeedProfile(weft.db),
      ...hosted,
    };
    return c.json(body);
  });
  return r;
}
