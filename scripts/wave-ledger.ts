// The shared wave 4 spend ledger (docs/wave4.md section 5): ~/Developer/projects/weft-notes/wave4-spend.json, a JSON
// array of { at, stage, usd, cap, note } entries outside the repo. Every stage that spends live money checks it before
// a spend and appends after, under a lock directory, on top of the repo's own spend ledger and live guard.
// Usage: tsx scripts/wave-ledger.ts show
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WAVE4_USD_CAP, WaveSpendEntry } from "../packages/contracts/src/evals";

export function waveLedgerPath(): string {
  return process.env.WEFT_WAVE_LEDGER ?? join(homedir(), "Developer/projects/weft-notes/wave4-spend.json");
}

export function readWaveSpend(path = waveLedgerPath()): WaveSpendEntry[] {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`wave ledger ${path} is not a JSON array`);
  return parsed.map((e) => WaveSpendEntry.parse(e));
}

/** The ledger's total cap: WAVE4_USD_CAP, or WEFT_WAVE_USD_CAP for a ledger kept for another spend (an experiment). */
export function waveCapUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WEFT_WAVE_USD_CAP;
  if (raw === undefined || raw.trim() === "") return WAVE4_USD_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(`WEFT_WAVE_USD_CAP=${raw.slice(0, 20)} is not $0 to $10`);
  return n;
}

export function waveSpentUsd(path = waveLedgerPath()): number {
  return readWaveSpend(path).reduce((s, e) => s + e.usd, 0);
}

/** Throws WAVE_CAP when spending `nextUsd` more would cross the wave cap or the stage's own cap. */
export function assertWaveBudget(input: { stage: string; stageCapUsd: number; nextUsd: number }, path = waveLedgerPath()): { spent: number; stageSpent: number } {
  const entries = readWaveSpend(path);
  const spent = entries.reduce((s, e) => s + e.usd, 0);
  const stageSpent = entries.filter((e) => e.stage === input.stage).reduce((s, e) => s + e.usd, 0);
  const cap = waveCapUsd();
  const who = process.env.WEFT_WAVE_USD_CAP?.trim() ? "this ledger" : "wave 4";
  if (spent + input.nextUsd > cap) throw new Error(`WAVE_CAP: ${who} has spent $${spent.toFixed(4)} of $${cap.toFixed(2)}; $${input.nextUsd.toFixed(4)} more would cross it`);
  if (stageSpent + input.nextUsd > input.stageCapUsd) throw new Error(`WAVE_CAP: stage ${input.stage} has spent $${stageSpent.toFixed(4)} of its $${input.stageCapUsd.toFixed(2)}`);
  return { spent, stageSpent };
}

function withLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A lock older than 60 s belongs to a process that died mid-append.
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`wave ledger lock ${lock} is held`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { rmdirSync(lock); }
}

/** Appends one entry atomically (write to a temp file, then rename) and returns the new wave total. */
export function appendWaveSpend(entry: Omit<WaveSpendEntry, "at"> & { at?: string }, path = waveLedgerPath()): number {
  const row = WaveSpendEntry.parse({ ...entry, at: entry.at ?? new Date().toISOString() });
  mkdirSync(dirname(path), { recursive: true });
  return withLock(path, () => {
    const all = [...readWaveSpend(path), row];
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
    return all.reduce((s, e) => s + e.usd, 0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const entries = readWaveSpend();
  const byStage = new Map<string, number>();
  for (const e of entries) byStage.set(e.stage, (byStage.get(e.stage) ?? 0) + e.usd);
  console.log(`wave 4 ledger ${waveLedgerPath()}: $${waveSpentUsd().toFixed(4)} of $${waveCapUsd().toFixed(2)} in ${entries.length} entries`);
  for (const [stage, usd] of byStage) console.log(`  ${stage}: $${usd.toFixed(4)}`);
}
