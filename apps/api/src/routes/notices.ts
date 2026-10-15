// /v1 notices routes. Owner: t2-world. The inbox omits bodies; the detail returns the body as text.
import { Hono } from "hono";
import { z } from "zod";
import { NotFound } from "@weft/contracts";
import { getNotice, listNotices, pageById, toNoticeDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";

const Status = z.enum(["new", "in_review", "proposed", "resolved", "escalated"]).optional();

export function noticesRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/notices", async (c) => {
    const status = Status.parse(c.req.query("status"));
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await listNotices(weft.db, companyId, status);
    return c.json(toPage(pageById(rows, page).map((n) => toNoticeDto(n, false)), page.limit));
  });
  r.get("/v1/notices/:id", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const n = await getNotice(weft.db, companyId, c.req.param("id"));
    if (!n) throw new NotFound(`No notice ${c.req.param("id")}`);
    return c.json(toNoticeDto(n, true));
  });
  return r;
}
