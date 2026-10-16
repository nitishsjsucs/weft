// /v1 offers routes. Owner: t2-world. POST /v1/offers/:id/accept runs people.accept_offer through the executor.
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { Unauthorized } from "@weft/contracts";
import { offers } from "@weft/db";
import { pageById, toOfferDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { parsePage, toPage } from "../http/paging";

export function offersRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/offers", async (c) => {
    const page = parsePage(c);
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const rows = await weft.db.select().from(offers).where(eq(offers.companyId, companyId));
    return c.json(toPage(pageById(rows, page).map(toOfferDto), page.limit));
  });
  // Demo control "Mark accepted": a human mutation through the executor, then a scheduler kick (SPEC 10).
  r.post("/v1/offers/:id/accept", async (c) => {
    const session = c.var.session;
    if (!session) throw new Unauthorized();
    const out = await weft.executor.human.exec(session, "people.accept_offer", { offer_id: c.req.param("id") });
    await weft.scheduler.kick();
    return c.json(out);
  });
  stubRoutes(r, "offers", ["GET /v1/offers", "POST /v1/offers/:id/accept"]);   // wave 2 routes answer 501 until the owning track lands them
  return r;
}
