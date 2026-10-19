// A chat answer as copy: the model's Markdown habits render as a safe subset, cited results become numbered chips, and
// no worker id, pay rate id, enum code, ISO date or stray "Source: ." reaches the reader. The stored text never changes.
import { describe, expect, it } from "vitest";
import { answerPlain, parseAnswer, type ParsedAnswer } from "../src/components/app/agent/answer";

/** The answer as one string with chips as [n] and bold as <b>, for readable expectations. */
function flat(p: ParsedAnswer): string {
  return p.blocks.map((b) => b.items.map((spans) => (b.kind === "ul" ? "- " : "") + spans.map((s) => (s.t === "cite" ? `[${s.n}]` : s.t === "b" ? `<b>${s.s}</b>` : s.t === "code" ? `<code>${s.s}</code>` : s.s)).join("")).join(b.kind === "ul" ? "\n" : "")).join("\n\n");
}

describe("chat answers as copy", () => {
  it("renders bold, drops the worker id and turns the cited result into a chip", () => {
    const p = parseAnswer("Recently, Lena Brooks (wrk_0026) had a salary change to **$139,240.00 annually**, effective **Oct 16**. Dana set it on **Oct 9**, action 1, result `res_0001`.");
    expect(flat(p)).toBe("Recently, Lena Brooks had a salary change to <b>$139,240.00 annually</b>, effective <b>Oct 16</b>. Dana set it on <b>Oct 9</b>, action 1 [1].");
    expect(p.cites).toEqual(["res_0001"]);
  });
  it("a trailing Source line keeps only its chip", () => {
    expect(flat(parseAnswer("Payroll cost by month is in the chart. Source: `res_0273`."))).toBe("Payroll cost by month is in the chart. [1].".replace(" [1].", " [1]."));
    expect(flat(parseAnswer("... Mira Delgado (wrk_0022). Source: res_0230."))).toBe("... Mira Delgado. [1].");
  });
  it("pay rate ids, enum codes, ISO dates and audit sequence words read as copy", () => {
    const t = flat(parseAnswer("Lena Brooks (wrk_0026) is recorded as pay rate `prt_0052`, flagged for a GROSS_CHANGE review that took effect on 2026-10-16. Source: payroll result `res_0227`, audit action sequence 1, result `res_0001`."));
    expect(t).not.toMatch(/wrk_|prt_|res_|GROSS_CHANGE|2026-10-16|`/);
    expect(t).toContain("gross change review");
    expect(t).toContain("Oct 16");
    expect(t).toContain("audit #1");
    expect(t).toContain("[1]");
    expect(t).toContain("[2]");
  });
  it("payday in backticks and a parenthesized result read as a date and a chip", () => {
    const t = flat(parseAnswer("The payday `2026-10-30` is not approved (`res_0230`)."));
    expect(t).toBe("The payday Oct 30 is not approved [1].");
  });
  it("a time-off request id and its result never show", () => {
    const t = flat(parseAnswer("Ruth Okoro (demo) has 89 hours left after the request. Source: tor_0003, result res_0230"));
    expect(t).not.toMatch(/tor_|res_|Source: ,/);
    expect(t).toContain("[1]");
  });
  it("bullet lines become a list and the same id keeps its number", () => {
    const p = parseAnswer("Two people are out:\n- **Grace Adeyemi (demo)** on Nov 23 [res_0005]\n- Oscar Lindqvist (demo) on Nov 24 [res_0005]");
    expect(p.blocks.map((b) => b.kind)).toEqual(["p", "ul"]);
    expect(flat(p)).toBe("Two people are out:\n\n- <b>Grace Adeyemi (demo)</b> on Nov 23 [1]\n- Oscar Lindqvist (demo) on Nov 24 [1]");
    expect(p.cites).toEqual(["res_0005"]);
  });
  it("never passes HTML or links through as markup", () => {
    const p = parseAnswer("See <b>this</b> and [a link](http://x.example).");
    expect(flat(p)).toBe("See <b>this</b> and [a link](http://x.example).");
    expect(p.blocks[0]!.items[0]!.every((s) => s.t === "text")).toBe(true);
  });
  it("the plain line for Recent answers has no marks and no chips", () => {
    expect(answerPlain("Recently, Lena Brooks (wrk_0026) had a salary change to **$139,240.00 annually**.\nSource: `res_0001`.")).toBe("Recently, Lena Brooks had a salary change to $139,240.00 annually.");
  });
});
