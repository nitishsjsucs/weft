// /v1 settings routes (SPEC 10): permissions view and agent grants. Owner: t3-governance. Grant changes are human
// only (UI session, admin), audited as an action row. Approve is never effective for agents.
import { Hono } from "hono";
import { stubRoutes } from "../http/stub";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Forbidden, Unauthorized } from "@weft/contracts";
import { agentGrants, limits, principals, settings } from "@weft/db";
import { adminChange, AdminRefused, executorInternals } from "@weft/executor";
import type { Weft, WeftEnv } from "../http/context";
import { kick } from "./proposals";

const DOMAINS = ["people", "payroll", "tax", "benefits", "it", "comms", "company"] as const;

async function permissions(weft: Weft, companyId: string) {
  const ps = await weft.db.select().from(principals).where(eq(principals.companyId, companyId));
  const ag = await weft.db.select().from(agentGrants).where(eq(agentGrants.companyId, companyId));
  const lim = await weft.db.select().from(limits).where(eq(limits.companyId, companyId));
  const [second] = await weft.db.select().from(settings).where(eq(settings.key, "require_second_approver"));
  return {
    principals: ps.map((p) => ({ id: p.id, kind: p.kind, display: p.display, role: p.role, grants: JSON.parse(p.grantsJson) as Record<string, string> })),
    agentGrants: Object.fromEntries(ag.map((g) => [g.domain, g.level])),
    limits: Object.fromEntries(lim.map((l) => [l.key, l.cents])),
    requireSecondApprover: second ? JSON.parse(second.valueJson) === true : false,
    viewingAsNote: "The Viewing as switcher is a demo control that defeats SELF_APPROVAL by design.",
  };
}

export function settingsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();
  r.get("/v1/settings/permissions", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    return c.json(await permissions(weft, s.companyId));
  });
  r.put("/v1/settings/agent-grants", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const body = z.object({ grants: z.partialRecord(z.enum(DOMAINS), z.enum(["none", "view", "edit"])) }).parse(await c.req.json().catch(() => ({})));
    const e = executorInternals(weft.executor)?.engine;
    if (!e) throw new Forbidden("executor unavailable");
    try {
      await adminChange(e, s, "settings.set_agent_grants", body.grants, `Changed agent grants for ${Object.keys(body.grants).sort().join(", ")}`, async (tx) => {
        for (const [domain, level] of Object.entries(body.grants)) {
          await tx.insert(agentGrants).values({ companyId: s.companyId, domain, level }).onConflictDoUpdate({ target: [agentGrants.companyId, agentGrants.domain], set: { level } });
        }
        return null;
      });
    } catch (err) {
      if (err instanceof AdminRefused) throw new Forbidden(err.message, { code: err.code });
      throw err;
    }
    await kick(weft);
    return c.json(await permissions(weft, s.companyId));
  });
  return stubRoutes(r, "settings", ["GET /v1/settings/permissions", "PUT /v1/settings/agent-grants"]);   // wave 3 rows answer 501 until w3-parity-routines lands them
}
