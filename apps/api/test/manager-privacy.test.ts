// Manager read scope (packages/core/src/people/scope.ts): a manager reads full records only for themself and their
// direct and indirect reports; anyone else is directory fields only, and the result says what is withheld. Covers the
// chat agent acting for Imani, her own UI and MCP calls, the audit reads, the Workday and Greenhouse reads, the
// worker routes, and the domains her grants already close. Scripted provider only; nothing here calls a live model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CHAT_TOOLS_W3, type HumanSession, type ToolOutcome } from "@weft/contracts";
import { reportsUnder } from "@weft/core";
import { principals, workers } from "@weft/db";
import { registered } from "../src/agent/chat-allowlist";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
const PRIYA = "wrk_0003";   // VP Engineering, outside Imani's reports
const RUTH = "wrk_0010";    // Hardware, reports to Imani
const IMANI = "wrk_0004";
const session = (principalId: string, via: "ui" | "api" = "ui", keyScope: "mcp" | null = null): HumanSession =>
  ({ principalId, companyId: "cmp_larkspur", via, keyScope } as HumanSession);
const PAY = /amount_cents|amount_display|pay_rate_id|last4|filing_status|w4|ssn|\$\d/i;

function done<T = Record<string, unknown>>(o: ToolOutcome): T {
  if (!(o.ok && o.status === "done")) throw new Error(JSON.stringify(o).slice(0, 400));
  return o.data as T;
}

let n = 0;
async function chatAs(principalId: string) {
  const handle = await weft.executor.runs.openChatRun(session(principalId), { threadId: null, surface: "human_ui", allowlist: registered(weft.executor.registry, CHAT_TOOLS_W3)! });
  return (command: string, args: unknown) => weft.executor.agent.exec(handle, { callId: `m${++n}`, command, args });
}

beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

describe("reportsUnder walks the reporting chain", () => {
  it("collects direct and indirect reports, skips the root and survives a cycle", () => {
    const edges = [{ id: "a", managerId: null }, { id: "b", managerId: "a" }, { id: "c", managerId: "b" }, { id: "d", managerId: "c" }, { id: "x", managerId: "y" }, { id: "y", managerId: "x" }];
    expect([...reportsUnder(edges, "a")].sort()).toEqual(["b", "c", "d"]);
    expect([...reportsUnder(edges, "c")]).toEqual(["d"]);
    expect([...reportsUnder(edges, "x")]).toEqual(["y"]);
    expect(reportsUnder(edges, null).size).toBe(0);
  });
});

describe("people.get for a manager's chat run", () => {
  it("an outsider: directory fields only, with an access block that says what is withheld", async () => {
    const exec = await chatAs("usr_imani");
    const out = await exec("people.get", { worker_id: PRIYA, response_format: "detailed" });
    const w = done<{ worker: Record<string, unknown> }>(out).worker;
    expect(Object.keys(w).sort()).toEqual(["access", "department", "id", "manager", "name", "title", "work_state"]);
    expect(w.name).toContain("Priya Raman");
    expect(w.access).toMatchObject({ scope: "directory", withheld: ["pay", "bank account", "W-4", "benefits elections", "ID numbers"] });
    expect(String((w.access as { reason: string }).reason)).toContain("cannot share");
    expect(JSON.stringify(out)).not.toMatch(PAY);
    expect(out.ok && out.status === "done" && out.summary).toContain("directory fields only");
  });

  it("a direct report, an indirect report and her own record: the full record", async () => {
    const exec = await chatAs("usr_imani");
    const ruth = done<{ worker: { pay: { amount_cents: number } | null; bank_account: { status: string }; w4: unknown } }>(await exec("people.get", { worker_id: RUTH })).worker;
    expect(ruth.pay?.amount_cents).toBeGreaterThan(0);
    expect(ruth.bank_account.status).toBeDefined();
    expect(ruth.w4).not.toBeNull();
    const self = done<{ worker: { pay: unknown } }>(await exec("people.get", { worker_id: IMANI })).worker;
    expect(self.pay).not.toBeNull();
    // Make Priya report to Ruth for a moment: an indirect report of Imani gets the full record.
    await weft.db.update(workers).set({ managerId: RUTH }).where(eq(workers.id, PRIYA));
    try {
      const priya = done<{ worker: { pay: unknown; access?: unknown } }>(await (await chatAs("usr_imani"))("people.get", { worker_id: PRIYA })).worker;
      expect(priya.pay).not.toBeNull();
      expect(priya.access).toBeUndefined();
    } finally {
      await weft.db.update(workers).set({ managerId: null }).where(eq(workers.id, PRIYA));
    }
  });

  it("People and payroll roles still read every full record", async () => {
    for (const who of ["usr_dana", "usr_sam", "usr_theo"]) {
      const w = done<{ worker: { pay: unknown; access?: unknown } }>(await (await chatAs(who))("people.get", { worker_id: PRIYA })).worker;
      expect(w.pay, who).not.toBeNull();
      expect(w.access, who).toBeUndefined();
    }
  });

  it("Imani's own UI call and an MCP session are narrowed the same way", async () => {
    const ui = done<{ worker: Record<string, unknown> }>(await weft.executor.human.exec(session("usr_imani"), "people.get", { worker_id: PRIYA })).worker;
    expect(ui.access).toBeDefined();
    expect(ui.pay).toBeUndefined();
    const mcp = await weft.executor.human.exec(session("usr_imani", "api", "mcp"), "people.get", { worker_id: PRIYA });
    expect(JSON.stringify(mcp)).not.toMatch(PAY);
  });

  it("a principal with an unknown role reads directory fields only (fails closed)", async () => {
    await weft.db.insert(principals).values({ id: "usr_test_norole", companyId: "cmp_larkspur", kind: "human", workerId: null, display: "No role", email: null, role: null,
      grantsJson: JSON.stringify({ people: "view", payroll: "none", tax: "none", benefits: "none", it: "none", comms: "view", company: "view" }) });
    const w = done<{ worker: Record<string, unknown> }>(await weft.executor.human.exec(session("usr_test_norole"), "people.get", { worker_id: RUTH })).worker;
    expect(w.access).toBeDefined();
    expect(w.pay).toBeUndefined();
  });
});

