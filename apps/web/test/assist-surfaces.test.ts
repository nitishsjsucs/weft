// Where the cursor assistant's surfaces go and what a link it opens shows, the pure parts (components/assist/
// surface-core.ts, context-core.ts keyboardOrigin, people-view.tsx personTabOffered): a link to the page the person is
// on replaces that page's view state instead of merging into it, the phone's bottom sheet keeps its largest height
// clear above a target, the docked icon steps aside from any open drawer, a keyboard-opened composer is about the
// focused record, and a person's tab the viewer is not offered falls back to Profile.
import { describe, expect, it } from "vitest";
import { patchedSearch, sameAsPage } from "../src/lib/url-state";
import { closingPlays, composing, iconHidden, isAssistHotkey, mayShowNow, sheetReserve, stopAfterCancel, viewPatch, type IconState, type KeyPress } from "../src/components/assist/surface-core";
import { stepPage, walkIndex } from "../src/components/assist/walk";
import { readAssistPref, setAssistPref } from "../src/components/assist/prefs";
import { keyboardOrigin } from "../src/components/assist/context-core";
import { personTabOffered } from "../src/components/app/people/people-view";

describe("a link to the page the person is on", () => {
  it("replaces the page's view state: a drawer the link does not name closes, and the view is the link's", () => {
    const patch = viewPatch("/app/payroll/pay_2026_10_30?section=needs-review");
    expect(patch).toEqual({ paycheck: null, section: "needs-review" });
    // Lena's paycheck drawer was open: the Needs review band is not left under it.
    expect(patchedSearch("?paycheck=wrk_0016", patch)).toBe("?section=needs-review");
    // A bare link closes what is open (the expense drawer), as the same link pasted would show it.
    expect(patchedSearch("?expense=exp_0007&filter.band=approved", viewPatch("/app/expenses"))).toBe("");
    expect(patchedSearch("?tab=rates", viewPatch("/app/compliance?notice=ntc_0003"))).toBe("?notice=ntc_0003");
    expect(patchedSearch("?run=run_0004", viewPatch("/app/agent?thread=thr_abcdefgh12"))).toBe("?thread=thr_abcdefgh12");
  });

  it("leaves keys outside the manifest alone (the tour's own), and a page with no view state untouched", () => {
    expect(patchedSearch("?tour=3&paycheck=wrk_0016", viewPatch("/app/payroll/pay_2026_10_30"))).toBe("?tour=3");
    expect(viewPatch("/app/audit")).toEqual({});
  });
});

describe("the phone's bottom sheet", () => {
  it("is given its largest height above a target, so the answer that follows Working never covers the ring", () => {
    // 60vh of 844 plus its 16 px inset and a gap: the target is centred in the 310 px above.
    expect(sheetReserve(844)).toBe(534);
    expect(844 - sheetReserve(844)).toBe(310);
  });
});

describe("the docked icon", () => {
  const base: IconState = { on: true, tour: false, busy: false, docked: true, agentComposer: false, layer: false };
  it("steps aside from any open drawer or dialog on a phone, where it would cover the footer's right-hand button", () => {
    expect(iconHidden(base)).toBe(false);
    expect(iconHidden({ ...base, layer: true }), "a drawer is open: Submit, Propose, Terminate sit under the corner").toBe(true);
    expect(iconHidden({ ...base, agentComposer: true })).toBe(true);
    // Floating (a mouse), it already moves aside from the control beneath it.
    expect(iconHidden({ ...base, docked: false, layer: true })).toBe(false);
    expect(iconHidden({ ...base, on: false })).toBe(true);
    expect(iconHidden({ ...base, busy: true })).toBe(true);
  });

  it("stays hidden whenever the person turned it off in the Viewing as menu, floating or docked", () => {
    for (const docked of [true, false]) {
      expect(iconHidden({ ...base, docked, on: false }), `docked ${docked}`).toBe(true);
      expect(iconHidden({ ...base, docked, on: true }), `docked ${docked}`).toBe(false);
    }
  });

  it("the setting is kept per browser under weft.assist.icon, and storage that throws keeps it shown", () => {
    const store = new Map<string, string>();
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    try {
      g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } };
      setAssistPref("icon", false);
      expect(store.get("weft.assist.icon")).toBe("off");
      setAssistPref("icon", true);
      expect(store.get("weft.assist.icon")).toBe("on");
      g.window = { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } };
      expect(() => setAssistPref("icon", false)).not.toThrow();
      // Storage blocked: the choice still holds for this page, so Hide hides and the voice toggle stays on.
      expect(readAssistPref("icon")).toBe("off");
      setAssistPref("voice", true);
      expect(readAssistPref("voice")).toBe("on");
    } finally {
      if (had) g.window = prev; else delete g.window;
    }
  });
});

