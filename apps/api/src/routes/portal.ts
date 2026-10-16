// /v1 portal routes (wave 2, docs/wave2.md). Owner: w2-onboarding. Replace the 501 stubs with handlers; paths come from packages/contracts/src/api.ts.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function portalRoutes(_weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  return stubRoutes(r, "portal");
}
