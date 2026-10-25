// The Inbox's deep link (components/app/inbox/inbox-link.ts): a proposal past the list's page is still shown, and a
// second link to the same proposal opens its tab again after the person picked another one.
import { describe, expect, it } from "vitest";
import type { Proposal } from "@weft/contracts";
import { inboxRows, nextLinkTab, tabOf, tabParamFor } from "../src/components/app/inbox/inbox-link";

const prp = (id: string, x: Partial<Proposal> = {}) => ({ id, status: "pending", kind: "change", ...x }) as Proposal;

describe("the Inbox's deep link", () => {
  it("a proposal the list's page does not hold is shown from its own fetch, once", () => {
    const list = Array.from({ length: 100 }, (_, i) => prp(`prp_${String(i + 1).padStart(4, "0")}`));
    const late = prp("prp_0123", { kind: "suggestion" });
    const { rows, linked } = inboxRows(list, "prp_0123", late);
    expect(linked).toBe(late);
    expect(rows).toHaveLength(101);
    expect(rows!.filter((p) => p.id === "prp_0123")).toHaveLength(1);
    // One in the page is not added twice, and a fetch for another id is not the linked one.
    expect(inboxRows(list, "prp_0042", prp("prp_0042")).rows).toHaveLength(100);
    expect(inboxRows(list, "prp_0123", prp("prp_0999")).linked).toBeUndefined();
    expect(inboxRows(undefined, "prp_0123", late).rows).toBeUndefined();
  });

  it("a second link to the same proposal opens its tab again after the person picked Approvals", () => {
    const s = prp("prp_0019", { kind: "suggestion" });
    expect(tabOf(s)).toBe("suggestions");
    // The assistant's link names it with no tab: its tab opens.
    let at = nextLinkTab(null, null, "prp_0019", s);
    expect(at).toEqual({ target: "prp_0019", tab: "suggestions" });
    // The person picks Approvals: written out while a proposal is named, so the link tab clears.
    expect(tabParamFor("pending", "prp_0019")).toBe("pending");
    at = nextLinkTab(at, "pending", "prp_0019", s);
    expect(at).toBeNull();
    // The same link again (the tab key written back to none) opens Suggestions again.
    expect(nextLinkTab(at, null, "prp_0019", s)).toEqual({ target: "prp_0019", tab: "suggestions" });
    expect(tabParamFor("pending", null)).toBeNull();
  });

  it("a decision while the link is open does not move the page", () => {
    const at = nextLinkTab(null, null, "prp_0019", prp("prp_0019"));
    expect(nextLinkTab(at, null, "prp_0019", prp("prp_0019", { status: "approved" }))).toBe(at);
    expect(nextLinkTab(at, null, "prp_0020", prp("prp_0020", { status: "approved" }))).toEqual({ target: "prp_0020", tab: "decided" });
    expect(nextLinkTab(null, null, "prp_0021", undefined)).toBeNull();
  });
});
