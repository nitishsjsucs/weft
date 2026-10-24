// The Lobby's rules (design 6.2, 6.5, 8.2, 9.2) with the section 0 settings: 24 hour idle and 30 day leases, the
// shares, the provisioning-day ceiling that seeds the whole pool on day 1, and the degradation ladder.
import { describe, expect, it } from "vitest";
import { HOSTED_DELTA_RESET_BASELINE_ROWS, HOSTED_SETTINGS } from "../../src/shared/contracts";
import { DELTA_RESET_SQL_MEMORY_BASELINE_ROWS } from "../../../../packages/db/test-workerd/flows";
import {
  defaultBudget, degradationLevel, emptyUsage, etaMinutes, FULL_RESTORE_ROWS, leaseEnded, leaseExpiresAt, leaseIdleExpiresAt,
  PROVISION_ROWS_CEILING, restoreFits, restoresLeft, rowsCeiling, SESSION_ACTIVITY_ROWS, SESSION_OVERHEAD_ROWS, SESSION_ROWS_ESTIMATE, sessionFits, SHARES, shareUse, visitorRowsBudget,
} from "../../src/core/lobby/policy";

const MIN = 60_000;

describe("the engaged session's rows", () => {
  it("are built on cf1's measured SQL-memory delta reset, the reset every hosted world runs", () => {
    // packages/db/test-workerd/flows.ts records the measurement; the contract constant must stay equal to it. Both are
    // imported, so an alias or a computed value compares as the number it is.
    expect(Number.isInteger(DELTA_RESET_SQL_MEMORY_BASELINE_ROWS)).toBe(true);
    expect(HOSTED_DELTA_RESET_BASELINE_ROWS).toBe(DELTA_RESET_SQL_MEMORY_BASELINE_ROWS);
    expect(SESSION_ROWS_ESTIMATE).toBe(SESSION_ACTIVITY_ROWS + HOSTED_DELTA_RESET_BASELINE_ROWS + SESSION_OVERHEAD_ROWS);
    expect(SESSION_ROWS_ESTIMATE).toBe(894 + 717 + SESSION_OVERHEAD_ROWS);
    // The Mac's measured reset (634 rows) sits inside the 25% band too.
    expect(634).toBeLessThanOrEqual(Math.floor(HOSTED_DELTA_RESET_BASELINE_ROWS * 1.25));
  });
});

describe("lease times (section 0)", () => {
  const IDLE = HOSTED_SETTINGS.leaseIdleMinutes * MIN;
  const TOTAL = HOSTED_SETTINGS.leaseTotalMinutes * MIN;

  it("uses 24 hours idle and 30 days in all (Nitish, 2026-10-23)", () => {
    expect(HOSTED_SETTINGS.leaseIdleMinutes).toBe(24 * 60);
    expect(HOSTED_SETTINGS.leaseTotalMinutes).toBe(30 * 24 * 60);
    const l = { startedAt: 0, lastSeen: 0 };
    // An idle lease still ends after the idle time.
    expect(leaseEnded(l, IDLE - MIN)).toBeNull();
    expect(leaseEnded(l, IDLE)).toBe("idle");
    // A lease kept active still ends at its total time.
    expect(leaseEnded({ startedAt: 0, lastSeen: TOTAL - 10 * MIN }, TOTAL - MIN)).toBeNull();
    expect(leaseEnded({ startedAt: 0, lastSeen: TOTAL - MIN }, TOTAL)).toBe("total");
    expect(leaseExpiresAt(l)).toBe(TOTAL);
    expect(leaseIdleExpiresAt(l)).toBe(IDLE);
    expect(leaseIdleExpiresAt({ startedAt: 0, lastSeen: TOTAL - 10 * MIN })).toBe(TOTAL);
  });

  it("estimates the waitlist from the soonest lease end", () => {
    expect(etaMinutes([], 0)).toBeNull();
    expect(etaMinutes([{ startedAt: 0, lastSeen: 10 * MIN }, { startedAt: 0, lastSeen: 20 * MIN }], 15 * MIN)).toBe((10 * MIN + IDLE - 15 * MIN) / MIN);
    expect(etaMinutes([{ startedAt: 0, lastSeen: 0 }], IDLE + MIN)).toBe(1);
  });

  it("allows 500 leases per IP hash a day and 1,000 resets per lease", () => {
    expect(HOSTED_SETTINGS.leasesPerIpHashPerDay).toBe(500);
    expect(HOSTED_SETTINGS.resetsPerLease).toBe(1_000);
    expect(HOSTED_SETTINGS.poolSize).toBe(2);
  });
});

