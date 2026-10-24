// Pure parts of the hosted shell (track cf5-web; docs/cloudflare/design.md 3.5, 5 and 6): record ids from the URL,
// trailing slashes, the 404 page's shell redirect, the lease hint, every line of hosted copy, and the small request
// helpers (help, MCP key, PDF, dictation, model switch, the landing's islands) over fake fetches.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { idFromPath, resolveRouteId, ROUTE_SECTIONS, SHELL_ID } from "../src/lib/route-id";
import { hydrationPathname, normalizePath, shellPathname } from "../src/lib/pathname";
import { shellRedirect } from "../src/components/hosted/not-found-redirect";
import { readLeaseHint, writeLeaseHint } from "../src/lib/hosted/hint";
import { blockedText, HOSTED_COPY, hostedResetError, levelText, providerLabel, providerNote, resetNote, usd, usdMicros } from "../src/components/hosted/copy";
import { helpPath, helpSummary, searchHelp } from "../src/components/hosted/help-search";
import { mcpClientConfig, mintMcpKey } from "../src/components/hosted/mcp-connect";
import { downloadPdf, PDF_WAIT_MAX_MS, pdfPath, pdfRetryMs } from "../src/components/hosted/pdf-button";
import { appendDictation, toDictationWav, transcribe, type OfflineAudio } from "../src/components/hosted/dictate-button";
import { latencyText, outcomesText, rateText } from "../src/components/hosted/models-view";
import { SHARE_LABEL, shareLine } from "../src/components/hosted/platform-view";
import { offerPdfs } from "../src/components/app/hiring/hiring-view";
import { pcmWavInfo } from "../../../packages/cf-extras/src/wav";
import { buildPlatformReadout } from "../../../packages/cf-extras/src/platform";
import { SHARES } from "../../cf/src/core/lobby/policy";
import { MODEL_CHOICES, switchModel } from "../src/components/hosted/model-switch";
import { traceDelayMs } from "../src/lib/api/sse";
import { FALLBACK_STATS, toLandingStats } from "../src/components/marketing/live";
import { statsNote } from "../src/components/marketing/sections";
import { readSnapshotStats } from "../src/components/marketing/snapshot-stats";
import { loadHostedLanding, resetHostedLanding } from "../src/components/marketing/hosted-landing";

type Call = { url: string; init?: RequestInit };
function fakeFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return answer(String(input), init); }) as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("record ids from the URL", () => {
  it("reads the id from a record path, slash or not, and nothing else", () => {
    expect(ROUTE_SECTIONS).toEqual(["people", "payroll", "runs", "routines", "offboarding"]);
    expect(idFromPath("people", "/app/people/wrk_0026/")).toBe("wrk_0026");
    expect(idFromPath("people", "/app/people/wrk_0026")).toBe("wrk_0026");
    expect(idFromPath("runs", "/app/runs/run%20x/")).toBe("run x");
    expect(idFromPath("people", "/app/people/")).toBeNull();
    expect(idFromPath("people", "/app/people/wrk_0026/extra")).toBeNull();
    expect(idFromPath("people", "/app/payroll/pay_1/")).toBeNull();
    expect(idFromPath("people", null)).toBeNull();
    expect(idFromPath("people", "/app/people/%E0%A4%A/")).toBeNull();
  });
  it("passes a real id through and resolves only the shell", () => {
    expect(resolveRouteId("people", "wrk_0001", "/app/people/wrk_0026/")).toBe("wrk_0001");   // Node: the page has the id
    expect(resolveRouteId("people", SHELL_ID, "/app/people/wrk_0026/")).toBe("wrk_0026");
    expect(resolveRouteId("people", SHELL_ID, "/app/people/_/")).toBe("_");
    expect(resolveRouteId("payroll", SHELL_ID, "/somewhere")).toBe("_");
  });
  it("drops the export's trailing slash and nothing else", () => {
    expect(normalizePath("/app/people/")).toBe("/app/people");
    expect(normalizePath("/app/people")).toBe("/app/people");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/app//")).toBe("/app");
  });
  it("hydrates a record page with its shell's path in the export only", () => {
    expect(shellPathname("/app/people/wrk_0026")).toBe("/app/people/_");
    expect(shellPathname("/app/runs/run_1")).toBe("/app/runs/_");
    expect(shellPathname("/app/people")).toBe("/app/people");
    expect(shellPathname("/app/settings/permissions")).toBe("/app/settings/permissions");
    expect(shellPathname("/app/nope/x")).toBe("/app/nope/x");
    expect(hydrationPathname("/app/people/wrk_0026", true)).toBe("/app/people/_");
    expect(hydrationPathname("/app/people/wrk_0026", false)).toBe("/app/people/wrk_0026");
    expect(hydrationPathname("/app/people/wrk_0026")).toBe("/app/people/wrk_0026");   // Node and next dev
  });
  it("the hosted 404 sends a slashless record link to its shell URL", () => {
    expect(shellRedirect("/app/people/wrk_0026", "?tab=pay", "#x")).toBe("/app/people/wrk_0026/?tab=pay#x");
    expect(shellRedirect("/app/routines/rt_people_digest")).toBe("/app/routines/rt_people_digest/");
    expect(shellRedirect("/app/people/wrk_0026/")).toBeNull();
    expect(shellRedirect("/app/nope/x")).toBeNull();
    expect(shellRedirect("/app/people/favicon.ico")).toBeNull();
    expect(shellRedirect("/app/people")).toBeNull();
  });
});

