// /v1 it routes. Owner: t2-world.
import { Hono } from "hono";
import { listDevices, listItAccounts, pageById, toDeviceDto, toItAccountDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";
import { needDomain, viewerScope } from "../http/scope";

export function itRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/it/accounts", async (c) => {
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    needDomain(await viewerScope(weft, c), "it", "IT accounts");
    const rows = await listItAccounts(weft.db, companyId, c.req.query("workerId") || undefined);
    return c.json(toPage(pageById(rows, page).map(toItAccountDto), page.limit));
  });
  r.get("/v1/it/devices", async (c) => {
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    needDomain(await viewerScope(weft, c), "it", "devices");
    const rows = await listDevices(weft.db, companyId, c.req.query("workerId") || undefined);
    return c.json(toPage(pageById(rows, page).map(toDeviceDto), page.limit));
  });
  return r;
}