describe("a composer opened from the keyboard", () => {
  it("is about the focused control when the keyboard moved focus after the pointer last moved", () => {
    expect(keyboardOrigin({ pointerAt: 1_000, focusAt: 2_000, focused: true })).toBe("focus");
    expect(keyboardOrigin({ pointerAt: null, focusAt: null, focused: true })).toBe("focus");
    // The mouse moved since: it is about what is under the pointer, as before.
    expect(keyboardOrigin({ pointerAt: 3_000, focusAt: 2_000, focused: true })).toBe("pointer");
    expect(keyboardOrigin({ pointerAt: 1_000, focusAt: null, focused: true })).toBe("pointer");
    expect(keyboardOrigin({ pointerAt: null, focusAt: null, focused: false })).toBe("none");
  });
});

describe("a person's record tab from a link", () => {
  it("is shown only when this viewer has it; Benefits or IT without the grant, or Time off for a contractor, falls back to Profile", () => {
    const manager = { benefits: false, it: false, employee: true };
    expect(personTabOffered("pay", manager)).toBe(true);
    expect(personTabOffered("benefits", manager)).toBe(false);
    expect(personTabOffered("it", manager)).toBe(false);
    expect(personTabOffered("benefits", { ...manager, benefits: true })).toBe(true);
    expect(personTabOffered("time-off", { ...manager, employee: false })).toBe(false);
    expect(personTabOffered("salary", manager)).toBe(false);
  });
});

