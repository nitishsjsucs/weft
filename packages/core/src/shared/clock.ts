import { eq } from "drizzle-orm";
import type { SimClock } from "@weft/contracts";
import { settings, type DbTx } from "@weft/db";

/** SPEC 2: now() = base_sim + (wall - base_wall) * rate, persisted in settings as clock.base_sim, clock.base_wall, clock.rate. */
export const CLOCK_KEYS = { baseSim: "clock.base_sim", baseWall: "clock.base_wall", rate: "clock.rate" } as const;
/** Seed time, Monday 2026-10-26 08:30 PT (SPEC 5.5). */
export const SEED_TIME = "2026-10-26T15:30:00.000Z";

export interface ClockState { baseSim: number; baseWall: number; rate: number }
export interface CreateClockOptions {
  db: DbTx;
  /** Used only when settings hold no clock yet. */
  initial?: { at: string; rate: number };
  wall?: () => number;
}

export function computeNow(s: ClockState, wallMs: number): number {
  return s.baseSim + Math.round((wallMs - s.baseWall) * s.rate);
}

export async function createSimClock(opts: CreateClockOptions): Promise<SimClock & { state(): ClockState; reload(): Promise<void> }> {
  const wall = opts.wall ?? (() => Date.now());
  const db = opts.db;
  const read = async (): Promise<ClockState | null> => {
    const rows = await db.select().from(settings);
    const m = new Map(rows.map((r) => [r.key, JSON.parse(r.valueJson) as number]));
    const bs = m.get(CLOCK_KEYS.baseSim), bw = m.get(CLOCK_KEYS.baseWall), rt = m.get(CLOCK_KEYS.rate);
    return bs === undefined || bw === undefined || rt === undefined ? null : { baseSim: bs, baseWall: bw, rate: rt };
  };
  const write = async (s: ClockState) => {
    for (const [key, v] of [[CLOCK_KEYS.baseSim, s.baseSim], [CLOCK_KEYS.baseWall, s.baseWall], [CLOCK_KEYS.rate, s.rate]] as const) {
      await db.insert(settings).values({ key, valueJson: JSON.stringify(v) }).onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(v) } });
    }
  };
  let state = await read();
  if (!state) {
    const init = opts.initial ?? { at: new Date(wall()).toISOString(), rate: Number(process.env.WEFT_CLOCK_RATE ?? 1) };
    state = { baseSim: Date.parse(init.at), baseWall: wall(), rate: init.rate };
    await write(state);
  }
  const parse = (to: string) => { const ms = Date.parse(to); if (Number.isNaN(ms)) throw new Error(`SimClock: bad ISO time ${to}`); return ms; };
  return {
    now: () => new Date(computeNow(state!, wall())).toISOString(),
    rate: () => state!.rate,
    state: () => ({ ...state! }),
    async advance(to: string) {
      const target = parse(to);
      const current = computeNow(state!, wall());
      if (target < current) throw new Error(`SimClock.advance: ${to} is before now ${new Date(current).toISOString()}`);
      state = { baseSim: target, baseWall: wall(), rate: state!.rate };
      await write(state);
    },
    async set(to: string, rate?: number) {
      state = { baseSim: parse(to), baseWall: wall(), rate: rate ?? state!.rate };
      await write(state);
    },
    async reload() { state = (await read()) ?? state; },
  };
}

/** Removes the persisted clock (used by reset). */
export async function clearClock(db: DbTx): Promise<void> {
  for (const key of Object.values(CLOCK_KEYS)) await db.delete(settings).where(eq(settings.key, key));
}
