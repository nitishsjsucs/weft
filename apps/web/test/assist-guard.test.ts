// The cursor assistant's client checks: the double right-click detector (right-click.ts) and the live guard a show
// action passes on the real element before anything is activated (guard.ts), which refuses every control that
// changes data even when the server allowed the call.
import { describe, expect, it } from "vitest";
import { createRightClickDetector, DOUBLE_RIGHT_MS, DOUBLE_RIGHT_SLOP, isDoubleRightClick } from "../src/components/assist/right-click";
import { linkRoute, liveShowRefusal, type LiveControl } from "../src/components/assist/guard";

describe("the double right-click", () => {
  it("is two presses within DOUBLE_RIGHT_MS and DOUBLE_RIGHT_SLOP px", () => {
    expect(isDoubleRightClick({ t: 0, x: 100, y: 100 }, { t: DOUBLE_RIGHT_MS, x: 100, y: 100 })).toBe(true);
    expect(isDoubleRightClick({ t: 0, x: 100, y: 100 }, { t: DOUBLE_RIGHT_MS + 1, x: 100, y: 100 })).toBe(false);
    expect(isDoubleRightClick({ t: 0, x: 100, y: 100 }, { t: 100, x: 100 + DOUBLE_RIGHT_SLOP + 1, y: 100 })).toBe(false);
    expect(isDoubleRightClick({ t: 500, x: 0, y: 0 }, { t: 400, x: 0, y: 0 })).toBe(false);
    expect(isDoubleRightClick(null, { t: 0, x: 0, y: 0 })).toBe(false);
  });
  it("opens the menu on the first press, wakes on the second, and starts over after", () => {
    const d = createRightClickDetector();
    expect(d.press({ t: 0, x: 10, y: 10 })).toBe("first");
    expect(d.press({ t: 300, x: 12, y: 11 })).toBe("double");
    expect(d.press({ t: 350, x: 12, y: 11 })).toBe("first");
    expect(d.press({ t: 1_000, x: 12, y: 11 })).toBe("first");
    d.reset();
    expect(d.press({ t: 1_100, x: 12, y: 11 })).toBe("first");
  });
});

describe("liveShowRefusal", () => {
  const ctl = (over: Partial<LiveControl>): LiveControl => ({ tag: "TR", kind: "row", label: "Lena Brooks", testid: "payroll-row-wrk_0026", anchor: null, type: null, inForm: false, marked: false, ...over });
  it("lets a row open, a tab switch and anything scroll", () => {
    expect(liveShowRefusal(ctl({}), "open")).toBeNull();
    expect(liveShowRefusal(ctl({ tag: "BUTTON", kind: "tab", label: "Pay and tax", testid: null }), "tab")).toBeNull();
    expect(liveShowRefusal(ctl({ tag: "BUTTON", kind: "button", label: "Approve", testid: "proposal-approve", marked: true }), "scroll")).toBeNull();
  });
  it("refuses a submit button, a button in a form, a field and anything marked as changing data", () => {
    expect(liveShowRefusal(ctl({ tag: "BUTTON", kind: "row", label: "Lena", type: "submit" }), "open")).toMatch(/submits a form/);
    expect(liveShowRefusal(ctl({ tag: "BUTTON", kind: "card", label: "Details", inForm: true }), "open")).toMatch(/submits a form/);
    expect(liveShowRefusal(ctl({ tag: "INPUT", kind: "row", label: "Amount", testid: null }), "open")).toMatch(/never types/);
    expect(liveShowRefusal(ctl({ marked: true }), "open")).toMatch(/changes data/);
  });
  it("refuses buttons and every label, test id or anchor that reads as a change", () => {
    expect(liveShowRefusal(ctl({ tag: "BUTTON", kind: "button", label: "Details" }), "open")).toMatch(/never presses buttons/);
    expect(liveShowRefusal(ctl({ kind: "card", label: "Approve Ruth's time off" }), "open")).toMatch(/changes data/);
    expect(liveShowRefusal(ctl({ kind: "link", label: "Open", testid: "payroll-submit", href: "/app/payroll/pay_2026_10_30" }), "open")).toMatch(/changes data/);
    expect(liveShowRefusal(ctl({ kind: "card", label: "Request", anchor: "inbox-time-off-approve" }), "open")).toMatch(/changes data/);
    expect(liveShowRefusal(ctl({}), "approve")).toMatch(/not a show action/);
  });
  it("opens a link only to a page of the registry: never the portal, another site, mail or a fragment", () => {
    const portal = ctl({ tag: "A", kind: "link", label: "Open portal as new hire", testid: "offer-portal-link", href: "/portal?as=usr_0031" });
    expect(liveShowRefusal(portal, "open")).toMatch(/not a page the assistant may open/);
    for (const href of ["https://example.com/app", "mailto:hr@example.com", "/app/inbox#x", "/app/people?tab=salary", null]) {
      expect(liveShowRefusal(ctl({ tag: "A", kind: "link", label: "Somewhere", testid: null, href }), "open"), String(href)).not.toBeNull();
    }
    // A row inside a link goes where the link goes.
    expect(liveShowRefusal(ctl({ href: "/portal" }), "open")).toMatch(/not a page/);
    const run = ctl({ tag: "A", kind: "link", label: "Off-cycle run Oct 15", testid: null, href: "/app/payroll/pay_2026_10_30" });
    expect(liveShowRefusal(run, "open")).toBeNull();
    expect(linkRoute(run)).toBe("/app/payroll/pay_2026_10_30");
    expect(linkRoute(ctl({}))).toBeNull();
    // Marked as changing data (the portal link carries the mark too): refused even with an app href.
    expect(liveShowRefusal(ctl({ tag: "A", kind: "link", label: "Portal", testid: null, href: "/app", marked: true }), "open")).toMatch(/marked/);
  });
  it("reads a record's own row by its record: a person named Grant opens, an unnamed button that says Grant does not", () => {
    expect(liveShowRefusal(ctl({ label: "Priscilla Grant Field Service Engineer", entity: "wrk_0030" }), "open")).toBeNull();
    expect(liveShowRefusal(ctl({ label: "Grant access", testid: null, entity: null }), "open")).toMatch(/changes data/);
  });
});
