// /v1 tax routes. Owner: t2-world. Replace the 501 stubs with handlers; keep the paths of packages/contracts/src/api.ts.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function taxRoutes(_weft: Weft): Hono<WeftEnv> {
  return stubRoutes(new Hono<WeftEnv>(), "tax");
}
