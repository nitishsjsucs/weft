// /v1 tax routes. Owner: t2-world. Registrations table and effective-dated employer rates (history included).
import { Hono } from "hono";
import { z } from "zod";
import { listRates, listTaxAccounts, toRateDto, toTaxAccountDto } from "@weft/core";
import type { Weft, WeftEnv } from "../http/context";

const Jurisdiction = z.enum(["US", "CA", "NY", "TX", "CO"]).optional();

export function taxRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/tax/accounts", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    return c.json((await listTaxAccounts(weft.db, companyId)).map(toTaxAccountDto));
  });
  r.get("/v1/tax/rates", async (c) => {
    const companyId = c.var.session?.companyId ?? "cmp_larkspur";
    const jurisdiction = Jurisdiction.parse(c.req.query("jurisdiction"));
    return c.json((await listRates(weft.db, companyId, { jurisdiction, includeSuperseded: true })).map(toRateDto));
  });
  return r;
}