describe("rows-written budget (design 8.2 and 9.2)", () => {
  const b = defaultBudget();

  it("seeds the whole section 0 pool on day 1: showcase, slot-smoke and two pool slots", () => {
    const u = emptyUsage();
    for (let i = 0; i < 4; i++) {
      expect(restoreFits(u, b)).toBe(true);
      u.restoreRows += FULL_RESTORE_ROWS;
      u.restores += 1;
    }
    expect(u.restoreRows).toBe(82_224);
    expect(restoreFits(u, b)).toBe(false);
    expect(rowsCeiling(u, b)).toBe(PROVISION_ROWS_CEILING);
    expect(visitorRowsBudget(u, b)).toBe(PROVISION_ROWS_CEILING - 82_224);
    expect(sessionFits(u, b)).toBe(true);
    // The account cap is 100,000 and the other apps peaked at 6,672 rows written a day.
    expect(PROVISION_ROWS_CEILING + 6_672).toBeLessThanOrEqual(100_000);
  });

  it("keeps visitors inside the normal share on a day with one restore", () => {
    const u = { ...emptyUsage(), restoreRows: FULL_RESTORE_ROWS, restores: 1 };
    expect(visitorRowsBudget(u, b)).toBe(SHARES.doRowsWritten);
    expect(restoresLeft(u, b)).toBe(3);
  });

  it("admits a session only when one more engaged session fits", () => {
    const u = { ...emptyUsage(), visitorRowsWritten: SHARES.doRowsWritten - SESSION_ROWS_ESTIMATE };
    expect(sessionFits(u, b)).toBe(true);
    u.visitorRowsWritten += 1;
    expect(sessionFits(u, b)).toBe(false);
  });

  it("reports each share against its use", () => {
    const s = shareUse({ ...emptyUsage(), visitorRowsWritten: 100, doRowsRead: 200, doRequests: 300, workersRequests: 400 }, b);
    expect(s).toEqual({
      doRowsWritten: { used: 100, share: 60_000 }, doRowsRead: { used: 200, share: 3_000_000 },
      doRequests: { used: 300, share: 60_000 }, workersRequests: { used: 400, share: 60_000 },
    });
  });
});

describe("degradation ladder (design 6.5)", () => {
  const b = defaultBudget();
  const base = { usage: emptyUsage(), budget: b, dollarsOrNeuronsSpent: false, agentPaused: false, floor: 0 as const };

  it("is 0 when quiet, 1 at 70% of any share, 2 on budget or pause, 3 at 90% of rows or DO requests", () => {
    expect(degradationLevel(base).level).toBe(0);
    expect(degradationLevel({ ...base, usage: { ...emptyUsage(), workersRequests: 42_000 } })).toEqual({ level: 1, reasons: ["workersRequests>=70%"] });
    expect(degradationLevel({ ...base, dollarsOrNeuronsSpent: true }).level).toBe(2);
    expect(degradationLevel({ ...base, agentPaused: true })).toEqual({ level: 2, reasons: ["paused"] });
    expect(degradationLevel({ ...base, usage: { ...emptyUsage(), visitorRowsWritten: 54_000 } }).level).toBe(3);
    expect(degradationLevel({ ...base, usage: { ...emptyUsage(), doRowsRead: 2_700_000 } }).level).toBe(3);
    expect(degradationLevel({ ...base, usage: { ...emptyUsage(), doRequests: 54_000 } }).level).toBe(3);
    // Workers requests at 90% are level 1 only: the platform itself answers 429 at the account cap (level 4).
    expect(degradationLevel({ ...base, usage: { ...emptyUsage(), workersRequests: 59_000 } }).level).toBe(1);
  });

  it("does not close the day for restores that were planned", () => {
    const usage = { ...emptyUsage(), restoreRows: 82_224, restores: 4, visitorRowsWritten: 1000 };
    expect(degradationLevel({ ...base, usage }).level).toBe(0);
    // Day 1 leaves 7,776 rows for visitors: 70% of that is level 1, 90% closes new leases.
    expect(degradationLevel({ ...base, usage: { ...usage, visitorRowsWritten: 5_500 } }).level).toBe(1);
    expect(degradationLevel({ ...base, usage: { ...usage, visitorRowsWritten: 7_000 } }).level).toBe(3);
  });

  it("never goes below the KV floor", () => {
    expect(degradationLevel({ ...base, floor: 4 })).toEqual({ level: 4, reasons: ["floor 4"] });
  });
});
