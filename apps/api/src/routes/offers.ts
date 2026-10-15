// /v1 offers routes. Owner: t2-world. POST /v1/offers/:id/accept runs people.accept_offer through the executor.
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { offers } from "@weft/db";
import { pageById, toOfferDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";
import { stubRoutes } from "../http/stub";

export function offersRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/offers", async (c) => {
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await weft.db.select().from(offers).where(eq(offers.companyId, companyId));
    return c.json(toPage(pageById(rows, page).map(toOfferDto), page.limit));
  });
  return stubRoutes(r, "offers", ["GET /v1/offers"]);
}