describe("what the second review of the cursor assistant found", () => {
  const idle = { askedFrom: "/app/people", here: "/app/people", typing: false, layerNow: false, layerThen: false };
  it("a run's closing show moves the page only while the person is still where they asked, doing nothing else", () => {
    expect(mayShowNow(idle)).toBe(true);
    // They moved on, opened a drawer of their own, or are typing a note: the show stays a chip on the card.
    expect(mayShowNow({ ...idle, here: "/app/expenses?expense=exp_0007" })).toBe(false);
    expect(mayShowNow({ ...idle, layerNow: true })).toBe(false);
    expect(mayShowNow({ ...idle, typing: true })).toBe(false);
    // A drawer that was already open when they asked is theirs to keep, and no reason to hold the show back.
    expect(mayShowNow({ ...idle, layerNow: true, layerThen: true })).toBe(true);
  });

  it("after Stop, a run's end neither moves the page to its proposal's card nor speaks; its chip stays to press", () => {
    expect(closingPlays("done", "idle")).toBe(true);
    expect(closingPlays("cancelled", "idle")).toBe(false);
    expect(closingPlays("cancelled", "stopped")).toBe(false);
    // The cancel still on its way, or accepted while the run's last step landed: the person asked it to stop.
    expect(closingPlays("done", "sending")).toBe(false);
    expect(closingPlays("done", "stopped")).toBe(false);
    // A cancel that failed leaves Stop to press again; the run that finishes still closes as usual.
    expect(closingPlays("done", "failed")).toBe(true);
  });

  it("a Stop that reaches a run already finished leaves its answer as it is, without the stopped heading", () => {
    expect(stopAfterCancel("cancelled")).toBe("stopped");
    // The abort is on its way: the run ends cancelled.
    expect(stopAfterCancel("running")).toBe("stopped");
    expect(stopAfterCancel("queued")).toBe("stopped");
    for (const status of ["done", "failed", "waiting", "refused", "escalated"]) expect(stopAfterCancel(status), status).toBe("idle");
  });

  it("a link to the page already open is followed in place (Next keeps the page mounted and tells it nothing)", () => {
    expect(sameAsPage("/app/agent?thread=thr_0123456789abcdef0123", "/app/agent")).toBe(true);
    expect(sameAsPage("/app/agent?thread=thr_0123456789abcdef0123", "/app/agent/")).toBe(true);
    expect(sameAsPage("/app/inbox?proposal=prp_0007", "/app/inbox")).toBe(true);
    expect(sameAsPage("/app/inbox?proposal=prp_0007", "/app/agent")).toBe(false);
    // The list's tab is cleared too: the thread opens beside Conversations, where it is listed.
    expect(viewPatch("/app/agent?thread=thr_0123456789abcdef0123")).toEqual({ thread: "thr_0123456789abcdef0123", run: null, tab: null });
  });

  it("a walkthrough's step stays inside its own steps: a shorter second walkthrough never reads past its end", () => {
    expect(walkIndex(2, 2)).toBe(1);
    expect(walkIndex(0, 6)).toBe(0);
    expect(walkIndex(3, 6)).toBe(3);
    expect(walkIndex(-1, 3)).toBe(0);
  });

  it("Back to a step with no route of its own opens the page it was shown on, not the later step's page", () => {
    // The help corpus's run-payroll walkthrough: the draft run, its Needs review band and a flag, then the Inbox.
    const steps = [{ route: "/app/payroll/pay_2026_10_30" }, { route: null }, { route: null }, { route: "/app/inbox" }];
    const shown = new Map([[0, "/app/payroll/pay_2026_10_30"], [1, "/app/payroll/pay_2026_10_30"], [2, "/app/payroll/pay_2026_10_30?section=needs-review"], [3, "/app/inbox"]]);
    expect(stepPage(steps, 2, shown, "/app")).toBe("/app/payroll/pay_2026_10_30?section=needs-review");
    expect(stepPage(steps, 3, shown, "/app")).toBe("/app/inbox");
    // Not shown yet after a move: it waits where the person is.
    expect(stepPage(steps, 2, new Map(), "/app")).toBeNull();
    // A model's walkthrough that starts on the current page and then moves: Back returns to where it started.
    const mixed = [{ route: null }, { route: "/app/inbox" }];
    expect(stepPage(mixed, 0, new Map(), "/app/payroll?x=1")).toBe("/app/payroll?x=1");
    expect(stepPage(mixed, 0, new Map([[0, "/app/payroll"]]), "/app/payroll?x=1")).toBe("/app/payroll");
  });
});

describe("the assistant's keys", () => {
  const press = (x: Partial<KeyPress>): KeyPress => ({ key: "j", code: "KeyJ", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, ...x });
  it("Ctrl or Cmd J on any layout, and never the browser's Ctrl H or Ctrl N where Dvorak or Colemak puts H or N on the J key", () => {
    expect(isAssistHotkey(press({}))).toBe(true);
    expect(isAssistHotkey(press({ ctrlKey: false, metaKey: true }))).toBe(true);
    // Russian: the J key types о.
    expect(isAssistHotkey(press({ key: "о" }))).toBe(true);
    // Dvorak: J types h and the layout's J sits on KeyC; Colemak: J types n.
    expect(isAssistHotkey(press({ key: "h" }))).toBe(false);
    expect(isAssistHotkey(press({ key: "n" }))).toBe(false);
    expect(isAssistHotkey(press({ key: "j", code: "KeyC" }))).toBe(true);
    expect(isAssistHotkey(press({ shiftKey: true }))).toBe(false);
    expect(isAssistHotkey(press({ ctrlKey: false }))).toBe(false);
  });

  it("a key in an input method's composition is never the assistant's: its Escape cancels the candidate", () => {
    expect(composing(press({ key: "Escape", code: "Escape", ctrlKey: false, isComposing: true }))).toBe(true);
    expect(composing(press({ key: "Escape", code: "Escape", ctrlKey: false, keyCode: 229 }))).toBe(true);
    expect(composing(press({ key: "Escape", code: "Escape", ctrlKey: false }))).toBe(false);
    expect(isAssistHotkey(press({ isComposing: true }))).toBe(false);
  });
});
