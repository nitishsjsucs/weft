// The small shared parts: byte helpers that run the same in workerd and Node, the KV kill flags, the Lobby daily
// counters (in memory and over DO SQLite), the neuron budget adapter over SpendDO and the gateway option.
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HOSTED_CONFIG_KEYS } from "../../contracts/src/ext/cf-hosted";
import type { HostedReserveInput } from "../../contracts/src/ext/cf-agent";
import type { SqlCursorLike, SqlRow, SqlStorageLike } from "../../contracts/src/ext/cf-db";
import { amountToCents, cleanText, contentTypeOfName, escapeHtml, isoDateOrNull, sha256Hex, sniff, toBase64, utcDay } from "../src/bytes";
import { COUNTER_TABLE, lobbyCounters, memoryDailyCounters, sqlDailyCounters } from "../src/counters";
import { createFlagReader, EXTRAS_FLAGS_ALL_OFF, flagsFrom } from "../src/flags";
import { gatewayOption } from "../src/gateway";
import { neuronBudgetFromLedger } from "../src/neurons";
import * as extras from "../src/index";
import { memoryKv } from "./fakes";

describe("bytes", () => {
  it("hashes and encodes like Node, sniffs by magic number, and parses money without floats", async () => {
    const data = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    expect(await sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(toBase64(data)).toBe(Buffer.from(data).toString("base64"));
    const enc = (s: string) => new TextEncoder().encode(s);
    expect([sniff(enc("%PDF-1.7")), sniff(enc("GIF89a")), sniff(enc("RIFF1234WEBPVP8 ")), sniff(enc("OggS")), sniff(enc("hello\nthere")), sniff(new Uint8Array([0, 0, 1]))])
      .toEqual(["pdf", "gif", "webp", "ogg", "text", "unknown"]);
    expect([amountToCents("10.62"), amountToCents("$1,234.5"), amountToCents("USD 3"), amountToCents(12.345), amountToCents("-1"), amountToCents("1.234"), amountToCents(null)])
      .toEqual([1062, 123450, 300, 1235, null, null, null]);
    expect([isoDateOrNull("2026-10-26"), isoDateOrNull("2026-02-30"), isoDateOrNull("10/26/2026"), isoDateOrNull(5)]).toEqual(["2026-10-26", null, null, null]);
    expect([contentTypeOfName("IMG_2041.JPG"), contentTypeOfName("receipt.pdf"), contentTypeOfName("notice"), contentTypeOfName("a.txt")]).toEqual(["image/jpeg", "application/pdf", "application/octet-stream", "text/plain"]);
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(cleanText("a\u0000b   c\n\n\n\nd", 100)).toBe("ab c\n\nd");
    expect(cleanText("ab😀", 3)).toBe("ab");
    expect(utcDay(new Date("2026-10-26T23:59:59Z"))).toBe("2026-10-26");
  });
});

describe("flags", () => {
  it("each extra is on unless its kill flag says off; semantic recall is off until KV (or, without KV, the var) turns it on", () => {
    expect(flagsFrom({})).toEqual({ ocr: true, pdf: true, help: true, dictation: true, recallSemantic: false });
    expect(flagsFrom({ extrasOcr: "off", extrasPdf: "FALSE", extrasHelp: "on", extrasDictation: "0" })).toMatchObject({ ocr: false, pdf: false, help: true, dictation: false });
    expect(flagsFrom({}, { WEFT_SEMANTIC_RECALL: "0" }).recallSemantic).toBe(false);
    expect(flagsFrom({ recallSemantic: "on" }, { WEFT_SEMANTIC_RECALL: "0" }).recallSemantic).toBe(true);
    expect(flagsFrom({ recallSemantic: "off" }, { WEFT_SEMANTIC_RECALL: "1" }).recallSemantic).toBe(false);
    expect(flagsFrom({ recallSemantic: "maybe" }).recallSemantic).toBe(false);
    expect(flagsFrom({}, { WEFT_SEMANTIC_RECALL: "1" }).recallSemantic).toBe(true);
  });

  it("reads KV once per memo window, keeps the last flags on a KV error, and is all off with no KV", async () => {
    let t = 0;
    const kv = memoryKv({ [HOSTED_CONFIG_KEYS.extrasHelp]: "off" });
    const read = createFlagReader(kv, {}, { memoMs: 60_000, now: () => t });
    expect((await read()).help).toBe(false);
    const reads = kv.reads;
    t = 59_000;
    kv.values[HOSTED_CONFIG_KEYS.extrasHelp] = "on";
    expect((await read()).help).toBe(false);
    expect(kv.reads).toBe(reads);
    t = 61_000;
    expect((await read()).help).toBe(true);
    const broken = { async get(): Promise<string | null> { throw new Error("KV down"); } };
    expect(await createFlagReader(broken)()).toEqual(EXTRAS_FLAGS_ALL_OFF);
    expect(await createFlagReader(null)()).toEqual(EXTRAS_FLAGS_ALL_OFF);
  });
});

/** workerd's SqlStorage shape over node:sqlite, enough for the counters. */
function sqlStorage(): SqlStorageLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    databaseSize: 0,
    exec<T extends SqlRow>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
      const st = db.prepare(query);
      const rows = (/^\s*select/i.test(query) ? st.all(...(bindings as SQLInputValue[])) : (st.run(...(bindings as SQLInputValue[])), [])) as T[];
      const it = rows[Symbol.iterator]();
      return { next: () => it.next(), [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows, one: () => rows[0]!, raw: () => [][Symbol.iterator](), columnNames: [], rowsRead: rows.length, rowsWritten: 0 } as unknown as SqlCursorLike<T>;
    },
  };
}

