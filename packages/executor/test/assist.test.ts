// The cursor assistant's presentation tools (src/assist.ts): every call is checked against the manifest and this
// request's screen map, a control that changes data is refused, and nothing is echoed or written.
import { describe, expect, it } from "vitest";
import type { WeftCommand } from "@weft/core";
import { createRegistry, policy, toStrictJsonSchema, strictSchemaProblems, type PolicyFacts } from "../src/index";
import { assistCommands, assistScreenKey } from "../src/assist";
import { NODE_HOSTED, type Engine } from "../src/engine";
import { codeOfError } from "../src/outcome";
import { principals, proposals } from "@weft/db";
import type { ScreenMap } from "../../contracts/src/ext/assist";

const screen: ScreenMap = {
  route: "/app/inbox", title: "Inbox", tab: "pending", truncated: false, viewport: [1440, 900],
  intents: ["tab.select", "scroll.to"],
  items: [
    { n: 1, kind: "card", label: "Approve Ruth Okoro's vacation", entity: "prp_0007", entityKind: "proposal", anchor: "inbox-card", box: [300, 120, 700, 260] },
    { n: 2, kind: "button", label: "Approve", testid: "inbox-approve", anchor: "proposal-approve", box: [320, 340, 90, 32] },
    { n: 3, kind: "tab", label: "Decided", box: [300, 80, 80, 28] },
    { n: 4, kind: "row", label: "Lena Brooks", entity: "pay_2026_10_30:wrk_0026", testid: "payroll-row-wrk_0026", box: [300, 420, 700, 40] },
    { n: 5, kind: "link", label: "Open run", box: [300, 480, 80, 20] },
    { n: 6, kind: "card", label: "Approve all", box: [300, 520, 200, 40] },
  ],
};

function engine(map: ScreenMap | null, hosted = false): Engine {
  const files = new Map<string, string>();
  if (map) files.set(assistScreenKey("cmp_larkspur", "run_0001"), JSON.stringify(map));
  return {
    runFiles: { read: async (p: string) => files.get(p) ?? null, write: async (p: string, b: string) => { files.set(p, b); }, removePrefix: async () => undefined },
    hosted: hosted ? { ...NODE_HOSTED, ephemeralReadIds: true } : NODE_HOSTED,
  } as unknown as Engine;
}
// An agent run acting for Dana (an admin with every grant) unless a test says otherwise.
const ctx = { companyId: "cmp_larkspur", principal: { id: "agt_main", kind: "agent", role: null }, onBehalfOf: "usr_dana", run: { id: "run_0001", stepN: 1, parentStepN: null, attended: true } } as never;
const ALL = { company: "approve", people: "approve", payroll: "approve", tax: "approve", benefits: "approve", it: "approve" };
/** The world the commands read: the proposals that exist, the record ids that exist, and the person's role and grants. */
interface World { proposals?: string[]; ids?: string[]; paychecks?: string[]; role?: string; grants?: Record<string, string>; selfWorkerId?: string | null; workers?: { id: string; managerId: string | null }[]; threads?: Record<string, (string | null)[]> }
const proposalRow = (id: string) => ({ id, status: "pending", command: "payroll.propose_off_cycle", domain: "payroll", argsJson: JSON.stringify({ worker_id: "wrk_0042" }), subjectRef: "wrk_0042", headline: "Pay Hollis Grant", diffJson: "[]" });
const fakeTx = (w: World) => {
  const rows = (t: unknown) => (t === principals ? [{ id: "usr_dana", kind: "human", role: w.role ?? "admin", display: "Dana", workerId: w.selfWorkerId ?? null, companyId: "cmp_larkspur", grantsJson: JSON.stringify(w.grants ?? ALL) }]
    : t === proposals ? (w.proposals ?? []).map(proposalRow) : w.workers ?? []);
  return {
    select: () => ({ from: (t: unknown) => ({ where: () => Object.assign(Promise.resolve(rows(t)), { limit: async () => rows(t) }) }) }),
    // findUnknownReference: one id looked up per query (the closest-ids query finds none). The route lookups bind
    // their id as a parameter: an offboarding case or a claim is found when known, a thread with the runs it holds.
    all: async (q: unknown) => {
      const text = JSON.stringify(q);
      // A pay run's paycheck: the run and the worker it binds, as a pair.
      if (text.includes("FROM paychecks")) return (w.paychecks ?? PAYCHECKS).some((pc) => { const [run, wrk] = pc.split(":"); return text.includes(`"${run}"`) && text.includes(`"${wrk}"`); }) ? [{ id: "pyc_1" }] : [];
      const m = /= '([a-z]{2,5}_[A-Za-z0-9_]+)'/.exec(text);
      if (m) return (w.ids ?? KNOWN).includes(m[1]!) ? [{ id: m[1]! }] : [];
      const bound = (w.ids ?? KNOWN).find((id) => text.includes(`"${id}"`));
      if (!bound) return [];
      return bound.startsWith("thr_") ? (w.threads?.[bound] ?? ["usr_dana"]).map((who) => ({ who })) : [{ id: bound }];
    },
  };
};
const PAYCHECKS = ["pay_2026_10_30:wrk_0026"];
const KNOWN = ["pay_2026_10_30", "wrk_0026", "wrk_0042", "prp_0007", "ofb_0001", "exp_0007", "thr_0123456789abcdef0123"];