describe("the lease hint", () => {
  it("round-trips while the lease lasts, and reads null once it has expired or is malformed", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    writeLeaseHint({ slot: "slot-1", gen: 2, expiresAt: "2026-10-26T18:00:00.000Z" }, store);
    expect(readLeaseHint(Date.parse("2026-10-26T17:00:00.000Z"), store)).toEqual({ slot: "slot-1", gen: 2, expiresAt: "2026-10-26T18:00:00.000Z" });
    expect(readLeaseHint(Date.parse("2026-10-26T18:00:01.000Z"), store)).toBeNull();
    m.set("weft.hosted.lease.v1", "{not json");
    expect(readLeaseHint(0, store)).toBeNull();
    writeLeaseHint(null, store);
    expect(m.size).toBe(0);
    expect(readLeaseHint(0, null)).toBeNull();
  });
});

describe("hosted copy", () => {
  it("says why a lease was not given", () => {
    expect(blockedText({ status: "waitlist", position: 1, poolSize: 2, etaMinutes: 7.4 })).toBe("All 2 workspaces are in use. One frees in about 7 min. You are number 1 in line.");
    expect(blockedText({ status: "waitlist", position: 3, poolSize: 2, etaMinutes: null })).toBe("All 2 workspaces are in use. You are number 3 in line.");
    // A lease ends after a day without activity, so a long wait reads in hours.
    expect(blockedText({ status: "waitlist", position: 1, poolSize: 2, etaMinutes: 1_380 })).toBe("All 2 workspaces are in use. One frees in about 23 hours. You are number 1 in line.");
    expect(blockedText({ status: "waitlist", position: 1, poolSize: 2, etaMinutes: 40_000 })).toBe("All 2 workspaces are in use. One frees in about 28 days. You are number 1 in line.");
    expect(blockedText({ status: "full", poolSize: 2, etaMinutes: 4.2 })).toBe("All 2 workspaces are in use and the line is full. One frees in about 4 min. Try again later.");
    expect(blockedText({ status: "full", poolSize: 2, etaMinutes: null })).toBe("All 2 workspaces are in use and the line is full. Try again later.");
    expect(blockedText({ status: "budget", reopensAt: "2026-10-27T00:00:00.000Z" })).toBe("Today's budget is used up; back after 00:00 UTC.");
    expect(blockedText({ status: "ip_limit", reopensAt: "bad" })).toBe("This network has opened as many workspaces as it can today; back after 00:00 UTC.");
    expect(blockedText({ status: "closed", level: 3 })).toContain("paused for today");
  });
  it("reads as a workspace: no demo or fictional wording and no session times (Nitish, 2026-10-23)", () => {
    const lines = [
      ...Object.values(HOSTED_COPY),
      ...(["waitlist", "full", "budget", "ip_limit", "closed"] as const).map((status) => blockedText({ status, position: 1, poolSize: 2, etaMinutes: 5, reopensAt: "x", level: 3 } as never)),
      ...(["paused", "budget", "neurons"] as const).map((reason) => providerNote({ id: "scripted", reason }, true)!),
      ...([0, 1, 2, 3, 4] as const).map(levelText),
      resetNote(), resetNote(2),
      ...[["RESETS_PAUSED", 503], ["RESET_LIMIT", 429], ["HOSTED_RESET_PROFILE", 400], ["LEASE_REQUIRED", 409]].map(([c, s]) => hostedResetError(s as number, c as string)!),
      providerLabel(null),
    ];
    for (const line of lines) {
      expect(line, line).not.toMatch(/demo|fictional|visitor/i);
      expect(line, line).not.toMatch(/\b\d+ (minutes|hours)\b|resets? (are|is) left/);
    }
    expect(Object.keys(HOSTED_COPY)).not.toContain("fictional");
  });
  it("names the provider and why runs fell back to the scripted one", () => {
    expect(providerNote({ id: "openai", reason: "default" }, true)).toBeNull();
    expect(providerNote({ id: "workers_ai", reason: "world" }, true)).toBeNull();
    expect(providerNote({ id: "scripted", reason: "budget" }, true)).toContain("budget is used up");
    expect(providerNote({ id: "scripted", reason: "neurons" }, true)).toContain("Workers AI allowance");
    expect(providerNote({ id: "scripted", reason: "paused" }, true)).toContain("paused");
    expect(providerNote({ id: "openai", reason: "default" }, false)).toContain("paused");
    expect([null, "openai", "workers_ai", "scripted", "anthropic"].map((p) => providerLabel(p as never))).toEqual(["Default", "OpenAI gpt-5.6-luna", "Workers AI gpt-oss-120b", "Scripted, no model calls", "anthropic"]);
    expect(MODEL_CHOICES.map((c) => c.id)).toEqual([null, "openai", "workers_ai", "scripted"]);
  });
  it("explains every degradation level", () => {
    expect(([0, 1, 2, 3, 4] as const).map(levelText).every((t) => t.length > 5)).toBe(true);
  });
  it("hosted reset lines", () => {
    // What a reset does here, with no count of resets left (a lease allows 1,000 since 2026-10-23).
    expect(resetNote(2)).toBe("Here a reset rebuilds your own workspace, with the rich data only.");
    expect(resetNote(undefined)).toBe(resetNote(2));
    expect(hostedResetError(429, "RESET_LIMIT")).toBe("This workspace has used all of its resets.");
    expect(hostedResetError(503, "RESETS_PAUSED")).toContain("paused until 00:00 UTC");
    expect(hostedResetError(400, "HOSTED_RESET_PROFILE")).toContain("rich data only");
    expect(hostedResetError(409, "LEASE_REQUIRED")).toContain("Open your own workspace");
    expect(hostedResetError(500, null)).toBeNull();
  });
  it("money", () => {
    expect([usd(0), usd(0.0012), usd(2), usdMicros(1_234_567)]).toEqual(["$0.00", "$0.0012", "$2.00", "$1.23"]);
  });
  it("Platform and model comparison cells", () => {
    expect(shareLine(1234, 60000)).toBe("1,234 of 60,000 (2%)");
    expect(shareLine(5, 0)).toBe("5 of 0 (0%)");
    expect([rateText(null), rateText(0.916)]).toEqual(["Not measured", "92%"]);
    expect(outcomesText({ failed: 1, done: 12, refused: 0 })).toBe("done 12, failed 1");
    expect(outcomesText({})).toBe("None");
    expect([latencyText(840), latencyText(1234)]).toEqual(["840 ms", "1.2 s"]);
  });
});

