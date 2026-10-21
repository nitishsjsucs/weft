// The engaged session the delta reset is measured on (docs/cloudflare/design.md 4.6 and 8.2), recorded on Node: the
// rich world is seeded and booted once on the emulator (WEFT_DB=durable-emu), snapshotted, restored with the dirty-key
// triggers armed, and then the ten flows of the 8.2 table run through the API with the scripted provider while the
// emulator records every committed write. Each round ends with a delta reset on the emulator. The recorded writes are
// what the workerd test replays (conformance.workerd.test.ts), so the same session is measured with workerd's own
// row counts. The caller names the memory repository the session runs on; the shell's WEFT_MEMORY never decides it.
// Node only: it composes the whole app.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "../../contracts/src/api";
import { WEFT_MEMORY_SQLITE } from "../../contracts/src/ext/cf-memory";
import { createWeft } from "../../../apps/api/src/compose";
import { seedWorldProfile } from "../../seed/src/profile";
import { emulatorOf } from "../src/client";
import { DurableEmulator, type RecordedWrite } from "../src/emu";
import { migrationsDir } from "../src/migrate";
import { journalHash, readMigrationsFromDir, type MigrationEntry } from "../src/migrations";
import { buildSnapshot, deltaReset, restoreSnapshot, verifyAgainstManifest, type DeltaResetOutcome, type RestoreOutcome, type Snapshot } from "../src/snapshot";

type Weft = Awaited<ReturnType<typeof createWeft>>;

export const SEED_CLOCK = "2026-10-26T15:30:00.000Z";
/** The memory repository a recorded session runs on: git (Node's default) or the SQL repo hosted worlds always use. */
export type SessionMemory = "git" | "sqlite";
export const SESSION_MEMORIES: readonly SessionMemory[] = ["git", "sqlite"];

/**
 * The design's measured delta reset after a 10-flow session (verified locally by the risk design), and the 25% band.
 * The risk design measured it before the SQL memory repo existed (memory lived in git, outside the database), so it
 * bounds the session on git memory.
 */
export const DELTA_RESET_BASELINE_ROWS = 557;
export const DELTA_RESET_MAX_ROWS = Math.floor(DELTA_RESET_BASELINE_ROWS * 1.25);
/**
 * The same session on the SQL memory repo, as hosted worlds run it: the reset also deletes the git objects and log
 * rows of the session's memory commits and puts mem_refs back (85 more keys). Measured on 2026-10-21 with this file's
 * session, verified locally: 717 rows written in workerd (the billing count) and 716 on the emulator, against 630 and
 * 629 for the same session on git memory.
 */
export const DELTA_RESET_SQL_MEMORY_BASELINE_ROWS = 717;
export const DELTA_RESET_SQL_MEMORY_MAX_ROWS = Math.floor(DELTA_RESET_SQL_MEMORY_BASELINE_ROWS * 1.25);
/** The rows-written band of a delta reset after the session on `memory`. */
export const deltaResetMaxRows = (memory: SessionMemory): number => (memory === "sqlite" ? DELTA_RESET_SQL_MEMORY_MAX_ROWS : DELTA_RESET_MAX_ROWS);

export const FLOWS = [
  "deliver CA EDD DE 2088 and let the routine run propose",
  "approve the CA SUI rate",
  "approve the notice reply",
  "pre-payroll review run",
  "chat: show payroll cost by month",
  "expense review run",
  "chat: time-off balance",
  "accept Noor Castellanos's offer and the readiness run",
  "advance the clock to payday",
  "every GET route without a path parameter",
] as const;

async function settle(weft: Weft): Promise<void> {
  const agent = weft.agent as unknown as { idle(): Promise<void> };
  const routines = weft.routines as unknown as { drain(ms: number): Promise<boolean> };
  for (let i = 0; i < 4; i++) {
    await weft.scheduler.tick();
    await agent.idle();
    await routines.drain(10_000);
    await agent.idle();
  }
}

