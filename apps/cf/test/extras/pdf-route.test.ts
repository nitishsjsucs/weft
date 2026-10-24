// GET /api/_hosted/pdf/<kind>/<id> in a slot (design 6.3 and 7.1), against a real seeded world: the document comes
// from the world's own read routes with the visitor's principal, a miss enqueues one render job and answers 202, the
// render job renders through a browser that may load nothing, and the next request is served from R2. A miss is a
// mutation-class action: never on the showcase, only with a fresh human grant, within the daily browser share.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWeft, type TestWeft } from "@weft/api";
import { memoryDailyCounters, parseJob, PDF_FAILURE_TTL_MS, pdfFailureKey, pdfObjectKey, sha256Hex, type ExtrasFlags, type HostedJob, type MessageBatchLike } from "@weft/cf-extras";
import { handleHostedPdf, parsePdfPath, PDF_REENQUEUE_MS, type PdfRouteDeps } from "../../src/extras/slot/pdf-route";
import { handleExtrasBatch } from "../../src/extras/queues";
import { batch, fakeBrowser, fakeSlot, FLAGS_ON, jobDeps, memoryR2, message } from "./helpers";

let w: TestWeft;
let letterId = "", signedId = "", agreementId = "", persona = "";
beforeAll(async () => {
  w = await createTestWeft();
  const call = async (who: string, method: string, path: string, body?: unknown) => (await w.app.request(path, { method, headers: { ...w.uiHeaders(who), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
  const offerId = (await call("usr_dana", "POST", "/v1/offers", { candidateFirst: "Pia", candidateLast: "Strand", candidateEmail: "pia.strand@candidate.example", title: "Mechanical Engineer", departmentId: "dpt_hardware", workState: "CA", baseCents: 15_000_000, startDate: "2026-11-16" })).data.offer_id as string;
  const sent = (await call("usr_dana", "POST", `/v1/offers/${offerId}/send`)).data;
  persona = sent.persona_principal_id;
  const docs = (await call("usr_dana", "GET", `/v1/workers/${sent.reserved_worker_id}/documents`)) as { id: string; kind: string; sha256: string }[];
  letterId = docs.find((d) => d.kind === "offer_letter")!.id;
  agreementId = docs.find((d) => d.kind === "confidentiality_agreement")!.id;
  await call(persona, "POST", `/v1/portal/documents/${letterId}/sign`, { typedName: "Pia Strand", documentSha256: docs.find((d) => d.id === letterId)!.sha256 });
  signedId = letterId;
});
afterAll(async () => { await w?.close(); });

function setup(o: Partial<Omit<PdfRouteDeps, "flags">> & { who?: string | null; flagValues?: ExtrasFlags } = {}) {
  const files = memoryR2();
  const sent: HostedJob[] = [];
  let n = 0;
  const deps: PdfRouteDeps = {
    world: { slot: "slot-1", gen: 3, mode: "slot", snapshot: "snap1" },
    ctx: { human: true, smoke: false },
    app: async (path) => w.app.request(path, { headers: o.who === null ? {} : w.uiHeaders(o.who ?? "usr_dana") }),
    files,
    render: { async send(body) { sent.push(body); } },
    flags: async () => o.flagValues ?? FLAGS_ON,
    browserMsUsed: async () => 0,
    newJobId: () => `obx_r${++n}`,
    pending: new Map(),
    now: () => Date.parse("2026-10-26T15:30:00Z"),
    ...(({ who: _w, flagValues: _f, ...rest }) => rest)(o),
  };
  return { deps, files, sent };
}
const renderAll = async (sent: HostedJob[], files: ReturnType<typeof memoryR2>, browser = fakeBrowser()) => {
  const deps = jobDeps({ "slot-1": fakeSlot({ gen: 3 }) }, { files, launch: browser.launch });
  await handleExtrasBatch(batch("weft-render", sent.map((j) => message(j))) as MessageBatchLike<unknown>, deps);
  return { browser, deps };
};

describe("hosted PDF route", () => {
  it("never reaches R2, the Lobby or the render queue from inside a transaction (IO_IN_TX)", async () => {
    const asked: string[] = [];
    const s = setup({ guard: { assertNotInTx(what) { asked.push(what); throw Object.assign(new Error(`IO_IN_TX: ${what}`), { code: "IO_IN_TX" }); } } });
    await expect(handleHostedPdf(`/api/_hosted/pdf/offer_letter/${letterId}`, s.deps)).rejects.toThrow(/IO_IN_TX: R2\.get/);
    expect(s.sent).toEqual([]);
    // Outside a transaction every I/O step asks first: R2, the Lobby's browser counter, R2 again and the render queue.
    const t = setup({ guard: { assertNotInTx(what) { asked.push(what); } } });
    asked.length = 0;
    expect((await handleHostedPdf(`/api/_hosted/pdf/offer_letter/${letterId}`, t.deps)).status).toBe(202);
    expect(asked).toEqual(["R2.get", "LobbyDO.extrasCounterPeek", "R2.head", "Queue.send"]);
  });

  it("renders an offer letter once: 202 and one job, then the PDF from R2", async () => {
    const s = setup();
    const path = `/api/_hosted/pdf/offer_letter/${letterId}`;
    const first = await handleHostedPdf(path, s.deps);
    expect(first.status).toBe(202);
    expect(first.headers.get("retry-after")).toBe("5");
    expect(await first.json()).toEqual({ status: "rendering", retryAfterS: 5 });
    expect((await handleHostedPdf(path, s.deps)).status).toBe(202);
    expect(s.sent).toHaveLength(1);
    const job = s.sent[0]!;
    expect(parseJob(job).ok).toBe(true);
    expect(job).toMatchObject({ kind: "render.pdf", slot: "slot-1", gen: 3, pdf: "offer_letter", subjectId: letterId });
    const html = (job as { html: string }).html;
    expect(html).toContain("Pia Strand");
    expect(html).toContain("Offer letter");
    expect((job as { sha256: string }).sha256).toBe(await sha256Hex(html));

    const { browser } = await renderAll(s.sent, s.files);
    expect(browser.log.jsEnabledAtContent).toBe(false);
    expect(browser.log.requests.every((r) => r.aborted)).toBe(true);
    const pdf = await handleHostedPdf(path, s.deps);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe(`attachment; filename="weft-offer-letter-${letterId}.pdf"`);
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    expect(s.sent).toHaveLength(1);
    expect(s.files.objects.has(pdfObjectKey({ scope: "world", slot: "slot-1", gen: 3, sha256: (job as { sha256: string }).sha256 }))).toBe(true);
  });

  it("renders a signed agreement with its signature, and refuses one that is not signed", async () => {
    const s = setup();
    expect((await handleHostedPdf(`/api/_hosted/pdf/signed_agreement/${agreementId}`, s.deps)).status).toBe(409);
    expect((await handleHostedPdf(`/api/_hosted/pdf/signed_agreement/${signedId}`, s.deps)).status).toBe(202);
    const html = (s.sent[0] as { html: string }).html;
    expect(html).toContain("Typed name: Pia Strand");
    expect(html).toContain("Signed electronically");
  });

  it("renders a pay stub from the paycheck and its run", async () => {
    const s = setup();
    expect((await handleHostedPdf("/api/_hosted/pdf/pay_stub/pyc_0001", s.deps)).status).toBe(202);
    const html = (s.sent[0] as { html: string }).html;
    const pc = (await (await w.app.request("/v1/paychecks/pyc_0001", { headers: w.uiHeaders("usr_dana") })).json()) as { workerName: string; net: { display: string } };
    expect(html).toContain(pc.workerName.replace(/&/g, "&amp;"));
    expect(html).toContain(pc.net.display);
    expect(html).toContain("Pay period");
    expect((await handleHostedPdf("/api/_hosted/pdf/pay_stub/doc_0001", s.deps)).status).toBe(404);
  });

  it("passes the app's own refusals through, so persona scope holds", async () => {
    const s = setup({ who: null });
    const r = await handleHostedPdf("/api/_hosted/pdf/pay_stub/pyc_0001", s.deps);
    expect(r.status).toBe(401);
    expect((await handleHostedPdf("/api/_hosted/pdf/offer_letter/doc_9999", setup().deps)).status).toBe(404);
    expect((await handleHostedPdf("/api/_hosted/pdf/tax_return/doc_0001", setup().deps)).status).toBe(404);
    expect(s.sent).toHaveLength(0);
    expect(parsePdfPath("/_hosted/pdf/pay_stub/pyc_0001")).toEqual({ kind: "pay_stub", subjectId: "pyc_0001" });
    expect(parsePdfPath("/api/_hosted/pdf/pay_stub/../x")).toBeNull();
  });

  it("a miss needs a lease and a human grant, the flag and browser time; the showcase serves only seed copies", async () => {
    const path = `/api/_hosted/pdf/offer_letter/${letterId}`;
    const showcase = setup({ world: { slot: "showcase", gen: 1, mode: "showcase", snapshot: "snap1" } });
    const r1 = await handleHostedPdf(path, showcase.deps);
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ code: "LEASE_REQUIRED" });
    // A seed copy rendered by the operator under seed/<snapshot>/ is served to everyone.
    const html = (await (async () => { const s = setup(); await handleHostedPdf(path, s.deps); return (s.sent[0] as { html: string }).html; })());
    await showcase.files.put(pdfObjectKey({ scope: "seed", snapshot: "snap1", sha256: await sha256Hex(html) }), new TextEncoder().encode("%PDF-seed"));
    expect((await handleHostedPdf(path, showcase.deps)).status).toBe(200);

    const noGrant = setup({ ctx: { human: false, smoke: false } });
    const r2 = await handleHostedPdf(path, noGrant.deps);
    expect(r2.status).toBe(428);
    expect(await r2.json()).toMatchObject({ code: "TURNSTILE_REQUIRED" });
    expect((await handleHostedPdf(path, setup({ ctx: { human: false, smoke: true }, world: { slot: "slot-smoke", gen: 1, mode: "smoke", snapshot: "snap1" } }).deps)).status).toBe(202);

    const off = setup({ flagValues: { ...FLAGS_ON, pdf: false } });
    expect(await (await handleHostedPdf(path, off.deps)).json()).toMatchObject({ code: "PDF_DISABLED" });
    const spent = setup({ browserMsUsed: async () => 300_000 });
    const r3 = await handleHostedPdf(path, spent.deps);
    expect(r3.status).toBe(503);
    expect(await r3.json()).toMatchObject({ code: "PDF_BUDGET", retryAfterS: 30_600 });
    // A render reserves 35 s, so 265.1 s used is already too much to start one.
    const almost = setup({ browserMsUsed: async () => 265_001 });
    expect(await (await handleHostedPdf(path, almost.deps)).json()).toMatchObject({ code: "PDF_BUDGET" });
    expect(off.sent.length + spent.sent.length + almost.sent.length + noGrant.sent.length + showcase.sent.length).toBe(0);
  });

  it("ends the polling when a render failed for good, and lets a new request try again after the marker's time", async () => {
    let t = Date.parse("2026-10-26T15:30:00Z");
    const s = setup({ now: () => t });
    const path = `/api/_hosted/pdf/offer_letter/${letterId}`;
    expect((await handleHostedPdf(path, s.deps)).status).toBe(202);
    const job = s.sent[0] as Extract<HostedJob, { kind: "render.pdf" }>;
    // The render fails for good (here: the browser share ran out in the consumer), and the consumer leaves its marker.
    const counters = memoryDailyCounters();
    await counters.add("pdf.browser_ms", 300_000);
    const deps = jobDeps({ "slot-1": fakeSlot({ gen: 3 }) }, { files: s.files, launch: fakeBrowser().launch, counters, now: () => new Date(t) });
    await handleExtrasBatch(batch("weft-render", [message(job)]) as MessageBatchLike<unknown>, deps);
    const key = pdfObjectKey({ scope: "world", slot: "slot-1", gen: 3, sha256: job.sha256 });
    expect(s.files.objects.has(pdfFailureKey(key))).toBe(true);
    t += 5_000;
    const r = await handleHostedPdf(path, s.deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "PDF_BUDGET" });
    // Any other permanent failure answers PDF_RENDER_FAILED, with the marker's remaining time as retry-after.
    await s.files.put(pdfFailureKey(key), "{}", { customMetadata: { code: "PDF_RENDER_FAILED", at: new Date(t).toISOString() } });
    t += 60_000;
    const failed = await handleHostedPdf(path, s.deps);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "PDF_RENDER_FAILED", retryAfterS: (PDF_FAILURE_TTL_MS - 60_000) / 1000 });
    expect(s.sent).toHaveLength(1);
    // Once the marker is old, the next request queues a fresh render.
    t += PDF_FAILURE_TTL_MS;
    expect((await handleHostedPdf(path, s.deps)).status).toBe(202);
    expect(s.sent).toHaveLength(2);
    // A pending render is queued again only after PDF_REENQUEUE_MS, in case its job was lost.
    t += PDF_REENQUEUE_MS - 1;
    await handleHostedPdf(path, s.deps);
    expect(s.sent).toHaveLength(2);
    t += 2;
    await handleHostedPdf(path, s.deps);
    expect(s.sent).toHaveLength(3);
  });

  it("refuses a document too large to render before it is queued", async () => {
    const big = { id: "doc_0900", kind: "offer_letter", title: "Offer letter", status: "sent", sha256: "a".repeat(64), sentAt: null, bodyText: "Long clause. ".repeat(9_000), signature: null };
    const s = setup({ app: async (p) => Response.json(p === "/v1/company" ? { company: { legalName: "Larkspur Labs" } } : big) });
    const r = await handleHostedPdf("/api/_hosted/pdf/offer_letter/doc_0900", s.deps);
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ code: "PDF_TOO_LARGE" });
    expect(s.sent).toHaveLength(0);
  });

  it("the render job honours the daily browser share", async () => {
    const s = setup();
    await handleHostedPdf(`/api/_hosted/pdf/offer_letter/${letterId}`, s.deps);
    const counters = memoryDailyCounters();
    await counters.add("pdf.browser_ms", 300_000);
    const browser = fakeBrowser();
    const deps = jobDeps({ "slot-1": fakeSlot({ gen: 3 }) }, { files: s.files, launch: browser.launch, counters });
    await handleExtrasBatch(batch("weft-render", [message(s.sent[0])]) as MessageBatchLike<unknown>, deps);
    expect(browser.log.launches).toBe(0);
    expect(deps.db.rows("failed_jobs")).toMatchObject([{ code: "PDF_BUDGET" }]);
  });
});