describe("people.search for a manager", () => {
  type Row = { id: string; status?: string; start_date?: string; directory_only?: boolean; employee_number?: string };
  it("outsiders carry directory fields only; her reports carry the full row", async () => {
    const exec = await chatAs("usr_imani");
    const data = done<{ workers: Row[]; access: { scope: string }; total: number }>(await exec("people.search", { query: "Priya", response_format: "detailed" }));
    expect(data.access.scope).toBe("reports");
    const priya = data.workers.find((w) => w.id === PRIYA)!;
    expect(priya).toMatchObject({ directory_only: true });
    expect(priya.status).toBeUndefined();
    expect(priya.employee_number).toBeUndefined();
    const team = done<{ workers: Row[] }>(await exec("people.search", { department_id: "dpt_hardware", response_format: "detailed" }));
    const ruth = team.workers.find((w) => w.id === RUTH)!;
    expect(ruth.directory_only).toBeUndefined();
    expect(ruth.status).toBe("active");
    expect(ruth.employee_number).toBeDefined();
  });

  it("a status or start date filter covers only her reports, and says so", async () => {
    const exec = await chatAs("usr_imani");
    const data = done<{ workers: Row[]; access: { filter_note?: string } }>(await exec("people.search", { status: "active", limit: 50 }));
    const reports = new Set((await weft.db.select().from(workers).where(eq(workers.managerId, IMANI))).map((w) => w.id));
    expect(data.workers.length).toBeGreaterThan(0);
    expect(data.workers.every((w) => w.id === IMANI || reports.has(w.id))).toBe(true);
    expect(data.access.filter_note).toContain("Status and start date filters");
  });

  it("an employee number never finds an outsider", async () => {
    const [p] = await weft.db.select().from(workers).where(eq(workers.id, PRIYA));
    const exec = await chatAs("usr_imani");
    expect(done<{ workers: Row[] }>(await exec("people.search", { query: p!.employeeNumber! })).workers).toEqual([]);
    const dana = done<{ workers: Row[] }>(await (await chatAs("usr_dana"))("people.search", { query: p!.employeeNumber! })).workers;
    expect(dana.map((w) => w.id)).toEqual([PRIYA]);
  });
});

