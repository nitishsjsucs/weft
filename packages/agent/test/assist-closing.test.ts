// The closing show code builds when an assist exchange ends (packages/agent/src/assist/closing.ts): a filed proposal
// becomes its approval card, the records the answer cites become at most four "Show me" chips through the validated
// intents and routes, an answer that asks a question offers a read's candidates as choices, and nothing is offered for
// a read the answer does not cite.
import { describe, expect, it } from "vitest";
import { CLOSING_CHIPS, chipFor, closingShow, entitiesIn } from "../src/assist/closing";

const read = (resultId: string, data: unknown, toolName = "people__search") => ({ kind: "tool_call", toolName, outcome: "ok", result: { outcome: { ok: true, status: "done", resultId, data } } });
const PEOPLE = { workers: [
  { id: "wrk_0026", name: "Lena Brooks (wrk_0026)", title: "Account Executive" },
  { id: "wrk_0031", name: "Lena Ortiz", title: "Account Executive" },
] };
const RUNS = { runs: ["pay_2026_10_30", "pay_2026_10_15", "pay_2026_09_30", "pay_2026_09_15", "pay_2026_08_31"].map((id, i) => ({ id, period_start: `2026-0${9 - Math.floor(i / 2)}-01`, period_end: `2026-0${9 - Math.floor(i / 2)}-15` })) };

describe("the closing show", () => {
  it("a filed proposal is its approval card, which opens the Inbox on it and rings its card", () => {
    const steps = [{ kind: "tool_call", toolName: "payroll__propose_off_cycle", outcome: "pending:prp_0007", result: null }];
    const c = closingShow(steps, "I proposed the off-cycle payment; it waits for your approval.");
    expect(c.proposals).toEqual(["prp_0007"]);
    expect(c.chips).toEqual([{ id: "prp_0007", label: "The proposal", intent: "approval.card", params: [{ name: "proposalId", value: "prp_0007" }], route: "/app/inbox?proposal=prp_0007", anchor: "inbox-proposal", selectors: ['[data-tour~="inbox-card"][data-proposal-id="prp_0007"]'] }]);
    expect(c.choose).toBeNull();
  });

  it("cited records become chips, at most four, named without their ids; an uncited read offers nothing", () => {
    const steps = [read("res_0001", RUNS, "payroll__list_runs"), read("res_0002", PEOPLE)];
    const c = closingShow(steps, "The open draft stands out [res_0001].");
    expect(c.chips).toHaveLength(CLOSING_CHIPS);
    expect(c.chips.every((x) => x.intent === "payroll.open" && /^\/app\/payroll\/pay_/.test(x.route ?? ""))).toBe(true);
    expect(c.chips.map((x) => x.id)).not.toContain("wrk_0026");
    const people = closingShow(steps, "Lena Brooks is one of them [res_0002].");
    expect(people.chips.map((x) => [x.id, x.label, x.route])).toEqual([["wrk_0026", "Lena Brooks", "/app/people/wrk_0026"], ["wrk_0031", "Lena Ortiz", "/app/people/wrk_0031"]]);
    expect(closingShow(steps, "Nothing cited here.").chips).toEqual([]);
  });

  it("the records the answer names come first, however far down the cited list they are", () => {
    const many = { people: Array.from({ length: 20 }, (_, i) => ({ id: `wrk_${String(i + 1).padStart(4, "0")}`, name: `Person ${i + 1}` })) };
    const steps = [read("res_0003", many)];
    expect(closingShow(steps, "Person 17 had the largest change [res_0003].").chips.map((x) => x.id)).toEqual(["wrk_0017", "wrk_0001", "wrk_0002", "wrk_0003"]);
    expect(closingShow(steps, "wrk_0019 and wrk_0020 stand out [res_0003].").chips.map((x) => x.id)).toEqual(["wrk_0019", "wrk_0020", "wrk_0001", "wrk_0002"]);
  });

  it("an answer that asks which one offers a read's few candidates as choices, and then no chips", () => {
    const c = closingShow([read("res_0002", PEOPLE)], "Two people are account executives. Which one do you mean?");
    expect(c.choose?.options.map((o) => o.id)).toEqual(["wrk_0026", "wrk_0031"]);
    expect(c.chips).toEqual([]);
    // Five or more candidates (or one) is not a choice.
    expect(closingShow([read("res_0001", RUNS, "payroll__list_runs")], "Which run?").choose?.options.length).toBe(5);
    expect(closingShow([read("res_0003", { workers: [PEOPLE.workers[0]] })], "Which one?").choose).toBeNull();
  });

  it("a refused or failed read and a presentation tool's own result are never sources", () => {
    const refused = { ...read("res_0004", PEOPLE), result: { outcome: { ok: false, status: "refused", resultId: "res_0004", data: PEOPLE } } };
    const ui = read("res_0005", { id: "wrk_0026" }, "ui__show");
    expect(closingShow([refused, ui], "See [res_0004] and [res_0005].").chips).toEqual([]);
  });

  it("chips go through the same checks: an unknown kind of record has none, and hosted routes validate too", () => {
    expect(chipFor("ntc_0001", "A notice")).toBeNull();
    expect(chipFor("wrk_0026", "Lena Brooks", { hosted: true })).toMatchObject({ intent: "people.open", route: "/app/people/wrk_0026" });
    expect([...entitiesIn({ deep: { deeper: [{ worker_id: "wrk_0042", worker_name: "Hollis Grey" }] } })]).toEqual([["wrk_0042", "Hollis Grey"]]);
    // payroll.get_run's concise rows name the person as "Name (id)", and a flag's evidence carries only the id.
    const run = { run_id: "pay_2026_10_30", period: "2026-10-16 to 2026-10-31", flagged: [{ paycheck_id: "pc_1", worker: "Lena Brooks (wrk_0026)", flags: [{ evidence: { worker_id: "wrk_0026" } }] }, { flags: [{ evidence: { worker_id: "wrk_0031" } }], worker: "Owen Mercer (wrk_0031)" }] };
    expect([...entitiesIn(run)]).toEqual([["pay_2026_10_30", "Pay run"], ["wrk_0026", "Lena Brooks"], ["wrk_0031", "Owen Mercer"]]);
  });
});
