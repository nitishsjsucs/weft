// /v1 settings routes. Owner: t3-governance. Replace the 501 stubs with handlers; keep the paths of packages/contracts/src/api.ts.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function settingsRoutes(_weft: Weft): Hono<WeftEnv> {
  return stubRoutes(new Hono<WeftEnv>(), "settings");
}
