// Design 6.4: no node:fs, node:child_process or node:net is reachable from the weft-core entry, static or dynamic
// imports alike, in the bundle wrangler's dry run builds. It needs no snapshot: where pnpm cf:snapshot has not run,
// the snapshot files the bundle imports get empty stand-ins for the dry run (scripts/cf/lib/core-scan.ts).
import { describe, expect, it } from "vitest";
import { scanCoreBundle } from "../../../../scripts/cf/lib/core-scan";
import { CF_DIR } from "../support/config-files";

describe("weft-core import scan", () => {
  it("reaches no node:fs, node:child_process or node:net from the weft-core entry", () => {
    const r = scanCoreBundle({ appsCf: CF_DIR });
    expect(r.entry).toMatch(/src\/core\/index\.ts$/);
    expect(r.inputs).toBeGreaterThan(500);
    expect(r.reachable).toEqual([]);
  }, 180_000);
});