describe("hosted requests", () => {
  it("help: one query on request, with the daily cap and failures as lines", async () => {
    expect(helpPath(" pay day ")).toBe("/api/_hosted/help?q=pay%20day");
    const ok = fakeFetch(() => json(200, { ok: true, hits: [{ title: "Tour", path: "docs/tour.md", snippet: "...", score: 0.7 }], leftToday: 29 }));
    const r = await searchHelp("tour", ok.f);
    expect(helpSummary(r)).toBe("1 help page. 29 searches left today.");
    expect(ok.calls[0]!.url).toBe("/api/_hosted/help?q=tour");
    const capped = fakeFetch(() => json(429, { message: "cap" }));
    expect(helpSummary(await searchHelp("tour", capped.f))).toBe("Help search has used its 30 searches for today; back after 00:00 UTC.");
    const down = fakeFetch(() => { throw new Error("offline"); });
    expect((await searchHelp("tour", down.f)).ok).toBe(false);
    expect(helpSummary({ ok: true, hits: [], leftToday: 1 })).toBe("No help pages match. 1 search left today.");
  });

  it("MCP: mints the lease key and writes a Streamable HTTP client config", async () => {
    const mint = { key: "wk_mcp_slot-1_3_abcdefghijklmnop", url: "https://weft.nitish-ratakonda.workers.dev/mcp", expiresAt: "2026-10-26T18:30:00.000Z" };
    const f = fakeFetch(() => json(200, mint));
    expect(await mintMcpKey(f.f)).toEqual(mint);
    expect(f.calls[0]).toMatchObject({ url: "/api/_hosted/mcp-key", init: { method: "POST" } });
    expect(JSON.parse(mcpClientConfig(mint))).toEqual({ mcpServers: { weft: { type: "http", url: mint.url, headers: { Authorization: `Bearer ${mint.key}` } } } });
    await expect(mintMcpKey(fakeFetch(() => json(409, { message: "Open your own workspace first" })).f)).rejects.toThrow("Open your own workspace first");
  });

  const pdfBody = () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } });
  /** The route's 202 while a render runs: `{ status: "rendering", retryAfterS }` and a Retry-After header. */
  const rendering = (retryAfterS: number | null, header: string | null = null) => new Response(
    JSON.stringify({ status: "rendering", ...(retryAfterS === null ? {} : { retryAfterS }) }),
    { status: 202, headers: { "content-type": "application/json", ...(header === null ? {} : { "retry-after": header }) } },
  );

  it("PDF: fetches the kind and subject and saves it under a readable name", async () => {
    expect(pdfPath("pay_stub", "pck 1")).toBe("/api/_hosted/pdf/pay_stub/pck%201");
    const f = fakeFetch(() => pdfBody());
    const saved: { name: string; size: number }[] = [];
    await downloadPdf("offer_letter", "doc_0229", f.f, (b, name) => saved.push({ name, size: b.size }));
    expect(saved).toEqual([{ name: "offer-letter-doc_0229.pdf", size: 4 }]);
    expect(f.calls).toHaveLength(1);
  });

  it("PDF: polls while the render runs (the wait the 202 asks for), then saves the PDF", async () => {
    const answers = [rendering(5, "5"), rendering(null, "3"), pdfBody()];
    const f = fakeFetch(() => answers.shift()!);
    const waits: number[] = [];
    const saved: string[] = [];
    await downloadPdf("offer_letter", "doc_0229", f.f, (_b, name) => saved.push(name), async (ms) => { waits.push(ms); });
    expect(waits).toEqual([5_000, 3_000]);
    expect(f.calls.map((c) => c.url)).toEqual(Array(3).fill("/api/_hosted/pdf/offer_letter/doc_0229"));
    expect(saved).toEqual(["offer-letter-doc_0229.pdf"]);
  });

  it("PDF: the wait is bounded, each one and in all", async () => {
    expect([pdfRetryMs({ retryAfterS: 5 }, null), pdfRetryMs(null, "2"), pdfRetryMs({ retryAfterS: 600 }, "600"), pdfRetryMs({ retryAfterS: 0 }, null)]).toEqual([5_000, 2_000, 15_000, 5_000]);
    expect([pdfRetryMs(null, null), pdfRetryMs(null, "Wed, 21 Oct 2026 07:28:00 GMT"), pdfRetryMs({ retryAfterS: 0.2 }, null)]).toEqual([5_000, 5_000, 1_000]);
    const f = fakeFetch(() => rendering(5, "5"));
    const waits: number[] = [];
    const saved: string[] = [];
    await expect(downloadPdf("pay_stub", "pyc_0001", f.f, (_b, n) => saved.push(n), async (ms) => { waits.push(ms); })).rejects.toThrow("The PDF is still being made. Try again in a minute.");
    expect(waits.reduce((a, b) => a + b, 0)).toBe(PDF_WAIT_MAX_MS);
    expect(f.calls).toHaveLength(PDF_WAIT_MAX_MS / 5_000 + 1);
    expect(saved).toEqual([]);
  });

  it("PDF: a refusal ends the wait with its message, and only a PDF is saved", async () => {
    for (const [status, message] of [[413, "This document is too large to render as a PDF"], [503, "This document could not be rendered; try again in a few minutes"], [404, "No document offr_0003"]] as const) {
      const answers = [rendering(5), json(status, { _tag: "Refused", code: "X", message })];
      const f = fakeFetch(() => answers.shift()!);
      const saved: string[] = [];
      await expect(downloadPdf("offer_letter", "doc_0229", f.f, (_b, n) => saved.push(n), async () => {})).rejects.toThrow(message);
      expect(f.calls).toHaveLength(2);
      expect(saved).toEqual([]);
    }
    const saved: string[] = [];
    await expect(downloadPdf("offer_letter", "doc_0229", fakeFetch(() => json(200, { status: "rendering" })).f, (_b, n) => saved.push(n), async () => {})).rejects.toThrow("The answer was not a PDF.");
    await expect(downloadPdf("pay_stub", "x", fakeFetch(() => json(503, {})).f, (_b, n) => saved.push(n))).rejects.toThrow("The PDF could not be made (503).");
    expect(saved).toEqual([]);
    const typed = fakeFetch(() => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf; charset=binary" } }));
    await downloadPdf("pay_stub", "pyc_0001", typed.f, (_b, n) => saved.push(n));
    expect(saved).toEqual(["pay-stub-pyc_0001.pdf"]);
  });

  it("PDF: an offer's buttons name its document, not the offer, and an offer without one shows none", () => {
    expect(offerPdfs({ status: "accepted", documentId: "doc_0229" })).toEqual([{ kind: "offer_letter", subjectId: "doc_0229" }, { kind: "signed_agreement", subjectId: "doc_0229" }]);
    expect(offerPdfs({ status: "sent", documentId: "doc_0230" })).toEqual([{ kind: "offer_letter", subjectId: "doc_0230" }]);
    expect(offerPdfs({ status: "viewed", documentId: "doc_0230" })).toEqual([{ kind: "offer_letter", subjectId: "doc_0230" }]);
    expect(offerPdfs({ status: "sent", documentId: null })).toEqual([]);
    expect(offerPdfs({ status: "accepted", documentId: null })).toEqual([]);
    expect(offerPdfs({ status: "draft", documentId: null })).toEqual([]);
    expect(offerPdfs({ status: "voided", documentId: "doc_0231" })).toEqual([]);
  });

  /** An OfflineAudioContext stand-in: decodes to `decoded` and renders `rendered`, recording how it was used. */
  function fakeAudio(decoded: { duration: number }, rendered: Float32Array) {
    const made: [number, number, number][] = [];
    const log: string[] = [];
    const audio: OfflineAudio = (channels, frames, sampleRate) => {
      made.push([channels, frames, sampleRate]);
      return {
        decodeAudioData: async (b: ArrayBuffer) => { log.push(`decode ${b.byteLength}`); return decoded; },
        destination: "destination",
        createBufferSource: () => ({ buffer: null, connect: (to: unknown) => log.push(`connect ${String(to)}`), start: () => log.push("start") }),
        startRendering: async () => { log.push("render"); return { getChannelData: (c: number) => { log.push(`channel ${c}`); return rendered; } }; },
      } as unknown as OfflineAudioContext;
    };
    return { audio, made, log };
  }

  it("dictation: the recorder's clip becomes 16 kHz mono 16-bit PCM WAV, cut at 30 s", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const a = fakeAudio({ duration: 2.5 }, samples);
    const wav = await toDictationWav(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9])], { type: "audio/webm;codecs=opus" }), a.audio);
    expect(wav.type).toBe("audio/wav");
    expect(a.made).toEqual([[1, 1, 16_000], [1, 40_000, 16_000]]);
    expect(a.log).toEqual(["decode 5", "connect destination", "start", "render", "channel 0"]);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(pcmWavInfo(bytes)).toEqual({ format: "pcm", sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataOffset: 44, seconds: 5 / 16_000 });
    expect([...new Int16Array(bytes.buffer.slice(44))]).toEqual([0, 16_384, -16_384, 32_767, -32_768]);
    const long = fakeAudio({ duration: 31.2 }, new Float32Array(1));
    await toDictationWav(new Blob([new Uint8Array(1)]), long.audio);
    expect(long.made[1]).toEqual([1, 30 * 16_000, 16_000]);
    const failing: OfflineAudio = () => ({ decodeAudioData: async () => { throw new DOMException("Unable to decode audio data", "EncodingError"); } }) as unknown as OfflineAudioContext;
    await expect(toDictationWav(new Blob([]), failing)).rejects.toThrow("Unable to decode audio data");
  });

  it("dictation: posts the WAV clip, fills the composer and never sends", async () => {
    const f = fakeFetch(() => json(200, { ok: true, text: " when do we pay salaries ", seconds: 3, neurons: 2.3 }));
    const wav = await toDictationWav(new Blob([new Uint8Array(4)]), fakeAudio({ duration: 0.001 }, new Float32Array(16)).audio);
    expect(await transcribe(wav, f.f)).toBe("when do we pay salaries");
    expect(f.calls[0]).toMatchObject({ url: "/api/_hosted/dictate", init: { method: "POST", headers: { "content-type": "audio/wav" }, body: wav } });
    await transcribe(new Blob([new Uint8Array(2)]), f.f);
    expect(f.calls[1]).toMatchObject({ init: { headers: { "content-type": "audio/wav" } } });
    await expect(transcribe(new Blob([]), fakeFetch(() => json(200, { ok: false, code: "DICTATION_BUDGET", message: "Today's dictation is used up." })).f)).rejects.toThrow("Today's dictation is used up.");
    expect([appendDictation("", "hi"), appendDictation("Show payroll  ", "by month"), appendDictation("x", "")]).toEqual(["hi", "Show payroll by month", "x"]);
  });

  it("Platform: every share key the readout carries has a label (the Lobby's shares and the extras' counters)", async () => {
    const readout = await buildPlatformReadout({
      lobby: async () => ({ day: "2026-10-26", level: 0, restoresLeft: 3, leases: { active: 0, pool: 2, waitlist: 0 }, lastSweepAt: null, shares: Object.fromEntries(Object.entries(SHARES).map(([k, share]) => [k, { used: 0, share }])) }),
      spend: { status: async () => ({ spentMicros: { day: 0 }, caps: { dayUsd: 2, runUsd: 0.1, neuronsDay: 5_000 }, neurons: { used: 0 } }) as never },
      counters: { peek: async () => 0, take: async () => ({ ok: true, used: 0, left: 0 }), add: async () => 0 },
      now: () => new Date("2026-10-26T12:00:00.000Z"),
    });
    const keys = Object.keys(readout.shares).sort();
    expect(keys).toEqual(["doRequests", "doRowsRead", "doRowsWritten", "help.queries", "pdf.browser_seconds", "workersRequests"]);
    expect(keys.filter((k) => !SHARE_LABEL[k])).toEqual([]);
    expect(Object.keys(SHARE_LABEL).sort()).toEqual(keys);
  });

  it("model switch: PUTs the provider for this world", async () => {
    const f = fakeFetch(() => json(200, { ok: true }));
    await switchModel("workers_ai", f.f);
    expect(f.calls[0]).toMatchObject({ url: "/api/_hosted/model", init: { method: "PUT", body: JSON.stringify({ provider: "workers_ai" }) } });
    await switchModel(null, f.f);
    expect(f.calls[1]!.init?.body).toBe(JSON.stringify({ provider: null }));
    await expect(switchModel("openai", fakeFetch(() => json(409, { message: "lease required" })).f)).rejects.toThrow("lease required");
  });

  it("the run trace fallback: 1 s on Node, 5 s hosted", () => {
    expect([traceDelayMs(false, false), traceDelayMs(true, false)]).toEqual([1_000, 3_000]);
    expect([traceDelayMs(false, true), traceDelayMs(true, true)]).toEqual([5_000, 6_000]);
  });
});

