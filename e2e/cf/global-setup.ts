// Global setup for playwright.cf.config.ts (track cf7-integrate). For each selected project it checks the target is
// ready before any spec runs: the front Worker answers, every world the Lobby holds is restored (`ready`), and the
// operator lease the specs share can be taken (with the scripted provider pinned on its world unless WEFT_CF_LIVE=1).
// It prints the Lobby's day readout (degradation level and rows written against Weft's share) before and, from the
// returned teardown, after the run, so a run's cost in Durable Object rows is on record (design 8.2 and the
// provisioning-day budget: on a fresh local stack the visitors' share is what the four restores leave of 90,000).
// Nothing secret is printed: the admin signature is made in auth.ts and never shown.
import type { FullConfig } from "@playwright/test";
import { signers, targetKind, tokensFile } from "./auth";
import { LIVE, OPERATOR } from "./fixtures";
import { adminFetch, OperatorWorld, sleep } from "./world";

interface Ops {
  lobby: {
    readout: { day: string; level: number; levelReasons: string[]; leases: { active: number; pool: number; waitlist: number }; shares: Record<string, { used: number; share: number }> };
    slots: { name: string; state: string; gen: number; error: string | null }[];
    usage: { visitorRowsWritten: number; restoreRows: number; restores: number; doRowsRead: number };
  };
}

async function ops(origin: string, sign: ReturnType<typeof signers>): Promise<Ops> {
  const res = await adminFetch(origin, sign, "GET", "/api/_admin/ops");
  if (res.status !== 200) throw new Error(`GET /api/_admin/ops on ${origin} answered ${res.status}: the admin token in ${sign.file} does not match this deployment, or it is not up`);
  return (await res.json()) as Ops;
}

const line = (o: Ops) => {
  const r = o.lobby.readout;
  const w = r.shares.doRowsWritten;
  return `level ${r.level}${r.levelReasons.length ? ` (${r.levelReasons.join("; ")})` : ""}, visitor rows written ${o.lobby.usage.visitorRowsWritten} (share used ${w?.used ?? "?"} of ${w?.share ?? "?"}), restores ${o.lobby.usage.restores}, leases ${r.leases.active} of ${r.leases.pool}`;
};

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const selected = new Set((process.env.WEFT_CF_SELECTED ?? "local").split(",").filter(Boolean));
  const targets = config.projects.filter((p) => selected.has(p.name)).map((p) => ({ name: p.name, origin: String(p.use.baseURL).replace(/\/$/, "") }));
  for (const t of targets) {
    const sign = signers(tokensFile(targetKind(t.origin)));
    const t0 = Date.now();
    for (;;) {
      try { if ((await fetch(`${t.origin}/api/_session`, { signal: AbortSignal.timeout(10_000) })).status === 200) break; } catch { /* not up yet */ }
      if (Date.now() - t0 > 120_000) throw new Error(`${t.origin}/api/_session did not answer 200 within 120 s`);
      await sleep(1000);
    }
    let o = await ops(t.origin, sign);
    while (!o.lobby.slots.every((s) => s.state === "ready")) {
      const bad = o.lobby.slots.filter((s) => s.state === "failed" || /deferred/.test(s.error ?? ""));
      if (bad.length) throw new Error(`${t.name}: worlds not restorable today: ${JSON.stringify(bad)}`);
      if (Date.now() - t0 > 300_000) throw new Error(`${t.name}: worlds not ready within 5 minutes: ${JSON.stringify(o.lobby.slots)}`);
      await sleep(2000);
      o = await ops(t.origin, sign);
    }
    const w = new OperatorWorld(t.origin, sign, OPERATOR);
    const lease = await w.start();
    if (lease.status !== "leased") throw new Error(`${t.name}: the operator lease "${OPERATOR}" was not granted: ${JSON.stringify(lease)}`);
    await w.put("/api/_hosted/model", { provider: LIVE ? null : "scripted" });
    console.log(`cf e2e ${t.name} ${t.origin}: ${o.lobby.slots.length} worlds ready; operator lease ${OPERATOR} on ${lease.slot} gen ${lease.gen}, ${lease.resetsLeft} resets left; provider ${LIVE ? "the demo default (WEFT_CF_LIVE=1)" : "scripted"}; ${line(o)}`);
    // A whole run resets the operator's world twice (the scenarios and the tour); the smoke's tour alone needs one.
    const needed = Number(process.env.WEFT_CF_RESETS_NEEDED ?? 2);
    if ((lease.resetsLeft ?? 0) < needed) throw new Error(`${t.name}: the operator lease "${OPERATOR}" has ${lease.resetsLeft} resets left and this run needs ${needed}; set WEFT_CF_OPERATOR to another name or wait for the lease to end`);
  }
  return async () => {
    for (const t of targets) {
      try { console.log(`cf e2e ${t.name} after the run: ${line(await ops(t.origin, signers(tokensFile(targetKind(t.origin)))))}`); } catch (e) { console.log(`cf e2e ${t.name}: no readout after the run (${(e as Error).message})`); }
    }
  };
}
