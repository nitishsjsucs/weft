import { describe, expect, it } from "vitest";
import { calculatePaycheck, TAX_2026 } from "../src/index";

describe("payroll-tax scaffold", () => {
  it("exposes the 2026.1 tables and a typed stub", () => {
    expect(TAX_2026.version).toBe("2026.1");
    expect(() => calculatePaycheck({} as never)).toThrow(/Not implemented/);
  });
  it.todo("golden cases 1, 2, 4, 7, 9 and the agency examples to the cent (t1-payroll)");
});