describe("other reads a manager reaches", () => {
  it("actions.list and actions.get_run withhold a pay change for an outsider", async () => {
    const out = await weft.executor.human.exec(session("usr_dana"), "people.set_pay_rate", { worker_id: PRIYA, amount_cents: 25_000_000, effective_from: "2026-11-01" });
    expect(out.ok).toBe(true);
    const exec = await chatAs("usr_imani");
    const list = done<{ actions: { command: string; summary: string }[]; access?: { withheld_rows: number } }>(await exec("actions.list", { command: "people.set_pay_rate" }));
    expect(list.actions.length).toBeGreaterThan(0);
    expect(list.actions.every((a) => a.summary.startsWith("Withheld"))).toBe(true);
    expect(list.access?.withheld_rows).toBe(list.actions.length);
    expect(JSON.stringify(list)).not.toMatch(/\$\d/);
    const dana = done<{ actions: { summary: string }[] }>(await (await chatAs("usr_dana"))("actions.list", { command: "people.set_pay_rate" }));
    expect(dana.actions[0]!.summary).toMatch(/\$250,000/);
  });

  it("the audit log and the proposals routes give a manager the same view", async () => {
    const audit = await (await weft.app.request("/v1/actions?limit=50", { headers: weft.uiHeaders("usr_imani") })).json() as { items: { command: string; summary: string; seq: number }[] };
    const rows = (audit.items ?? (audit as unknown as { data: typeof audit.items }).data).filter((a) => a.command === "people.set_pay_rate");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.summary.startsWith("Withheld"))).toBe(true);
    const one = await (await weft.app.request(`/v1/actions/${rows[0]!.seq}`, { headers: weft.uiHeaders("usr_imani") })).json() as { summary: string };
    expect(one.summary).toMatch(/^Withheld/);
    const dana = await (await weft.app.request(`/v1/actions/${rows[0]!.seq}`, { headers: weft.uiHeaders("usr_dana") })).json() as { summary: string };
    expect(dana.summary).toMatch(/\$250,000/);
    // An agent's pay change for Priya is a proposal: Vic sees it, Imani's list and detail do not.
    const handle = await weft.executor.runs.openChatRun(session("usr_dana"), { threadId: null, surface: "human_ui" });   // no allowlist: a test handle
    const filed = await weft.executor.agent.exec(handle, { callId: "pay1", command: "people.set_pay_rate", args: { worker_id: PRIYA, amount_cents: 26_000_000, effective_from: "2026-12-01" } });
    expect(filed.ok && filed.status, JSON.stringify(filed).slice(0, 300)).toBe("pending_approval");
    const id = (filed as { proposalId: string }).proposalId;
    const list = async (who: string) => { const j = await (await weft.app.request("/v1/proposals?limit=100", { headers: weft.uiHeaders(who) })).json() as { items?: { id: string }[]; data?: { id: string }[] }; return (j.items ?? j.data ?? []).map((p) => p.id); };
    expect(await list("usr_dana")).toContain(id);
    expect(await list("usr_imani")).not.toContain(id);
    expect((await weft.app.request(`/v1/proposals/${id}`, { headers: weft.uiHeaders("usr_imani") })).status).toBe(404);
    expect((await weft.app.request(`/v1/proposals/${id}`, { headers: weft.uiHeaders("usr_dana") })).status).toBe(200);
  });

  it("payroll, expenses and benefits reads stay closed by her grants", async () => {
    const exec = await chatAs("usr_imani");
    for (const [command, args] of [["payroll.list_runs", {}], ["expenses.list", {}], ["benefits.get_enrollment", { worker_id: PRIYA }]] as const) {
      const out = await weft.executor.human.exec(session("usr_imani"), command, args);
      expect(out.ok, command).toBe(false);
      expect(JSON.stringify(out), command).toMatch(/NOT_PERMITTED|UNAVAILABLE/);
    }
    const chat = await exec("payroll.list_runs", {});
    expect(chat.ok).toBe(false);
  });

  it("GET /v1/workers/:id gives a manager the directory record for an outsider and the full one for a report", async () => {
    const get = async (who: string, id: string) => (await weft.app.request(`/v1/workers/${id}`, { headers: weft.uiHeaders(who) })).json() as Promise<Record<string, unknown>>;
    const outsider = await get("usr_imani", PRIYA);
    expect(outsider).toMatchObject({ payRates: null, bankAccount: null, taxProfile: null, access: { scope: "directory" } });
    expect((outsider.worker as { ssnMasked: unknown }).ssnMasked).toBeNull();
    const report = await get("usr_imani", RUTH);
    expect(report.bankAccount).not.toBeNull();
    expect(report.access).toBeUndefined();
    const admin = await get("usr_dana", PRIYA);
    expect(admin.bankAccount).not.toBeNull();
    const list = await (await weft.app.request("/v1/workers?limit=100", { headers: weft.uiHeaders("usr_imani") })).json() as { items: { id: string; ssnMasked: string | null }[] };
    const items = list.items ?? (list as unknown as { data: { id: string; ssnMasked: string | null }[] }).data;
    expect(items.find((w) => w.id === PRIYA)?.ssnMasked ?? null).toBeNull();
  });
});
