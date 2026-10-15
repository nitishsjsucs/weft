// /v1 events route (SPEC 10): the activity feed, id-only payloads. Owner: t3-governance.
import { Hono } from "hono";
import { and, asc, eq, gt, type SQL } from "drizzle-orm";
import { Unauthorized, type EventRow } from "@weft/contracts";
import { events } from "@weft/db";
import type { Weft, WeftEnv } from "../http/context";
import { parsePage, toPage } from "../http/paging";
import { redactJson } from "./proposals";

export function eventsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/events", async (c) => {
    if (!c.var.session) throw new Unauthorized();
    const page = parsePage(c);
    const conds: SQL[] = [];
    if (page.afterId) conds.push(gt(events.id, page.afterId));
    const type = c.req.query("type");
    if (type) conds.push(eq(events.type, type));
    const rows = await weft.db.select().from(events).where(conds.length ? and(...conds) : undefined).orderBy(asc(events.id)).limit(page.limit + 1);
    const data: EventRow[] = rows.map((e) => ({ id: e.id, type: e.type, ts: e.ts, subjectRef: e.subjectRef, payload: JSON.parse(e.payloadJson) as Record<string, string>, attended: e.attended, requestedBy: e.requestedBy }));
    // Payloads are id-only by contract; the redactor still runs so a command that slips a secret in never leaks it.
    return c.json(redactJson(weft, toPage(data, page.limit)));
  });
  return r;
}
