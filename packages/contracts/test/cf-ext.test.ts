// Weft on Cloudflare round 0 contracts (packages/contracts/src/ext/cf-*.ts, track cf0-contracts): the settings Nitish
// chose on 2026-10-20 and 2026-10-23, the pure helpers, and the rule that these files load no runtime code a Worker
// would pay for.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_STATUS, type SpendLedger } from "../src/index";
import { HOSTED_TABLES, DO_SQL_LIMITS, RESERVED_TABLE_PREFIX } from "../src/ext/cf-db";
import { aiGatewayOpenAiBaseUrl, FROZEN_CAP, HOSTED_CAP_DEFAULTS, MAX_FETCHES_PER_ALARM, NEURON_SHARES, type HostedCap, type HostedSpendLedger } from "../src/ext/cf-agent";
import { DO_NAMES, formatHostedMcpKey, HOSTED_CLOCK_LIMITS, HOSTED_ERRORS, HOSTED_RATE_LIMITS, HOSTED_SETTINGS, hostedEtag, hostedWorldId, parseHostedMcpKey, slotName } from "../src/ext/cf-hosted";
import { pdfObjectKey, queueFor, QUEUES, seedNamespace } from "../src/ext/cf-extras";
import { EPHEMERAL_READ_ID_PREFIX } from "../src/ext/cf-platform";

const EXT = join(import.meta.dirname, "..", "src", "ext");
const cfFiles = readdirSync(EXT).filter((f) => /^cf-.*\.ts$/.test(f));

describe("cf round 0 contracts", () => {
  it("are six files whose imports are all type-only, so a Worker that loads them evaluates no schema code", () => {
    expect(cfFiles.sort()).toEqual(["cf-agent.ts", "cf-db.ts", "cf-extras.ts", "cf-hosted.ts", "cf-memory.ts", "cf-platform.ts"]);
    for (const f of cfFiles) {
      const imports = readFileSync(join(EXT, f), "utf8").split("\n").filter((l) => /^import\s/.test(l));
      for (const line of imports) expect(line, `${f}: ${line}`).toMatch(/^import type \{[^}]+\} from "\.\.?\/[a-z0-9-/]+";$/);
    }
  });

  it("carry the hosted settings from design section 0", () => {
    expect(HOSTED_CAP_DEFAULTS).toEqual({ runUsd: 0.1, dayUsd: 2, liveUsd: null, visitorDayUsd: 2, ipDayUsd: 2, neuronsDay: 5000 });
    expect(HOSTED_CAP_DEFAULTS.visitorDayUsd).toBe(HOSTED_CAP_DEFAULTS.dayUsd);
    expect(HOSTED_CAP_DEFAULTS.ipDayUsd).toBe(HOSTED_CAP_DEFAULTS.dayUsd);
    expect(HOSTED_SETTINGS).toMatchObject({ poolSize: 2, leaseIdleMinutes: 1440, leaseTotalMinutes: 43_200, leasesPerIpHashPerDay: 500, resetsPerLease: 1_000, helpQueriesPerDay: 30 });
    // The guards on the shared account quotas did not move with the 2026-10-23 session settings.
    expect(HOSTED_SETTINGS).toMatchObject({ humanGrantMinutes: 10, uploadMaxBytes: 1_500_000, uploadsPerVisitorPerDay: 5 });
    expect(HOSTED_RATE_LIMITS).toEqual({ RL_API: { limit: 600, period: 60 }, RL_MUTATE: { limit: 30, period: 60 }, RL_MCP: { limit: 60, period: 60 }, RL_RUN: { limit: 6, period: 60 } });
    expect(HOSTED_CLOCK_LIMITS).toEqual({ maxStepDays: 7, maxDaysFromStart: 60 });
    expect(Object.values(NEURON_SHARES).reduce((a, b) => a + b, 0)).toBe(HOSTED_CAP_DEFAULTS.neuronsDay);
    expect(MAX_FETCHES_PER_ALARM).toBeLessThan(50);
  });

  it("map every hosted cap onto a frozen SpendLedger cap", () => {
    const caps: HostedCap[] = ["run", "day", "live", "visitor", "ip", "neurons"];
    expect(Object.keys(FROZEN_CAP).sort()).toEqual([...caps].sort());
    for (const c of ["run", "day", "live"] as const) expect(FROZEN_CAP[c]).toBe(c);
    // A HostedSpendLedger is a SpendLedger: the agent runtime takes it unchanged.
    const asLedger = (l: HostedSpendLedger): SpendLedger => l;
    expect(typeof asLedger).toBe("function");
  });

  it("route MCP keys by prefix and generation, never anything else", () => {
    const key = formatHostedMcpKey(slotName(2), 7, "a".repeat(32));
    expect(key).toBe(`wk_mcp_slot-2_7_${"a".repeat(32)}`);
    expect(parseHostedMcpKey(key)).toEqual({ slot: "slot-2", gen: 7 });
    expect(parseHostedMcpKey(formatHostedMcpKey(DO_NAMES.smoke, 0, "Z9".repeat(10)))).toEqual({ slot: "slot-smoke", gen: 0 });
    for (const bad of ["weft_sk_" + "0".repeat(48), "wk_mcp_slot-2_7_short", "wk_mcp_Slot-2_7_" + "a".repeat(32), "wk_mcp_slot-2_x_" + "a".repeat(32), `${key}\n`]) {
      expect(parseHostedMcpKey(bad)).toBeNull();
    }
  });

  it("name worlds, objects and queues as the design does", () => {
    expect(hostedWorldId({ slot: "slot-1", gen: 4 })).toBe("slot-1:gen-4");
    expect(hostedEtag(4, "abc")).toBe('W/"4.abc"');
    expect(pdfObjectKey({ scope: "world", slot: "slot-1", gen: 4, sha256: "f00d" })).toBe("w/slot-1/g4/pdf/f00d.pdf");
    expect(pdfObjectKey({ scope: "seed", snapshot: "s1", sha256: "f00d" })).toBe("seed/s1/pdf/f00d.pdf");
    expect(seedNamespace("s1")).toBe("seed-s1");
    expect(queueFor("render.pdf")).toBe(QUEUES.render);
    expect(queueFor("ocr.receipt")).toBe(QUEUES.jobs);
    expect(aiGatewayOpenAiBaseUrl({ accountId: "acct", gateway: "gw" })).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai");
    expect(EPHEMERAL_READ_ID_PREFIX).toBe("res_e_");
    expect(HOSTED_TABLES).toEqual(["mem_objects", "mem_refs", "mem_log", "blobs", "run_files", "run_handles", "kv_state", "outbox"]);
    expect(RESERVED_TABLE_PREFIX).toBe("_cf_");
    expect(DO_SQL_LIMITS.maxBoundParameters).toBe(100);
  });

  it("give every hosted error a known tag", () => {
    for (const [code, e] of Object.entries(HOSTED_ERRORS)) expect(Object.keys(ERROR_STATUS), code).toContain(e.tag);
    expect(HOSTED_ERRORS.TURNSTILE_REQUIRED.status).toBe(428);
    expect(HOSTED_ERRORS.LEASE_REQUIRED.status).toBe(409);
    expect(HOSTED_ERRORS.AGENT_PAUSED.status).toBe(503);
  });
});
