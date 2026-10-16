// /v1 screening routes (wave 3, docs/wave3.md). Owner: w3-integrations-screening-esign. Paths come from packages/contracts/src/api.ts.
// Every route answers 501 until the owner registers real handlers before stubRoutes and lists them in `except`.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";

export function screeningRoutes(_weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  return stubRoutes(r, "screening");
}
