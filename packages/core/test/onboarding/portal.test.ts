// Unit tests for the w2-onboarding helpers: portal task kinds per state, document templates and hashes, masking.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { maskedUpload, portalKindsFor } from "../../src/portal/forms";
import { confidentialityText, docSha, offerLetterText } from "../../src/documents/templates";

describe("portal task kinds", () => {
  it("follow PORTAL_TASK_ORDER and include state_withholding only where the state has a form", () => {
    expect(portalKindsFor("CO")).toEqual(["sign_offer", "sign_confidentiality", "federal_w4", "state_withholding", "direct_deposit", "i9_sim", "benefits_selection"]);
    expect(portalKindsFor("TX")).not.toContain("state_withholding");
    expect(portalKindsFor("CA")).toContain("state_withholding");
    expect(portalKindsFor(null)).not.toContain("state_withholding");
  });
});

describe("document templates", () => {
  const input = { companyName: "Larkspur Robotics, Inc.", candidateFirst: "Ada", candidateLast: "Moss", title: "Engineer", departmentName: "Hardware", managerName: "Imani Ferreira", workState: "CO", baseCents: 12_345_600, payKind: "salary", startDate: "2026-11-02", expiresOn: "2026-11-01", offerId: "offr_0002" };
  it("read as the company's own letter, built from DB values, and hash like node:crypto", () => {
    const t = offerLetterText(input);
    expect(t.startsWith("Larkspur Robotics, Inc.\nOffer letter offr_0002")).toBe(true);
    expect(t).not.toMatch(/DEMO DOCUMENT|\(demo\)|fictional|simulated/i);
    expect(t).toContain("Ada Moss");
    expect(t).toContain("$123,456.00 a year");
    expect([...t].some((ch) => ch.charCodeAt(0) === 0x2013 || ch.charCodeAt(0) === 0x2014)).toBe(false);
    expect(docSha(t)).toBe(createHash("sha256").update(t, "utf8").digest("hex"));
    expect(offerLetterText({ ...input, baseCents: 12_345_601 })).not.toBe(t);
    expect(confidentialityText(input)).toContain("offer offr_0002");
  });
});

describe("masked uploads", () => {
  it("hide the file name and hash and keep the size", () => {
    expect(maskedUpload({ id: "upl_0001", fileName: "ada-passport.png", bytes: 2048, sha256: "a".repeat(64) })).toEqual({ id: "upl_0001", fileName: "ad***.png", bytes: 2048, sha256: "aaaaaaaa...", masked: true, preview: "ID image on file (2 KB), hidden" });
  });
});