async function call(name: string, args: unknown, opts: { map?: ScreenMap | null; hosted?: boolean } & World = {}) {
  const cmds = assistCommands(engine(opts.map === undefined ? screen : opts.map, opts.hosted));
  const def = cmds.find((c) => c.name === name)!;
  try {
    const out = await def.run(def.input.parse(args), ctx, { tx: fakeTx(opts) } as never);
    return { ok: true as const, data: out.data as Record<string, unknown>, summary: out.summary };
  } catch (e) {
    return { ok: false as const, code: codeOfError(e) ?? "?", message: (e as Error).message };
  }
}

describe("the presentation tools as commands", () => {
  const cmds: WeftCommand[] = assistCommands(engine(screen));
  const facts: PolicyFacts = { caller: "agent", agentKind: "main", tainted: false, taintedBy: null, blockedInBatch: false, pendingInBatch: false, amountCents: null, ceiling: null, openR4: 0, systemAllowed: false };

  it("are R0 reads that execute even in a tainted run, hidden from MCP and the sandbox, with strict schemas", () => {
    expect(cmds.map((c) => c.name)).toEqual(["ui.point", "ui.navigate", "ui.show", "ui.say", "ui.handoff", "ui.steps"]);
    for (const c of cmds) {
      expect(c.effect).toBe("read");
      expect(c.mcp).toBe("hidden");
      expect(c.sandbox).toBe("hidden");
      expect(c.tiers).toEqual({ main: "executable", task: "unavailable" });
      expect(c.description.length).toBeLessThanOrEqual(400);
      expect(strictSchemaProblems(toStrictJsonSchema(c.input)), c.name).toEqual([]);
      expect(policy(c, {}, facts).decision).toBe("execute");
      expect(policy(c, {}, { ...facts, tainted: true, taintedBy: "screen:selection" }).decision).toBe("execute");
    }
    expect(createRegistry(cmds).toolSpecs({ agentKind: "main", allowlist: cmds.map((c) => c.name) }).map((s) => s.name)).toEqual(["ui__handoff", "ui__navigate", "ui__point", "ui__say", "ui__show", "ui__steps"]);
  });

  it("work only in an assist run, which carries a screen map", async () => {
    expect(await call("ui.point", { target: "@1", label: "Here" }, { map: null })).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
});

describe("ui.point", () => {
  it("points at a screen map element or a known anchor of this page", async () => {
    expect(await call("ui.point", { target: "@1", label: "Ruth's request for vacation days" })).toMatchObject({ ok: true, data: { effect: "point", target: { kind: "item", n: 1 }, label: "Ruth's request for vacation" } });
    expect(await call("ui.point", { target: "#inbox-time-off", label: "Ruth's request", hint: "Ruth" })).toMatchObject({ ok: true, data: { target: { kind: "anchor", anchor: "inbox-time-off" }, hint: "Ruth" } });
    // Pointing at Approve is fine (the person clicks it): pointing is not pressing.
    expect(await call("ui.point", { target: "@2", label: "Approve here" })).toMatchObject({ ok: true });
  });

  it("refuses an element that is not in this request's map, an anchor of another page and a malformed target", async () => {
    expect(await call("ui.point", { target: "@9", label: "Here" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.point", { target: "#payroll-needs-review", label: "Here" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.point", { target: "button.approve", label: "Here" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("ui.navigate", () => {
  it("opens a nav registry route and points at a known anchor of the destination", async () => {
    expect(await call("ui.navigate", { route: "/app/payroll/pay_2026_10_30", target: "#payroll-needs-review", label: "Needs review" })).toMatchObject({ ok: true, data: { effect: "navigate", route: "/app/payroll/pay_2026_10_30", target: { kind: "anchor", anchor: "payroll-needs-review" }, selectors: ['[data-tour~="payroll-needs-review"]'] } });
    expect(await call("ui.navigate", { route: "/app/payroll/pay_2026_10_30?paycheck=wrk_0026" })).toMatchObject({ ok: true });
  });

  it("refuses a route outside the registry, a bad view state, an anchor of another page and a screen number after a move", async () => {
    expect(await call("ui.navigate", { route: "/portal" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "https://example.com" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "/app/payroll/pay_2026_10_30?approve=1" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "/app/people/wrk_0026?tab=salary" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "/app/inbox", target: "#payroll-needs-review" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "/app/inbox", target: "@1" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await call("ui.navigate", { route: "/app/platform" })).toMatchObject({ ok: false });
    expect(await call("ui.navigate", { route: "/app/platform" }, { hosted: true })).toMatchObject({ ok: true });
  });
});

describe("ui.show", () => {
  it("runs a manifest intent: global intents from any page, page intents only where the page offers them", async () => {
    expect(await call("ui.show", { intent: "payroll.openPaycheck", params: [{ name: "payrollId", value: "pay_2026_10_30" }, { name: "workerId", value: "wrk_0026" }] })).toMatchObject({
      ok: true, data: { effect: "show", via: "intent", intent: "payroll.openPaycheck", route: "/app/payroll/pay_2026_10_30?paycheck=wrk_0026", anchor: "paycheck-drawer" },
    });
    expect(await call("ui.show", { intent: "tab.select", params: [{ name: "tab", value: "decided" }] })).toMatchObject({ ok: true, data: { intent: "tab.select", params: { tab: "decided" }, route: null } });
    expect(await call("ui.show", { intent: "list.filter", params: [{ name: "name", value: "band" }, { name: "value", value: "approved" }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "scroll.to", params: [{ name: "anchor", value: "inbox-time-off" }] })).toMatchObject({ ok: true });
    expect(await call("ui.show", { intent: "scroll.to", params: [{ name: "anchor", value: "payroll-needs-review" }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("takes a page intent's tab, section or filter only from the page's own options", async () => {
    expect(await call("ui.show", { intent: "tab.select", params: [{ name: "tab", value: "rates" }] })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const expenses: ScreenMap = { ...screen, route: "/app/expenses", title: "Expenses", tab: null, intents: ["list.filter"] };
    expect(await call("ui.show", { intent: "list.filter", params: [{ name: "name", value: "band" }, { name: "value", value: "needs_review" }] }, { map: expenses })).toMatchObject({ ok: true, data: { intent: "list.filter", params: { name: "band", value: "needs_review" } } });
    expect(await call("ui.show", { intent: "list.filter", params: [{ name: "name", value: "band" }, { name: "value", value: "everything" }] }, { map: expenses })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await call("ui.show", { intent: "list.filter", params: [{ name: "name", value: "owner" }, { name: "value", value: "me" }] }, { map: expenses })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const run: ScreenMap = { ...screen, route: "/app/payroll/pay_2026_10_30", title: "Payroll", tab: null, intents: ["section.expand"] };
    expect(await call("ui.show", { intent: "section.expand", params: [{ name: "id", value: "needs-review" }] }, { map: run })).toMatchObject({ ok: true });
    expect(await call("ui.show", { intent: "section.expand", params: [{ name: "id", value: "held-back" }] }, { map: run })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("refuses an intent that would change data: there is none, so the call is not permitted", async () => {
    for (const intent of ["inbox.approve", "payroll.submit", "payroll.run", "proposal.decide", "expenses.delete", "offer.send"]) {
      const r = await call("ui.show", { intent, params: [{ name: "proposalId", value: "prp_0007" }] });
      expect(r, intent).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
      expect(!r.ok && r.message).toMatch(/never approve, submit, save, delete, send or run/);
    }
    expect(await call("ui.show", { intent: "payroll.teleport" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "tab.select", params: [{ name: "tab", value: "approve" }] })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("shows an existing proposal's approval card, when it exists, with its Inbox card to ring", async () => {
    expect(await call("ui.show", { intent: "approval.card", params: [{ name: "proposalId", value: "prp_0007" }] }, { proposals: ["prp_0007"] })).toMatchObject({
      ok: true, data: { intent: "approval.card", params: { proposalId: "prp_0007" }, route: "/app/inbox?proposal=prp_0007", anchor: "inbox-proposal", selectors: ['[data-tour~="inbox-card"][data-proposal-id="prp_0007"]'] },
    });
    // That anchor needs the proposal's id, so it is never named on its own.
    expect(await call("ui.point", { target: "#inbox-proposal", label: "Here" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.steps", { steps: [{ route: "/app/inbox", target: "#inbox-proposal", label: "Here", text: "Here." }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "approval.card", params: [{ name: "proposalId", value: "prp_0099" }] }, { proposals: [] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("through the element table: opens a row and switches a tab, never presses a control that changes data", async () => {
    expect(await call("ui.show", { target: "@4", action: "open" })).toMatchObject({ ok: true, data: { via: "element", target: { kind: "item", n: 4 }, action: "open" } });
    expect(await call("ui.show", { target: "@3", action: "tab" })).toMatchObject({ ok: true });
    expect(await call("ui.show", { target: "@2", action: "scroll" })).toMatchObject({ ok: true });
    // A record's own card reads its record ("Approve Ruth Okoro's vacation" is the proposal's headline, not a control).
    expect(await call("ui.show", { target: "@1", action: "open" })).toMatchObject({ ok: true });
    for (const [target, action] of [["@2", "open"], ["@5", "open"], ["@6", "open"], ["#inbox-time-off-approve", "open"], ["#inbox-time-off-approve", "scroll"], ["@4", "submit"], ["@4", "click"]] as const) {
      expect(await call("ui.show", { target, action }), `${target} ${action}`).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    }
    expect(await call("ui.show", { target: "@4" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});

describe("ui.handoff and ui.steps", () => {
  it("ui.handoff writes nothing and does not echo the task", async () => {
    const r = await call("ui.handoff", { reason: "change", task: "Give Lena a raise of $5,000." });
    expect(r).toMatchObject({ ok: true, data: { effect: "handoff", reason: "change" } });
    expect(JSON.stringify(r)).not.toContain("5,000");
    expect(await call("ui.handoff", { reason: "approve", task: "x" })).toMatchObject({ ok: false });
  });

  it("ui.steps validates every step like a point, and refuses a step on a control that changes data", async () => {
    const ok = await call("ui.steps", { steps: [
      { route: "/app/payroll/pay_2026_10_30", target: "#payroll-needs-review", label: "Needs review", text: "Clear the flags." },
      { target: "#payroll-flag", label: "A flag", text: "Open one." },
      { route: "/app/inbox", target: "#inbox-approvals", label: "Approvals", text: "Approve it yourself." },
    ] });
    expect(ok).toMatchObject({ ok: true, data: { effect: "steps", steps: [{ route: "/app/payroll/pay_2026_10_30" }, { route: null }, { route: "/app/inbox" }] } });
    expect(await call("ui.steps", { steps: [{ target: "@4", label: "Lena", text: "Here." }] })).toMatchObject({ ok: true });
    for (const st of [{ route: "/app/payroll/pay_2026_10_30", target: "#payroll-submit" }, { target: "@2" }, { route: "/app/inbox", target: "#inbox-time-off-approve" }, { route: "/app/simulators", target: "#sim-deliver" }]) {
      expect(await call("ui.steps", { steps: [{ ...st, label: "Here", text: "Press it." }] }), JSON.stringify(st)).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    }
    expect(await call("ui.steps", { steps: [{ route: "/app/inbox", target: "@1", label: "x", text: "x" }] })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await call("ui.steps", { steps: [{ route: "/portal", target: "#env-pill", label: "x", text: "x" }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.steps", { steps: Array.from({ length: 7 }, () => ({ target: "#env-pill", label: "x", text: "x" })) })).toMatchObject({ ok: false });
  });
});

describe("what the review of the cursor assistant found", () => {
  it("record ids inside a route are looked up like any id argument; a bare prefix is no id", async () => {
    expect(await call("ui.navigate", { route: "/app/people/wrk_0026" })).toMatchObject({ ok: true });
    for (const route of ["/app/people/wrk_9999", "/app/payroll/pay_2026_13_99?paycheck=wrk_0026", "/app/payroll/pay_2026_10_30?paycheck=wrk_9999", "/app/people/wrk_", "/app/payroll/pay_"]) {
      expect(await call("ui.navigate", { route }), route).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    }
    expect(await call("ui.steps", { steps: [{ route: "/app/people/wrk_9999", target: "#person-tabs", label: "Tabs", text: "Here." }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("a show's link names records that exist: an invented or padded id is refused, as ui.navigate and ui.steps refuse it", async () => {
    const show = (intent: string, params: Record<string, string>, w: World = {}) => call("ui.show", { intent, params: Object.entries(params).map(([name, value]) => ({ name, value })) }, w);
    expect(await show("people.open", { workerId: "wrk_0026" })).toMatchObject({ ok: true, data: { route: "/app/people/wrk_0026" } });
    expect(await show("people.open", { workerId: "wrk_9999" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    // Padding would slip past the pipeline's reference check (it reads whole id-shaped strings): it is no id at all.
    for (const v of [" wrk_9999", "wrk_0026 ", " wrk_0026"]) expect(await show("people.open", { workerId: v }), JSON.stringify(v)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await show("payroll.openPaycheck", { payrollId: "pay_2026_10_30", workerId: " wrk_9999" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await show("payroll.openPaycheck", { payrollId: "pay_2026_10_30", workerId: "wrk_9999" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    // A manager whose grants close payroll gets no pay run, padded or not.
    const manager = { role: "manager", grants: { company: "view", people: "view", payroll: "none" } };
    expect(await show("payroll.open", { payrollId: " pay_2026_10_30" }, manager)).toMatchObject({ ok: false });
    expect(await show("payroll.open", { payrollId: "pay_2026_10_30" }, manager)).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("offboarding cases, expense claims and threads are looked up too; an id of a kind nothing looks up is refused", async () => {
    expect(await call("ui.navigate", { route: "/app/offboarding/ofb_0001" })).toMatchObject({ ok: true });
    expect(await call("ui.navigate", { route: "/app/offboarding/ofb_9999" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "/app/expenses?expense=exp_0007" })).toMatchObject({ ok: true });
    expect(await call("ui.navigate", { route: "/app/expenses?expense=exp_9999" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "expenses.open", params: [{ name: "expenseId", value: "exp_9999" }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "expenses.open", params: [{ name: "expenseId", value: "exp_0007" }] })).toMatchObject({ ok: true, data: { anchor: "expense-drawer" } });
    const thread = "thr_0123456789abcdef0123";
    expect(await call("ui.navigate", { route: `/app/agent?thread=${thread}` })).toMatchObject({ ok: true });
    expect(await call("ui.navigate", { route: "/app/agent?thread=thr_zzzzzzzzzz" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route: "/app/agent?thread=thr_zzzz-zzzzz" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    // A thread is one person's conversation: one whose runs acted for someone else does not exist for this person.
    expect(await call("ui.navigate", { route: `/app/agent?thread=${thread}` }, { threads: { [thread]: ["usr_dana", "usr_0031"] } })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "agent.open", params: [{ name: "threadId", value: "thr_zzzzzzzzzz" }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.steps", { steps: [{ route: "/app/offboarding/ofb_9999", target: "#env-pill", label: "Here", text: "Here." }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("a page the person's grants close is not opened, scrolled to or walked through: the same words as a closed sidebar item", async () => {
    const manager = { role: "manager", grants: { company: "view", people: "view", payroll: "none", benefits: "none", it: "none" } };
    for (const route of ["/app/payroll", "/app/contractors", "/app/benefits", "/app/it", "/app/payroll/pay_2026_10_30", "/app/people/wrk_0026?tab=benefits", "/app/people/wrk_0026?tab=it"]) {
      const r = await call("ui.navigate", { route }, manager);
      expect(r, route).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
      expect(!r.ok && r.message, route).toMatch(/not in this person's sidebar/);
    }
    for (const route of ["/app/people", "/app/people/wrk_0026?tab=pay", "/app/inbox"]) expect(await call("ui.navigate", { route }, manager), route).toMatchObject({ ok: true });
    expect(await call("ui.navigate", { route: "/app/payroll" })).toMatchObject({ ok: true });
    expect(await call("ui.show", { intent: "people.openTab", params: [{ name: "workerId", value: "wrk_0026" }, { name: "tab", value: "benefits" }] }, manager)).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.show", { intent: "people.openTab", params: [{ name: "workerId", value: "wrk_0026" }, { name: "tab", value: "benefits" }] })).toMatchObject({ ok: true });
    expect(await call("ui.show", { intent: "people.openTab", params: [{ name: "workerId", value: "wrk_0026" }, { name: "tab", value: "documents" }] }, manager)).toMatchObject({ ok: true });
    // scroll.to a sidebar item is refused like ui.point at it.
    const r = await call("ui.show", { intent: "scroll.to", params: [{ name: "anchor", value: "nav-payroll" }] }, manager);
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(!r.ok && r.message).toMatch(/not in this person's sidebar/);
    expect(await call("ui.show", { intent: "scroll.to", params: [{ name: "anchor", value: "nav-payroll" }] })).toMatchObject({ ok: true });
    expect(await call("ui.show", { intent: "scroll.to", params: [{ name: "anchor", value: "nav-people" }] }, manager)).toMatchObject({ ok: true });
    // The help corpus's payroll walkthrough starts on Payroll: not for this person.
    expect(await call("ui.steps", { steps: [{ route: "/app/payroll", target: "#payroll-runs", label: "Pay runs", text: "Open the draft." }] }, manager)).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.steps", { steps: [{ route: "/app/payroll", target: "#payroll-runs", label: "Pay runs", text: "Open the draft." }] })).toMatchObject({ ok: true });
  });

  it("a proposal's card follows the Inbox's read scope: a manager gets none for a proposal outside their reports", async () => {
    const card = { intent: "approval.card", params: [{ name: "proposalId", value: "prp_0007" }] };
    expect(await call("ui.show", card, { proposals: ["prp_0007"] })).toMatchObject({ ok: true });
    const manager = { role: "manager", selfWorkerId: "wrk_0004", grants: { company: "view", people: "view", payroll: "none" }, workers: [{ id: "wrk_0042", managerId: "wrk_0001" }] };
    expect(await call("ui.show", card, { proposals: ["prp_0007"], ...manager })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("a walkthrough never points at a control a person presses, whatever its words", async () => {
    const map: ScreenMap = { ...screen, items: [...screen.items,
      { n: 7, kind: "button", label: "Record completion", box: [10, 10, 80, 24] }, { n: 8, kind: "button", label: "Mark resolved", box: [10, 40, 80, 24] },
      { n: 9, kind: "button", label: "Test connection", box: [10, 70, 80, 24] }, { n: 10, kind: "field", label: "Note", box: [10, 100, 80, 24] },
      { n: 11, kind: "tab", label: "Pay and tax", box: [10, 130, 80, 24] }] };
    for (const n of [7, 8, 9, 10]) expect(await call("ui.steps", { steps: [{ target: `@${n}`, label: "Here", text: "Here." }] }, { map }), `@${n}`).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    expect(await call("ui.steps", { steps: [{ target: "@11", label: "Pay", text: "Here." }] }, { map })).toMatchObject({ ok: true });
  });

  it("a sidebar item the person does not have is not pointed at: hosted pages on Node, a grant-gated section for a manager", async () => {
    expect(await call("ui.point", { target: "#nav-platform", label: "Platform" })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.point", { target: "#nav-platform", label: "Platform" }, { hosted: true })).toMatchObject({ ok: true });
    expect(await call("ui.point", { target: "#nav-payroll", label: "Payroll" })).toMatchObject({ ok: true });
    const r = await call("ui.point", { target: "#nav-payroll", label: "Payroll" }, { role: "manager", grants: { company: "view", payroll: "none" } });
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(!r.ok && r.message).toMatch(/not in this person's sidebar/);
    expect(await call("ui.steps", { steps: [{ route: "/app", target: "#nav-models", label: "Models", text: "Here." }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("names Object's own members nothing: an anchor, a query key or a step target of that name is refused, never thrown", async () => {
    for (const anchor of ["constructor"]) {
      expect(await call("ui.point", { target: `#${anchor}`, label: "Here" }), anchor).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
      expect(await call("ui.steps", { steps: [{ route: "/app/payroll", target: "#payroll-runs", label: "Runs", text: "Here." }, { target: `#${anchor}`, label: "x", text: "x" }] }), anchor).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
      expect(await call("ui.show", { intent: "scroll.to", params: [{ name: "anchor", value: anchor }] }), anchor).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    }
    for (const q of ["constructor=1", "__proto__=1", "toString=1"]) expect(await call("ui.navigate", { route: `/app/inbox?${q}` }), q).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
  });

  it("opening a link is a navigation: only to a page of the registry, never the portal or another site", async () => {
    const map: ScreenMap = { ...screen, items: [
      { n: 1, kind: "link", label: "Open portal as new hire", testid: "offer-portal-link", href: "/portal?as=usr_0031", box: [10, 10, 120, 20] },
      { n: 2, kind: "link", label: "Mail us", href: "mailto:hr@example.com", box: [10, 40, 80, 20] },
      { n: 3, kind: "link", label: "Off-cycle run Oct 15", entity: "pay_2026_10_15", href: "/app/payroll/pay_2026_10_30", box: [10, 70, 200, 20] },
      { n: 4, kind: "row", label: "Priscilla Grant Field Service Engineer", entity: "wrk_0030", testid: "people-row-wrk_0030", box: [10, 100, 600, 40] },
      { n: 5, kind: "row", label: "Lena Brooks", entity: "wrk_0026", href: "/portal", box: [10, 150, 600, 40] },
    ] };
    for (const n of [1, 2, 5]) expect(await call("ui.show", { target: `@${n}`, action: "open" }, { map }), `@${n}`).toMatchObject({ ok: false, code: "NOT_PERMITTED" });
    // A record's own row or an app link reads its record: a person named Grant, an off-cycle run.
    for (const n of [3, 4]) expect(await call("ui.show", { target: `@${n}`, action: "open" }, { map }), `@${n}`).toMatchObject({ ok: true });
  });
});

describe("the second review of the cursor assistant", () => {
  it("a paycheck link names a worker with a paycheck in that run: both ids existing is not enough", async () => {
    const route = "/app/payroll/pay_2026_10_30?paycheck=wrk_0042";
    const nav = await call("ui.navigate", { route });
    expect(nav).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect((nav as { message: string }).message).toContain("wrk_0042 has no paycheck in pay_2026_10_30");
    expect(await call("ui.show", { intent: "payroll.openPaycheck", params: [{ name: "payrollId", value: "pay_2026_10_30" }, { name: "workerId", value: "wrk_0042" }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.steps", { steps: [{ route, target: "#paycheck-drawer", label: "Paycheck", text: "Here." }] })).toMatchObject({ ok: false, code: "UNKNOWN_REFERENCE" });
    expect(await call("ui.navigate", { route }, { paychecks: ["pay_2026_10_30:wrk_0042"] })).toMatchObject({ ok: true });
    expect(await call("ui.navigate", { route: "/app/payroll/pay_2026_10_30?paycheck=wrk_0026" })).toMatchObject({ ok: true });
  });

  it("a pointer's hint is a name or nothing: a figure or a sentence never rides on it to the screen", async () => {
    expect(await call("ui.point", { target: "#inbox-time-off", label: "Here", hint: "Ruth O'Neil" })).toMatchObject({ ok: true, data: { hint: "Ruth O'Neil" } });
    expect(await call("ui.point", { target: "#inbox-time-off", label: "Here", hint: "Ruth, owed $4,210" })).toMatchObject({ ok: true, data: { hint: null } });
    expect(await call("ui.navigate", { route: "/app/inbox", target: "#inbox-time-off", hint: "owed 9999" })).toMatchObject({ ok: true, data: { hint: null } });
  });
});

describe("ui.say", () => {
  it("never echoes the model's text, so it can never ground itself", async () => {
    const r = await call("ui.say", { text: "Payroll total is $999,999.99." });
    expect(r).toMatchObject({ ok: true, data: { effect: "say" }, summary: "Answered in the popover" });
    expect(JSON.stringify(r)).not.toContain("999");
  });
});