describe("daily counters", () => {
  for (const [name, make] of [["memory", (now: () => Date) => memoryDailyCounters(now)], ["DO SQLite", (now: () => Date) => sqlDailyCounters(sqlStorage(), { now })]] as const) {
    it(`${name}: a take never passes the cap, and each UTC day starts at zero`, async () => {
      let now = new Date("2026-10-26T10:00:00Z");
      const c = make(() => now);
      expect(await c.take("help.queries", 1, 2)).toEqual({ ok: true, used: 1, left: 1 });
      expect(await c.take("help.queries", 1, 2)).toEqual({ ok: true, used: 2, left: 0 });
      expect(await c.take("help.queries", 1, 2)).toEqual({ ok: false, used: 2, left: 0 });
      expect(await c.add("pdf.browser_ms", 3300)).toBe(3300);
      expect(await c.peek("help.queries")).toBe(2);
      now = new Date("2026-10-27T00:00:00Z");
      expect(await c.peek("help.queries")).toBe(0);
      expect(await c.peek("help.queries", "2026-10-26")).toBe(2);
    });
  }

  it("DO SQLite prunes rows older than a week on the first write of a day", async () => {
    const s = sqlStorage();
    let now = new Date("2026-10-01T10:00:00Z");
    const c = sqlDailyCounters(s, { now: () => now });
    await c.add("help.queries", 1);
    now = new Date("2026-10-26T10:00:00Z");
    await c.add("help.queries", 1);
    expect((s.db.prepare(`SELECT day FROM ${COUNTER_TABLE}`).all() as { day: string }[]).map((r) => r.day)).toEqual(["2026-10-26"]);
  });

  it("lobbyCounters calls the LobbyDO RPC methods", async () => {
    const calls: unknown[][] = [];
    const c = lobbyCounters({
      async extrasCounterTake(...a) { calls.push(["take", ...a]); return { ok: true, used: 1, left: 29 }; },
      async extrasCounterAdd(...a) { calls.push(["add", ...a]); return 5; },
      async extrasCounterPeek(...a) { calls.push(["peek", ...a]); return 1; },
    });
    await c.take("help.queries", 1, 30);
    await c.add("pdf.browser_ms", 5);
    await c.peek("help.queries", "2026-10-26");
    expect(calls).toEqual([["take", "help.queries", 1, 30, undefined], ["add", "pdf.browser_ms", 5, undefined], ["peek", "help.queries", "2026-10-26"]]);
  });
});

describe("neurons and the gateway", () => {
  it("reserves extras against SpendDO's neuron caps with no run and no dollars", async () => {
    const seen: HostedReserveInput[] = [];
    const settled: unknown[][] = [];
    let ok = true;
    const b = neuronBudgetFromLedger({
      async reserve(i) { seen.push(i as HostedReserveInput); return ok ? { ok: true, reservationId: "rsv_1" } : { ok: false, code: "BUDGET_EXCEEDED", cap: "day", hostedCap: "neurons", spentMicros: 300, capMicros: 300 }; },
      async settle(...a) { settled.push(a); },
    });
    expect(await b.reserve({ product: "dictation", neurons: 24, model: "@cf/openai/whisper-large-v3-turbo", visitor: "v_1" })).toEqual({ ok: true, reservationId: "rsv_1" });
    expect(seen[0]).toEqual({ runId: null, usdMicros: 0, model: "@cf/openai/whisper-large-v3-turbo", live: false, world: null, visitor: "v_1", ipHash: null, neurons: 24, product: "dictation" });
    await b.settle("rsv_1", 3);
    expect(settled).toEqual([["rsv_1", 0, { neurons: 3 }]]);
    ok = false;
    expect(await b.reserve({ product: "ocr", neurons: 25, model: "m" })).toEqual({ ok: false, code: "BUDGET_EXCEEDED", used: 300, cap: 300 });
  });

  it("passes the gateway only when its secret name is set, with at most five metadata keys", () => {
    const meta = { slot: "slot-1", gen: 2, run: null, kind: "ocr" as const, visitor: "v_1" };
    expect(gatewayOption({}, meta)).toBeNull();
    expect(gatewayOption({ WEFT_AIG_GATEWAY: "  " }, meta)).toBeNull();
    const g = gatewayOption({ WEFT_AIG_GATEWAY: "gw-name" }, meta)!;
    expect(g.id).toBe("gw-name");
    expect(Object.keys(g.metadata!).length).toBeLessThanOrEqual(5);
  });

  it("the package index exposes the contract and every extra", () => {
    for (const k of ["createReceiptOcr", "createNoticeOcr", "createDocumentRenderer", "createRecallSource", "createHelpSearch", "createDictation", "createRunCatalog", "selectMetricsSink", "buildPlatformReadout", "pdfObjectKey", "HIDDEN_SERVICE_COMMANDS"]) {
      expect(k in extras).toBe(true);
    }
  });
});
