// A channel post names people as people do: a row id in parentheses after a name goes from the shown and posted text.
import { describe, expect, it } from "vitest";
import { withoutRowIds } from "../src/comms/send";

describe("withoutRowIds", () => {
  it("drops a parenthesized row id or id list and keeps (demo) and other words in parentheses", () => {
    expect(withoutRowIds("Please welcome Noor Castellanos (demo) (wrk_0063) to the team.")).toBe("Please welcome Noor Castellanos (demo) to the team.");
    expect(withoutRowIds("1 blocked paycheck (pay_2026_10_30) and (res_0001, res_0002)")).toBe("1 blocked paycheck and");
    expect(withoutRowIds("Lunch (12:30) in Oakland (HQ)")).toBe("Lunch (12:30) in Oakland (HQ)");
  });
});
