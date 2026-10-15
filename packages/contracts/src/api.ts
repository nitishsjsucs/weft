// The /v1 route table (SPEC 10). One entry per method and path; `res` names the zod schema in domain.ts or approvals and trace types.
// Owners are track ids. apps/api mounts one Hono sub-app per `file`; apps/web's typed client is keyed by `${method} ${path}`.
export type Method = "GET" | "POST" | "PUT" | "DELETE";
export interface RouteDef { method: Method; path: string; file: RouteFile; owner: TrackId; query?: string[]; body?: string; res: string; auth: "public" | "any" | "ui_only" | "not_mcp"; mutates: boolean }
export type TrackId = "t1-payroll" | "t2-world" | "t3-governance" | "t4-agent" | "t5-app" | "t6-site";
export type RouteFile = "health" | "company" | "stats" | "workers" | "offers" | "payrolls" | "tax" | "notices" | "benefits" | "it" | "proposals" | "actions" | "tools" | "memory" | "events" | "settings" | "api-keys" | "agent" | "routines" | "sim";

const r = <M extends Method, P extends string, F extends RouteFile>(method: M, path: P, file: F, owner: TrackId, res: string, x: Partial<RouteDef> = {}) =>
  ({ owner, res, auth: "any", mutates: method !== "GET", ...x, method, path, file }) as RouteDef & { method: M; path: P; file: F };