/** Runs the ten flows; returns what each one answered (for the test's sanity checks). */
export async function runFlows(weft: Weft): Promise<Record<string, number>> {
  const headers = { "x-weft-principal": "usr_dana", "x-weft-proxy": weft.proxySecret, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await weft.app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
  };
  const out: Record<string, number> = {};
  const pending = async () => ((await call("GET", "/v1/proposals?status=pending")).json.data as { id: string; command: string }[] | undefined) ?? [];
  const before = new Set((await pending()).map((p) => p.id));
  out[FLOWS[0]] = (await call("POST", "/v1/sim/notices/deliver", { scenario: "ca_de2088_rate_change" })).status;
  await settle(weft);
  const fresh = (await pending()).filter((p) => !before.has(p.id));
  const rate = fresh.find((p) => p.command === "tax.update_rate");
  const reply = fresh.find((p) => p.command === "notices.send_response");
  out[FLOWS[1]] = rate ? (await call("POST", `/v1/proposals/${rate.id}/approve`, { reasonCode: null, note: null })).status : 0;
  await settle(weft);
  out[FLOWS[2]] = reply ? (await call("POST", `/v1/proposals/${reply.id}/approve`, { reasonCode: null, note: null })).status : 0;
  await settle(weft);
  out[FLOWS[3]] = (await call("POST", "/v1/routines/rt_pre_payroll/trigger", {})).status;
  await settle(weft);
  out[FLOWS[4]] = (await call("POST", "/v1/agent/runs", { text: "Show payroll cost by month" })).status;
  await settle(weft);
  out[FLOWS[5]] = (await call("POST", "/v1/routines/rt_expense_review/trigger", {})).status;
  await settle(weft);
  out[FLOWS[6]] = (await call("POST", "/v1/agent/runs", { text: "How many hours of time off does Grace Adeyemi have left?" })).status;
  await settle(weft);
  out[FLOWS[7]] = (await call("POST", "/v1/offers/offr_0001/accept")).status;
  await settle(weft);
  out[FLOWS[8]] = (await call("POST", "/v1/sim/clock/advance", { to: "2026-10-30T16:00:00.000Z" })).status;
  await settle(weft);
  let ok = 0;
  for (const r of ROUTES) if (r.method === "GET" && !r.path.includes(":")) { const res = await call("GET", r.path); if (res.status < 500) ok++; }
  out[FLOWS[9]] = ok;
  await settle(weft);
  return out;
}

export interface RecordedSession {
  snapshot: Snapshot;
  migrations: MigrationEntry[];
  journalHash: string;
  /** Committed writes of each round, in commit order. */
  rounds: RecordedWrite[][];
  /** What the emulator measured: the full restore and each round's delta reset. */
  restore: RestoreOutcome;
  resets: DeltaResetOutcome[];
  answers: Record<string, number>[];
  /** Tables whose digests did not match the manifest after each reset (none expected). */
  mismatched: string[][];
}

/**
 * Seeds, snapshots, restores and runs `rounds` engaged sessions on the emulator, each followed by a delta reset, with
 * memory on `memory`. Sets WEFT_DB=durable-emu and WEFT_MEMORY for its own duration only.
 */
export async function recordRichSession(memory: SessionMemory, rounds = 2): Promise<RecordedSession> {
  const prev = { db: process.env.WEFT_DB, memory: process.env.WEFT_MEMORY };
  process.env.WEFT_DB = "durable-emu";
  if (memory === "sqlite") process.env.WEFT_MEMORY = WEFT_MEMORY_SQLITE; else delete process.env.WEFT_MEMORY;
  const dir = mkdtempSync(join(tmpdir(), "weft-flows-"));
  try {
    const migrations = readMigrationsFromDir(migrationsDir());
    const jh = journalHash(migrations);
    // Seed the rich world, then boot it once so its routine rows match the code (design 9.2).
    let weft = await createWeft({ dataDir: dir, testMode: true });
    await seedWorldProfile(weft, "rich");
    await weft.clock.set(SEED_CLOCK, 0);
    await weft.close();
    weft = await createWeft({ dataDir: dir, testMode: true });
    await weft.scheduler.tick();
    await weft.close();
    const file = join(dir, "weft.db");
    let emu = new DurableEmulator({ path: file });
    const snapshot = buildSnapshot(emu, { journalHash: jh });
    emu.close();
    rmSync(file, { force: true });
    emu = new DurableEmulator({ path: file });
    const restore = await restoreSnapshot(emu, snapshot, migrations, jh);
    emu.close();
    const recorded: RecordedWrite[][] = [];
    const resets: DeltaResetOutcome[] = [];
    const answers: Record<string, number>[] = [];
    const mismatched: string[][] = [];
    for (let i = 0; i < rounds; i++) {
      weft = await createWeft({ dataDir: dir, testMode: true });
      const rec = emulatorOf(weft.db)!.record();
      try { answers.push(await runFlows(weft)); } finally { await weft.close(); }
      recorded.push(rec.stop());
      emu = new DurableEmulator({ path: file });
      try {
        resets.push(deltaReset(emu, snapshot));
        mismatched.push(verifyAgainstManifest(emu, snapshot.manifest).mismatched);
      } finally { emu.close(); }
    }
    return { snapshot, migrations, journalHash: jh, rounds: recorded, restore, resets, answers, mismatched };
  } finally {
    if (prev.db === undefined) delete process.env.WEFT_DB; else process.env.WEFT_DB = prev.db;
    if (prev.memory === undefined) delete process.env.WEFT_MEMORY; else process.env.WEFT_MEMORY = prev.memory;
    rmSync(dir, { recursive: true, force: true });
  }
}
