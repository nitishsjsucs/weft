// /v1 reports routes (wave 3, docs/wave3.md). Owner: w3-parity-chat. Paths come from packages/contracts/src/api.ts.
// GET /v1/reports/:metric runs reports.query through the executor's human surface, so the caller's grants, the
// metric's data domain and the redactor apply exactly as they do for the agent.
import { Hono } from "hono";
import { ReportMetric, Unauthorized, ValidationError } from "@weft/contracts";
import type { Weft, WeftEnv } from "../http/context";
import { stubRoutes } from "../http/stub";
import { redactJson } from "./proposals";

export function reportsRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  r.get("/v1/reports/:metric", async (c) => {
    const s = c.var.session;
    if (!s) throw new Unauthorized();
    const metric = ReportMetric.safeParse(c.req.param("metric"));
    if (!metric.success) throw new ValidationError(`metric is one of ${ReportMetric.options.join(", ")}`);
    const groupBy = c.req.query("groupBy") ?? c.req.query("group_by");
    if (groupBy !== undefined && groupBy !== "month" && groupBy !== "quarter") throw new ValidationError("groupBy is month or quarter");
    const args: Record<string, unknown> = { metric: metric.data };
    if (c.req.query("from")) args.from = c.req.query("from");
    if (c.req.query("to")) args.to = c.req.query("to");
    if (groupBy) args.group_by = groupBy;
    const outcome = await weft.executor.human.exec(s, "reports.query", args);
    if (!outcome.ok) return c.json(redactJson(weft, { _tag: "Refused", code: outcome.refusal.code, message: outcome.refusal.message }), outcome.refusal.code === "NOT_PERMITTED" ? 403 : 422);
    if (outcome.status !== "done") throw new ValidationError("reports.query does not propose");
    return c.json(redactJson(weft, outcome.data));
  });

  return stubRoutes(r, "reports", ["GET /v1/reports/:metric"]);
}