export const ROUTES = [
  r("GET", "/v1/health", "health", "t3-governance", "Health", { auth: "public" }),
  r("GET", "/v1/company", "company", "t2-world", "CompanyBundle"),
  r("GET", "/v1/stats", "stats", "t2-world", "Stats", { auth: "public" }),
  r("GET", "/v1/workers", "workers", "t2-world", "Page<Worker>", { query: ["status", "state", "type", "limit", "afterId", "beforeId"] }),
  r("GET", "/v1/workers/:id", "workers", "t2-world", "WorkerDetail"),
  r("GET", "/v1/workers/:id/onboarding", "workers", "t2-world", "OnboardingTask[]"),
  r("GET", "/v1/offers", "offers", "t2-world", "Page<Offer>"),
  r("POST", "/v1/offers/:id/accept", "offers", "t2-world", "ToolOutcome", { auth: "not_mcp" }),
  r("GET", "/v1/payrolls", "payrolls", "t1-payroll", "Page<PayrollRun>"),
  r("GET", "/v1/payrolls/:id", "payrolls", "t1-payroll", "PayrollRun"),
  r("GET", "/v1/payrolls/:id/paychecks", "payrolls", "t1-payroll", "Page<Paycheck>", { query: ["group", "workerId", "state", "limit", "afterId"] }),
  r("GET", "/v1/paychecks/:id", "payrolls", "t1-payroll", "Paycheck"),
  r("POST", "/v1/payrolls/:id/preview", "payrolls", "t1-payroll", "ToolOutcome"),
  r("POST", "/v1/payrolls/:id/submit", "payrolls", "t1-payroll", "ToolOutcome", { body: "{ excludeBlocked: boolean }" }),
  r("POST", "/v1/payrolls/drafts", "payrolls", "t1-payroll", "ToolOutcome", { body: "{ payScheduleId, periodEnd }" }),
  r("GET", "/v1/tax/accounts", "tax", "t2-world", "TaxAccount[]"),
  r("GET", "/v1/tax/rates", "tax", "t2-world", "EmployerRate[]", { query: ["jurisdiction"] }),
  r("GET", "/v1/notices", "notices", "t2-world", "Page<Notice>", { query: ["status", "limit", "afterId"] }),
  r("GET", "/v1/notices/:id", "notices", "t2-world", "Notice"),
  r("GET", "/v1/benefits/plans", "benefits", "t2-world", "BenefitPlan[]"),
  r("GET", "/v1/benefits/enrollments", "benefits", "t2-world", "Page<Enrollment>", { query: ["workerId", "limit", "afterId"] }),
  r("GET", "/v1/it/accounts", "it", "t2-world", "Page<ItAccount>", { query: ["workerId", "limit", "afterId"] }),
  r("GET", "/v1/it/devices", "it", "t2-world", "Page<Device>"),
  r("GET", "/v1/proposals", "proposals", "t3-governance", "Page<Proposal>", { query: ["status", "kind", "limit", "afterId"] }),
  r("GET", "/v1/proposals/:id", "proposals", "t3-governance", "Proposal"),
  r("POST", "/v1/proposals/:id/approve", "proposals", "t3-governance", "DecisionResult", { auth: "ui_only", body: "{ reasonCode, note }" }),
  r("POST", "/v1/proposals/:id/deny", "proposals", "t3-governance", "DecisionResult", { auth: "ui_only", body: "{ reasonCode, note }" }),
  r("POST", "/v1/proposals/:id/dismiss", "proposals", "t3-governance", "DecisionResult", { auth: "ui_only" }),
  r("POST", "/v1/proposals/:id/start", "proposals", "t3-governance", "DecisionResult", { auth: "ui_only" }),
  r("GET", "/v1/actions", "actions", "t3-governance", "Page<Action>", { query: ["limit", "afterId", "beforeId", "runId"] }),
  r("GET", "/v1/actions/verify", "actions", "t3-governance", "ChainStatus"),
  r("GET", "/v1/actions/:seq", "actions", "t3-governance", "Action"),
  r("POST", "/v1/actions/:seq/rollback", "actions", "t3-governance", "ToolOutcome", { auth: "ui_only", body: "{ reason }" }),
  r("GET", "/v1/tools", "tools", "t3-governance", "ToolListing[]", { query: ["surface"] }),
  r("POST", "/v1/tools/:name", "tools", "t3-governance", "ToolOutcome"),
  r("GET", "/v1/memory/tree", "memory", "t3-governance", "string[]", { query: ["prefix"] }),
  r("GET", "/v1/memory/file", "memory", "t3-governance", "MemoryFile", { query: ["path", "at"] }),
  r("GET", "/v1/memory/search", "memory", "t3-governance", "MemoryHit[]", { query: ["q", "folders", "at", "limit"] }),
  r("GET", "/v1/events", "events", "t3-governance", "Page<EventRow>", { query: ["afterId", "limit", "type"] }),
  r("GET", "/v1/settings/permissions", "settings", "t3-governance", "Permissions", { auth: "not_mcp" }),
  r("PUT", "/v1/settings/agent-grants", "settings", "t3-governance", "Permissions", { auth: "ui_only" }),
  r("POST", "/v1/api-keys", "api-keys", "t3-governance", "CreatedApiKey", { auth: "ui_only", body: "{ label, scope }" }),
  r("POST", "/v1/agent/runs", "agent", "t4-agent", "{ runId }", { body: "{ text, pageContext, threadId }" }),
  r("GET", "/v1/agent/runs", "agent", "t4-agent", "Page<AgentRunRow>"),
  r("GET", "/v1/agent/runs/:id", "agent", "t4-agent", "AgentRunRow"),
  r("GET", "/v1/agent/runs/:id/events", "agent", "t4-agent", "SSE<RunStepRow>"),
  r("GET", "/v1/agent/runs/:id/trace", "agent", "t4-agent", "RunTrace"),
  r("GET", "/v1/agent/runs/:id/artifacts/:ref", "agent", "t4-agent", "Artifact"),
  r("POST", "/v1/agent/runs/:id/cancel", "agent", "t4-agent", "AgentRunRow"),
  r("GET", "/v1/agent/costs", "agent", "t4-agent", "CostRollup", { query: ["day"] }),
  r("GET", "/v1/routines", "routines", "t4-agent", "RoutineDef[]"),
  r("POST", "/v1/routines/draft", "routines", "t4-agent", "ToolOutcome", { body: "{ prompt }" }),
  r("GET", "/v1/routines/:id", "routines", "t4-agent", "RoutineDef"),
  r("GET", "/v1/routines/:id/runs", "routines", "t4-agent", "Page<RoutineRunDto>"),
  r("GET", "/v1/routine-runs/:id", "routines", "t4-agent", "RoutineRunDto"),
  r("POST", "/v1/routines/:id/trigger", "routines", "t4-agent", "{ routineRunId }"),
  r("POST", "/v1/routines/:id/enable", "routines", "t4-agent", "ToolOutcome", { auth: "ui_only" }),
  r("POST", "/v1/routines/:id/disable", "routines", "t4-agent", "ToolOutcome", { auth: "ui_only" }),
  r("GET", "/v1/sim/clock", "sim", "t2-world", "{ now, rate }", { auth: "not_mcp" }),
  r("POST", "/v1/sim/clock/advance", "sim", "t2-world", "{ now, rate }", { auth: "not_mcp", body: "{ to } | { by } | { toNext: 'cron' }" }),
  r("POST", "/v1/sim/notices/deliver", "sim", "t2-world", "ToolOutcome", { auth: "not_mcp", body: "{ scenario }" }),
  r("GET", "/v1/sim/state", "sim", "t2-world", "SimState", { auth: "not_mcp" }),
  r("POST", "/v1/sim/faults", "sim", "t2-world", "ArmedFault[]", { auth: "not_mcp", body: "{ target, kind, mode } | { target, disarm: true }" }),
  r("GET", "/v1/sim/chat", "sim", "t2-world", "ChatMessageDto[]", { auth: "not_mcp", query: ["channel", "afterId"] }),
  r("POST", "/v1/sim/reset", "sim", "t2-world", "{ ok }", { auth: "not_mcp" }),
] as const satisfies readonly RouteDef[];

export type RouteKey = `${(typeof ROUTES)[number]["method"]} ${(typeof ROUTES)[number]["path"]}`;
export const ROUTE_FILES = [...new Set(ROUTES.map((x) => x.file))] as RouteFile[];

/** Cursor paging (SPEC 10). */
export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 100;
export interface PageParams { limit: number; afterId: string | null; beforeId: string | null }
export interface PageResult<T> { hasMore: boolean; count: number; data: T[] }