describe("the hosted landing", () => {
  const dirs: string[] = [];
  const g = globalThis as Record<string, unknown>;
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); resetHostedLanding(); delete g.fetch; });

  it("labels each stats source", () => {
    expect(toLandingStats({ employees: 48, simulatedAgencies: 7, runsLogged: 3 } as never, "snapshot")).toEqual({ source: "snapshot", employees: 48, simulatedAgencies: 7, runsLogged: 3, realAgenciesContacted: 0 });
    expect(statsNote("snapshot")).toBe("Counted from the company's seeded database.");
    expect(statsNote("live")).toBe("Counted from the database as it runs.");
    expect(statsNote("fallback")).toBe("The API is not reachable, so these are the seed's numbers.");
  });

  it("reads stats.json at build time, falling back to the seed's numbers", () => {
    const d = mkdtempSync(join(tmpdir(), "weft-stats-"));
    dirs.push(d);
    writeFileSync(join(d, "stats.json"), JSON.stringify({ employees: 50, contractors: 3, simulatedAgencies: 7, runsLogged: 9, actionsLogged: 1, realAgenciesContacted: 0, payrollsProcessed: 2 }));
    expect(readSnapshotStats(join(d, "stats.json"))).toMatchObject({ source: "snapshot", employees: 50, runsLogged: 9 });
    expect(readSnapshotStats(join(d, "missing.json"))).toEqual(FALLBACK_STATS);
  });

  it("an unleased visit makes no API request; a leased one refreshes stats and the clock", async () => {
    const calls: string[] = [];
    g.fetch = async (u: string) => {
      calls.push(u);
      if (u === "/stats.json") return json(200, { employees: 48, simulatedAgencies: 7, runsLogged: 0 });
      if (u === "/api/v1/stats") return json(200, { employees: 49, simulatedAgencies: 7, runsLogged: 4 });
      if (u === "/api/v1/health") return json(200, { clock: { now: "2026-10-27T15:30:00.000Z", rate: 0 } });
      return json(404, {});
    };
    const snapshot = { ...FALLBACK_STATS, source: "snapshot" as const };
    expect(await loadHostedLanding(snapshot, false)).toEqual({ stats: null, clock: null });
    expect(calls).toEqual([]);
    resetHostedLanding();
    expect((await loadHostedLanding(FALLBACK_STATS, false)).stats?.source).toBe("snapshot");
    expect(calls).toEqual(["/stats.json"]);
    resetHostedLanding(); calls.length = 0;
    const leased = await loadHostedLanding(snapshot, true);
    expect(leased.stats).toMatchObject({ source: "live", employees: 49, runsLogged: 4 });
    expect(leased.clock).toEqual({ now: "2026-10-27T15:30:00.000Z", rate: 0 });
    expect(calls.sort()).toEqual(["/api/v1/health", "/api/v1/stats"]);
  });
});
