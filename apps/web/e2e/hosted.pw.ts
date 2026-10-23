// The hosted web on Workers static assets (track cf5-web; docs/cloudflare/design.md 3.5, 4.5 and 6.2), against the
// real export served by wrangler's asset Worker: deep links render from the `_` shells through `_redirects`, the CSP
// from `_headers` lets the app run, a hidden tab makes no request, an idle tab with the change feed connected makes at
// most one request a minute, commit frames refetch only what they touched, the hosted shell's Start, 428 and
// lease-ended flows work, and dictation, PDFs and the model switch work against stand-ins that refuse what the real
// routes refuse. /api and the socket are answered by the test (e2e/hosted-fixtures.ts).
import { expect, test } from "@playwright/test";
import { pcmWavInfo } from "../../../packages/cf-extras/src/wav";
import { cspViolations, hide, installHosted, settle, status } from "./hosted-fixtures";

test.describe("static export on Workers assets", () => {
  test("a record deep link renders from its section's shell, with the CSP in force and no violations", async ({ page }) => {
    const h = await installHosted(page);
    const res = await page.goto("/app/people/wrk_0001/");
    expect(res?.status()).toBe(200);
    const csp = res?.headers()["content-security-policy"] ?? "";
    // Two policies, both enforced: the baseline on /* and this route's hash policy (Workers joins them with a comma).
    expect(csp).toMatch(/script-src 'self' 'sha256-[^']+'/);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com");
    expect(csp.match(/default-src 'self'/g)).toHaveLength(2);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Dana Whitfield (demo)");
    expect(h.api.some((r) => r.path === "/api/v1/workers/wrk_0001")).toBe(true);
    expect(h.api.some((r) => r.path.startsWith("/api/v1/workers/_"))).toBe(false);
    expect(await cspViolations(page)).toEqual([]);
    expect(h.errors).toEqual([]);   // no hydration mismatch: the shell hydrates with `_`, then reads the URL
  });

  test("client navigation from a list to a record uses the shell's payload", async ({ page }) => {
    const h = await installHosted(page);
    await page.goto("/app/people/");
    const link = page.locator('a[href^="/app/people/wrk_0002"]').first();
    await link.click();
    await expect(page).toHaveURL(/\/app\/people\/wrk_0002\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Imani Ferreira (demo)");
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/people\/$/);
    expect(h.errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test("a record link without its trailing slash reaches the shell through the hosted 404 page", async ({ page }) => {
    await installHosted(page);
    const nope = await page.goto("/no/such/page/");
    expect(nope?.status()).toBe(404);
    expect(nope?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");   // the baseline policy
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await page.goto("/app/people/wrk_0001");
    await expect(page).toHaveURL(/\/app\/people\/wrk_0001\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Dana Whitfield (demo)");
  });

  test("every other record section serves its shell", async ({ page }) => {
    const h = await installHosted(page);
    for (const [path, id] of [["/app/payroll/pay_x/", "pay_x"], ["/app/runs/run_x/", "run_x"], ["/app/routines/rt_people_digest/", "rt_people_digest"], ["/app/offboarding/off_x/", "off_x"]] as const) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.locator("body"), path).toContainText(/./);
      expect(await page.evaluate(() => location.pathname)).toBe(path);
      void id;
    }
    expect(h.errors.filter((e) => /#41[89]|#42[2-5]|hydrat/i.test(e))).toEqual([]);
  });
});

test.describe("the static landing", () => {
  test("an unleased visit makes no API request; a leased visitor's browser refreshes the numbers from their world", async ({ browser }) => {
    const anon = await browser.newPage();
    const ah = await installHosted(anon);
    await anon.goto("/");
    await expect(anon.getByTestId("marketing-stats")).toBeVisible();
    await anon.waitForTimeout(3_000);
    expect(ah.api).toEqual([]);
    expect(ah.sockets).toHaveLength(0);
    await anon.close();

    const leased = await browser.newPage();
    const lh = await installHosted(leased);
    await leased.addInitScript((exp) => localStorage.setItem("weft.hosted.lease.v1", JSON.stringify({ slot: "slot-1", gen: 4, expiresAt: exp })), new Date(Date.now() + 3_600_000).toISOString());
    await leased.goto("/");
    await expect(leased.getByTestId("marketing-stats")).toHaveAttribute("data-source", "live");
    expect(lh.api.map((r) => r.path).sort()).toEqual(["/api/v1/health", "/api/v1/stats"]);
    expect(await cspViolations(leased)).toEqual([]);
    await leased.close();
  });
});

test.describe("polling discipline", () => {
  test("a hidden tab makes 0 API requests in 60 s; an idle visible tab with the feed connected makes at most 1", async ({ browser }) => {
    // Two tabs at once, so the two 60 s windows overlap. The hidden one's socket is refused (so without the pause it
    // would poll at the hosted intervals and retry the socket); the visible one's socket is accepted and answers pings.
    const hiddenCtx = await browser.newContext();
    const visibleCtx = await browser.newContext();
    const hp = await hiddenCtx.newPage();
    const vp = await visibleCtx.newPage();
    const hh = await installHosted(hp, { acceptSockets: false });
    const vh = await installHosted(vp);
    await Promise.all([hp.goto("/app/"), vp.goto("/app/")]);
    await Promise.all([expect(hp.getByTestId("hosted-banner")).toBeVisible(), expect(vp.getByTestId("hosted-banner")).toBeVisible()]);
    await expect.poll(() => vh.sockets.length).toBe(1);
    await Promise.all([settle(hp, hh), settle(vp, vh)]);
    // The hidden tab polls while visible (its feed is down), which is what makes the pause visible below.
    expect(hh.api.length).toBeGreaterThan(5);
    await hide(hp);
    const t0 = Date.now();
    const hiddenSockets = hh.sockets.length;
    const visibleSockets = vh.sockets.length;
    await vp.waitForTimeout(60_000);
    expect(hh.since(t0)).toEqual([]);
    expect(hh.sockets.length).toBe(hiddenSockets);
    const visible = vh.since(t0);
    expect(visible.length, JSON.stringify(visible)).toBeLessThanOrEqual(1);
    expect(vh.sockets.length).toBe(visibleSockets);
    await hiddenCtx.close();
    await visibleCtx.close();
  });

  test("a commit frame refetches only the queries whose tables it wrote", async ({ page }) => {
    const h = await installHosted(page);
    await page.goto("/app/");
    await expect.poll(() => h.sockets.length).toBe(1);
    await settle(page, h);
    const t0 = Date.now();
    h.frame({ type: "commit", seq: 1, tables: ["proposals"] });
    await expect.poll(() => h.since(t0).some((r) => r.path.startsWith("/api/v1/proposals"))).toBe(true);
    await page.waitForTimeout(1_000);
    // Queries whose last read listed tables the commit did not write stay put (the clock and health read settings);
    // a read that failed in the mock world listed no tables, so it is refetched on any commit, by design.
    const got = h.since(t0).map((r) => r.path);
    expect(got.filter((p) => /^\/api\/v1\/(sim\/clock|health|offers|workers)/.test(p)), JSON.stringify(h.since(t0))).toEqual([]);
  });
});

test.describe("hosted shell", () => {
  test("the shared showcase offers Start my demo company; Turnstile and the lease switch the tab to the visitor's world", async ({ page }) => {
    const h = await installHosted(page, { session: status({ world: "showcase", lease: null }) });
    await page.goto("/app/");
    const banner = page.getByTestId("hosted-banner");
    await expect(banner).toHaveAttribute("data-world", "showcase");
    await page.getByTestId("hosted-start-cta").click();
    await expect(page.getByTestId("hosted-start")).toBeVisible();
    await expect(banner).toHaveAttribute("data-world", "slot");
    await expect(page.getByTestId("hosted-lease-left")).toContainText(/min left/);
    await expect(page.getByTestId("hosted-start")).toHaveCount(0);
    const lease = h.api.find((r) => r.path === "/api/_session/lease");
    expect(lease?.method).toBe("POST");
    await expect.poll(() => h.sockets.length).toBe(1);
  });

  test("a mutation answered 428 runs the human check, refreshes the grant and retries once", async ({ page }) => {
    const h = await installHosted(page);
    h.queue("POST /api/v1/sim/clock/advance", { status: 428, body: { _tag: "Forbidden", code: "TURNSTILE_REQUIRED", message: "A fresh check is needed" } });
    await page.goto("/app/simulators/");
    await page.getByTestId("sim-advance-1d").click();
    await expect.poll(() => h.api.filter((r) => r.path === "/api/v1/sim/clock/advance").length).toBe(2);
    expect(h.api.some((r) => r.path === "/api/_session/verify" && r.method === "POST")).toBe(true);
    await expect(page.getByTestId("hosted-grant")).toHaveCount(0);
    await expect(page.getByTestId("sim-clock-now")).toContainText("Oct 27");
  });

  test("a showcase mutation answered LEASE_REQUIRED opens Start my demo company", async ({ page }) => {
    const h = await installHosted(page, { session: status({ world: "showcase", lease: null }) });
    h.queue("POST /api/v1/sim/clock/advance", { status: 409, body: { _tag: "Conflict", code: "LEASE_REQUIRED", message: "The shared demo is read only" } });
    h.queue("POST /api/_session/lease", { status: 200, body: { status: "waitlist", position: 1, poolSize: 2, etaMinutes: 6 } });
    await page.goto("/app/simulators/");
    await page.getByTestId("sim-advance-1d").click();
    const dialog = page.getByTestId("hosted-start");
    await expect(dialog).toContainText("The shared demo company is read only");
    await expect(page.getByTestId("hosted-start-blocked")).toContainText("All 2 demo companies are in use. One frees in about 6 min.");
    await expect(page.getByTestId("hosted-start-retry")).toBeVisible();
  });

  test("a lease frame that ends the lease shows the lease-ended screen", async ({ page }) => {
    const h = await installHosted(page);
    await page.goto("/app/");
    await expect.poll(() => h.sockets.length).toBe(1);
    h.session = status({ world: "showcase", lease: null });
    h.frame({ type: "lease", state: "ended", gen: 4 });
    await expect(page.getByTestId("hosted-ended")).toBeVisible();
    await page.getByRole("button", { name: "Browse the shared demo" }).click();
    await expect(page.getByTestId("hosted-banner")).toHaveAttribute("data-world", "showcase");
  });

  test("the Platform and model comparison pages read the hosted routes", async ({ page }) => {
    const h = await installHosted(page);
    h.queue("GET /api/_hosted/platform", { status: 200, body: { day: "2026-10-26", level: 0, dollars: { spentUsd: 0.0042, dayCapUsd: 2, runCapUsd: 0.1 }, neurons: { used: 12, cap: 5000 }, restoresLeft: 3, leases: { active: 1, pool: 2, waitlist: 0 }, deadLetters: 0, lastSweepAt: null, shares: { doRowsWritten: { used: 1200, share: 60000 } } } });
    h.queue("GET /api/_hosted/models", { status: 200, body: [{ provider: "workers_ai", model: "@cf/openai/gpt-oss-120b", runs: 2, avgSteps: 4, groundedRate: 1, avgCostUsdMicros: 800, avgNeurons: 300, p50LatencyMs: 900, outcomes: { done: 2 } }] });
    await page.goto("/app/platform/");
    await expect(page.getByTestId("platform-dollars")).toContainText("$0.0042 of $2.00");
    await page.getByRole("link", { name: "Model comparison" }).click();
    await expect(page.getByTestId("models-table")).toContainText("Workers AI gpt-oss-120b");
    expect(await cspViolations(page)).toEqual([]);
  });

  test("the hosted reset goes through the front Worker, says how many resets are left and reopens the feed", async ({ page }) => {
    const h = await installHosted(page);
    h.queue("POST /api/v1/sim/reset", { status: 200, body: { ok: true, gen: 5, resetsLeft: 2 } });
    await page.goto("/app/");
    await expect.poll(() => h.sockets.length).toBe(1);
    await page.getByTestId("viewing-as").click();
    await page.getByRole("menuitem", { name: /Reset demo data/ }).click();
    await expect(page.locator("[data-tour-reset-note]")).toContainText("3 resets are left");
    const t0 = Date.now();
    await page.locator("[data-tour-reset-go]").click();
    await expect.poll(() => h.since(t0).some((r) => r.path === "/api/v1/sim/reset" && r.method === "POST")).toBe(true);
    await expect.poll(() => h.since(t0).some((r) => r.path === "/api/_session")).toBe(true);
    await expect.poll(() => h.sockets.length).toBe(2);
  });

  test("the MCP dialog mints the lease's key once and shows the client config", async ({ page }) => {
    const h = await installHosted(page);
    h.queue("POST /api/_hosted/mcp-key", { status: 200, body: { key: "wk_mcp_slot-1_4_abcdefghijklmnop", url: "http://127.0.0.1:5790/mcp", expiresAt: "2026-10-26T18:30:00.000Z" } });
    await page.goto("/app/settings/");
    await page.getByTestId("hosted-mcp-open").click();
    await page.getByTestId("hosted-mcp-mint").click();
    await expect(page.getByTestId("hosted-mcp-key")).toContainText("wk_mcp_slot-1_4_abcdefghijklmnop");
    await expect(page.getByTestId("hosted-mcp-key")).toContainText('"Authorization": "Bearer wk_mcp_slot-1_4_abcdefghijklmnop"');
    expect(h.api.filter((r) => r.path === "/api/_hosted/mcp-key")).toHaveLength(1);
  });

  test("Help in Cmd+K searches only when asked, and shows the hits", async ({ page }) => {
    const h = await installHosted(page);
    h.queue("GET /api/_hosted/help", { status: 200, body: { ok: true, hits: [{ title: "The guided tour", path: "docs/tour.md", snippet: "A three minute walk through the demo company.", score: 0.71 }], leftToday: 29 } });
    await page.goto("/app/");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("cmdk-input").fill("guided tour");
    await page.waitForTimeout(800);
    expect(h.api.some((r) => r.path.startsWith("/api/_hosted/help"))).toBe(false);
    await page.getByRole("option", { name: /Search Weft help for "guided tour"/ }).click();
    await expect(page.getByTestId("hosted-help")).toContainText("The guided tour");
    await expect(page.getByTestId("hosted-help")).toContainText("29 searches left today");
    expect(h.api.filter((r) => r.path.startsWith("/api/_hosted/help"))).toEqual([expect.objectContaining({ path: "/api/_hosted/help?q=guided%20tour" })]);
  });

  test("Dictate records a clip, sends it as 16 kHz mono WAV, fills the composer and sends nothing to the agent", async ({ browser }) => {
    // The microphone is a Web Audio tone, so the button's own MediaRecorder makes a real compressed clip (WebM with
    // Opus in Chromium). Dictation (the extras' own code, in the stand-in) refuses that unless the button converts it.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ac = new AudioContext();
        const tone = ac.createOscillator();
        const out = ac.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        await ac.resume();
        return out.stream;
      };
    });
    const h = await installHosted(page);
    await page.goto("/app/");
    // The stand-in refuses what hosted refuses: the recorder's clip as it comes.
    const raw = await page.evaluate(async () => {
      const r = await fetch("/api/_hosted/dictate", { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]) });
      return (await r.json()) as { ok: boolean; code?: string };
    });
    expect(raw).toMatchObject({ ok: false, code: "DICTATION_UNREADABLE" });
    const dictate = page.getByTestId("hosted-dictate");
    await dictate.click();
    await expect(dictate).toHaveAttribute("data-state", "recording");
    await page.waitForTimeout(1_200);
    await dictate.click();
    await expect(page.getByTestId("agent-composer")).toHaveValue("when do we pay salaries");
    const clip = h.dictated.at(-1)!;
    expect(h.dictated).toHaveLength(2);
    expect(clip.contentType).toBe("audio/wav");
    expect(clip.result).toMatchObject({ ok: true, text: "when do we pay salaries" });
    const wav = pcmWavInfo(new Uint8Array(clip.bytes));
    expect(wav).toMatchObject({ format: "pcm", sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataOffset: 44 });
    expect(wav!.seconds).toBeGreaterThan(0.5);
    expect(wav!.seconds).toBeLessThan(10);
    expect(h.api.some((r) => r.path === "/api/v1/agent/runs" && r.method === "POST")).toBe(false);
    await ctx.close();
  });

  const OFFER = { candidateFirst: "Noor", candidateLast: "Castellanos", title: "Senior Firmware Engineer", workState: "CO", baseCents: 16_800_000, startDate: "2026-11-02", expiresOn: null, allowed: [], personaPrincipalId: null };

  test("a PDF button names the offer's document, waits while it renders and downloads it; an offer without one has none", async ({ page }) => {
    const h = await installHosted(page);
    h.override("GET /api/v1/offers", { status: 200, body: { hasMore: false, count: 2, data: [
      { ...OFFER, id: "offr_0003", status: "accepted", documentId: "doc_0229" },
      { ...OFFER, id: "offr_0001", candidateFirst: "Ravi", status: "sent", documentId: null },
    ] } });
    await page.goto("/app/hiring/");
    const accepted = page.locator('[data-offer="offr_0003"]');
    await expect(page.locator('[data-offer="offr_0001"]')).toBeVisible();
    await expect(page.locator('[data-offer="offr_0001"] [data-testid^="hosted-pdf-"]')).toHaveCount(0);
    await expect(accepted.getByTestId("hosted-pdf-signed_agreement")).toHaveAttribute("data-subject", "doc_0229");
    const download = page.waitForEvent("download", { timeout: 30_000 });
    await accepted.getByTestId("hosted-pdf-offer_letter").click();
    await expect(accepted.getByTestId("hosted-pdf-offer_letter")).toContainText("Making the PDF...");
    expect((await download).suggestedFilename()).toBe("offer-letter-doc_0229.pdf");
    // The first request enqueued the render and answered 202; the button waited the 5 s it asked for and asked again.
    const asks = h.api.filter((r) => r.path === "/api/_hosted/pdf/offer_letter/doc_0229");
    expect(asks).toHaveLength(2);
    expect(asks[1]!.at - asks[0]!.at).toBeGreaterThanOrEqual(4_500);
    await expect(accepted.getByTestId("hosted-pdf-offer_letter")).toContainText("Offer letter PDF");
  });

  test("a render that fails while the button waits ends with the route's message and saves nothing", async ({ page }) => {
    const h = await installHosted(page);
    h.override("GET /api/v1/offers", { status: 200, body: { hasMore: false, count: 1, data: [{ ...OFFER, id: "offr_0003", status: "sent", documentId: "doc_0229" }] } });
    h.queue("GET /api/_hosted/pdf/offer_letter/doc_0229",
      { status: 202, body: { status: "rendering", retryAfterS: 1 } },
      { status: 503, body: { _tag: "Refused", code: "PDF_RENDER_FAILED", message: "This document could not be rendered; try again in a few minutes", retryAfterS: 600 } });
    let downloads = 0;
    page.on("download", () => { downloads++; });
    await page.goto("/app/hiring/");
    await page.getByTestId("hosted-pdf-offer_letter").click();
    await expect(page.getByTestId("hosted-pdf-offer_letter").locator("xpath=..").getByRole("alert")).toHaveText("This document could not be rendered; try again in a few minutes");
    expect(h.api.filter((r) => r.path === "/api/_hosted/pdf/offer_letter/doc_0229")).toHaveLength(2);
    expect(downloads).toBe(0);
  });

  test("the model switch writes the world's provider and the session shows it", async ({ page }) => {
    const h = await installHosted(page);
    await page.goto("/app/simulators/");
    await expect(page.getByTestId("hosted-model-current")).toContainText("New runs use OpenAI gpt-5.6-luna.");
    const t0 = Date.now();
    await page.locator('input[data-provider="workers_ai"]').check();
    await expect(page.getByTestId("hosted-model-current")).toContainText("New runs use Workers AI gpt-oss-120b.");
    expect(h.since(t0).filter((r) => r.method === "PUT").map((r) => r.path)).toEqual(["/api/_hosted/model"]);
    expect(h.worldProvider).toBe("workers_ai");
    // A fresh load reads the world's choice from the session alone.
    await page.reload();
    await expect(page.getByTestId("hosted-model-current")).toContainText("New runs use Workers AI gpt-oss-120b.");
    await expect(page.locator('input[data-provider="workers_ai"]')).toBeChecked();
  });
});
