// /v1 benefits routes. Owner: t2-world. Replace the 501 stubs with handlers; keep the paths of packages/contracts/src/api.ts.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function benefitsRoutes(_weft: Weft): Hono<WeftEnv> {
  return stubRoutes(new Hono<WeftEnv>(), "benefits");
}
