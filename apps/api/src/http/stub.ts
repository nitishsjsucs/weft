import type { Hono } from "hono";
import { NotImplemented, ROUTES, type RouteFile } from "@weft/contracts";
import type { WeftEnv } from "./context";

/** Registers a 501 NotImplemented handler for every route of `file` in the contracts route table. */
export function stubRoutes(r: Hono<WeftEnv>, file: RouteFile, except: readonly string[] = []): Hono<WeftEnv> {
  for (const def of ROUTES) {
    if (def.file !== file || except.includes(`${def.method} ${def.path}`)) continue;
    r.on(def.method, def.path, () => { throw new NotImplemented(`${def.method} ${def.path} (${def.owner})`); });
  }
  return r;
}
