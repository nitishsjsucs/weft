// Receipt images (w3-expenses.ts receiptPng) reach every world digest through the uploads rows (bytes and sha256), so
// their bytes must not depend on the zlib a Node build links: the nodejs.org builds bundle Chromium's zlib, which
// writes other valid streams for two of the patterns. Each image is a valid 16 x 20 grayscale PNG whose IDAT inflates
// to its pixel rows, and the 11 patterns are the bytes canonical zlib writes, which the pinned digests were made on.
import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { receiptPng } from "../src/w3-expenses";

/** sha256 over the 11 receipt patterns (seed % 11 from 0 to 10) end to end, as canonical zlib (level 9) writes them. */
const CANONICAL_PATTERNS_SHA256 = "1808ea49a5fc206ddf3e1f861a67433e2d85ba2fb409df408ad466a64e5a4569";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunksOf(png: Buffer): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = [];
  for (let at = PNG_SIGNATURE.length; at < png.length;) {
    const len = png.readUInt32BE(at);
    const typed = png.subarray(at + 4, at + 8 + len);
    expect(png.readUInt32BE(at + 8 + len)).toBe(crc32(typed) >>> 0);
    out.push({ type: typed.subarray(0, 4).toString("ascii"), data: typed.subarray(4) });
    at += 12 + len;
  }
  return out;
}

describe("receipt images", () => {
  it("are 16 x 20 grayscale PNGs whose IDAT inflates to unfiltered rows of paper and ink", () => {
    for (const seed of [...Array.from({ length: 14 }, (_, i) => i + 1), ...Array.from({ length: 11 }, (_, i) => 1000 + i)]) {
      const png = receiptPng(seed);
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const chunks = chunksOf(png);
      expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
      expect([...chunks[0]!.data]).toEqual([0, 0, 0, 16, 0, 0, 0, 20, 8, 0, 0, 0, 0]);
      const raw = inflateSync(chunks[1]!.data);
      expect(raw.length).toBe(17 * 20);
      for (let y = 0; y < 20; y++) {
        const row = raw.subarray(y * 17, (y + 1) * 17);
        expect(row[0]).toBe(0);
        expect([...row.subarray(1)].every((p) => p === 0xff || p === 0x30)).toBe(true);
        expect(row.includes(0x30, 1)).toBe(y % 3 === 1);
      }
    }
  });

  it("are the bytes canonical zlib writes, whatever zlib this Node links", () => {
    const patterns = Buffer.concat(Array.from({ length: 11 }, (_, seed) => receiptPng(seed)));
    expect(createHash("sha256").update(patterns).digest("hex")).toBe(CANONICAL_PATTERNS_SHA256);
    // Seeds with the same pattern share their bytes: the pixels depend on seed % 11 only.
    expect(receiptPng(13).equals(receiptPng(2))).toBe(true);
  });
});
