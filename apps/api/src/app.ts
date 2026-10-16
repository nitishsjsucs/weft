// Scaffold (frozen): builds the Hono app and mounts every route module of SPEC 10.
import { Hono } from "hono";
import type { Weft, WeftEnv } from "./http/context";
import { auth } from "./http/auth";
import { notFoundResponse, toErrorResponse } from "./http/errors";
import { healthRoutes } from "./routes/health";
import { companyRoutes } from "./routes/company";
import { statsRoutes } from "./routes/stats";
import { workersRoutes } from "./routes/workers";
import { offersRoutes } from "./routes/offers";
import { payrollsRoutes } from "./routes/payrolls";
import { taxRoutes } from "./routes/tax";
import { noticesRoutes } from "./routes/notices";
import { benefitsRoutes } from "./routes/benefits";
import { itRoutes } from "./routes/it";
import { proposalsRoutes } from "./routes/proposals";
import { actionsRoutes } from "./routes/actions";
import { toolsRoutes } from "./routes/tools";
import { memoryRoutes } from "./routes/memory";
import { eventsRoutes } from "./routes/events";
import { settingsRoutes } from "./routes/settings";
import { apiKeysRoutes } from "./routes/api-keys";
import { agentRoutes } from "./routes/agent";
import { routinesRoutes } from "./routes/routines";
import { simRoutes } from "./routes/sim";
import { portalRoutes } from "./routes/portal";
import { documentsRoutes } from "./routes/documents";
import { offboardingRoutes } from "./routes/offboarding";
import { contractorsRoutes } from "./routes/contractors";
import { expensesRoutes } from "./routes/expenses";
import { timeOffRoutes } from "./routes/time-off";
import { reportsRoutes } from "./routes/reports";
import { integrationsRoutes } from "./routes/integrations";
import { screeningRoutes } from "./routes/screening";

export const ROUTE_MODULES = [
    healthRoutes,
    companyRoutes,
    statsRoutes,
    workersRoutes,
    offersRoutes,
    payrollsRoutes,
    taxRoutes,
    noticesRoutes,
    benefitsRoutes,
    itRoutes,
    proposalsRoutes,
    actionsRoutes,
    toolsRoutes,
    memoryRoutes,
    eventsRoutes,
    settingsRoutes,
    apiKeysRoutes,
    agentRoutes,
    routinesRoutes,
    simRoutes,
    portalRoutes,
    documentsRoutes,
    offboardingRoutes,
    contractorsRoutes,
    expensesRoutes,      // wave 3
    timeOffRoutes,
    reportsRoutes,
    integrationsRoutes,
    screeningRoutes,
] as const;

export function buildApp(weft: Weft): Hono<WeftEnv> {
  const app = new Hono<WeftEnv>();
  app.onError((err, c) => toErrorResponse(err, c));
  app.notFound((c) => notFoundResponse(c));
  app.use("*", async (c, next) => { c.set("weft", weft); c.set("session", null); await next(); });
  app.use("/v1/*", auth());
  for (const mod of ROUTE_MODULES) app.route("/", mod(weft));
  return app;
}
