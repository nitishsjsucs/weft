// /v1 contractors routes (wave 2, docs/wave2.md). Owner: w2-benefits-contractors. Replace the 501 stubs with handlers; paths come from packages/contracts/src/api.ts.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function contractorsRoutes(_weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  return stubRoutes(r, "contractors");
}
