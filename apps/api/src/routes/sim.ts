// /v1 sim routes (demo controls, dev only). Owner: t2-world. Every mutation kicks the scheduler before responding.
// Reset rebuilds the database in place (drop every table, migrate, seed), deletes memory repos and run workspaces
// under .data/companies, and never touches .data/spend.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { ChatChannel, FaultKind, FaultMode, NoticeScenario, NotImplemented, ValidationError, type ChatMessageDto, type HumanSession } from "@weft/contracts";
import { migrate, withWriteLock } from "@weft/db";
import { emitEvent, SEED_TIME } from "@weft/core";
import { serialGit } from "@weft/executor";
import { readSeedProfile, seedWorldProfile, type SeedProfile } from "@weft/seed/profile";
import type { Weft, WeftEnv } from "../http/context";

const AdvanceBody = z.union([
  z.object({ to: z.string() }).strict(),
  z.object({ by: z.string().regex(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/) }).strict(),
  z.object({ toNext: z.literal("cron") }).strict(),
]);
const FaultBody = z.union([
  z.object({ target: z.string().min(3).max(80), kind: FaultKind, mode: FaultMode }).strict(),
  z.object({ target: z.string().min(3).max(80), disarm: z.literal(true) }).strict(),
]);

/** ISO-8601 duration subset: P2D, PT30M, PT1H30M, P1DT2H. */
export function durationMs(by: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(by);
  if (!m || by === "P" || by === "PT") throw new ValidationError(`Bad duration ${by}`);
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
}

const weekdayHourPt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Next prebuilt cron slot (09:00 PT on a weekday) strictly after `now`. */
export function nextCronSlot(now: string): string {
  let t = Math.floor(Date.parse(now) / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 8; i++, t += 60_000) {
    const parts = Object.fromEntries(weekdayHourPt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    if (parts.weekday !== "Sat" && parts.weekday !== "Sun" && parts.hour === "09" && parts.minute === "00") return new Date(t).toISOString();
  }
  throw new Error("nextCronSlot: none within 8 days");
}

function session(c: { var: { session: HumanSession | null } }): HumanSession {
  const s = c.var.session;
  if (!s) throw new ValidationError("session required");
  return s;
}

/** Removes a directory tree, retrying while something still writes into it (ENOTEMPTY, EBUSY, EPERM). */
const removeTree = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });

/**
 * Lets background work started before the reset settle, so none of it writes into the world while it is rebuilt:
 * queued and running agent runs (past the bound they are aborted and given a moment to stop), then the routine
 * finalizations their terminal steps started.
 */
async function settleBackgroundWork(weft: Weft): Promise<void> {
  const bound = Number(process.env.WEFT_RESET_DRAIN_MS ?? 5_000);
  const agent = weft.agent as { drain?: (ms: number) => Promise<boolean> };
  const routines = weft.routines as { drain?: (ms: number, closing?: boolean) => Promise<boolean> };
  const quiet = async (fn: () => Promise<unknown> | undefined) => { try { await fn(); } catch { /* a stubbed part has nothing to drain */ } };
  await quiet(async () => { if (agent.drain && !(await agent.drain(bound))) await agent.drain(1_000); });
  await quiet(() => routines.drain?.(bound, false));
  await quiet(() => agent.drain?.(bound));   // a finalization can wake a waiting run
}

/** One reset at a time per world: a second POST /v1/sim/reset waits for the first instead of interleaving with it. */
const resetChains = new WeakMap<Weft, Promise<unknown>>();

/**
 * Rebuilds the world from the seed. Under heavy load the old reset failed with 500 (ENOTEMPTY from rmSync while a
 * `git` child process of an in-flight memory write was still adding objects to the repo) and left every table
 * dropped, so even the next reset failed its auth lookup. Now resets are serialized, no scheduler tick runs during
 * one, in-flight agent runs and routine finalizations settle first, the memory repos are removed on the git queue
 * (no git process is running then) before any table is dropped, and drop, migrate and seed hold the write lock
 * together, so no other request writes into a half-built world.
 */
export function resetWorld(weft: Weft, opts: { profile?: SeedProfile } = {}): Promise<{ ms: number; profile: SeedProfile }> {
  const prev = resetChains.get(weft) ?? Promise.resolve();
  const run = prev.then(() => rebuild(weft, opts.profile), () => rebuild(weft, opts.profile));
  resetChains.set(weft, run.catch(() => undefined));
  return run;
}

/** The world is rebuilt with the profile it was seeded with (a rich dev world stays rich) unless the caller names one. */
async function rebuild(weft: Weft, want?: SeedProfile): Promise<{ ms: number; profile: SeedProfile }> {
  const t0 = Date.now();
  const rate = weft.clock.rate();
  const profile = want ?? (await readSeedProfile(weft.db));
  const scheduler = weft.scheduler as { exclusive?: <T>(fn: () => Promise<T>) => Promise<T> };
  const exclusive = <T>(fn: () => Promise<T>) => (scheduler.exclusive ? scheduler.exclusive(fn) : fn());
  await exclusive(async () => {
    await settleBackgroundWork(weft);
    await serialGit(async () => {
      removeTree(join(weft.dataDir, "companies"));   // memory repos and run workspaces; never spend/
      removeTree(join(weft.dataDir, "run", "handles"));   // run ids restart after a reset
    });
    await withWriteLock(async () => {
      await weft.db.run(sql`PRAGMA foreign_keys=OFF`);
      try {
        const tables = await weft.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
        for (const { name } of tables) await weft.db.run(sql.raw(`DROP TABLE IF EXISTS "${name.replace(/"/g, "")}"`));
      } finally { await weft.db.run(sql`PRAGMA foreign_keys=ON`); }
      await migrate(weft.db);
      await seedWorldProfile(weft, profile);
    });
    await weft.clock.set(SEED_TIME, rate);
    // The engine lives across the reset; without this, a clock move before the next tick would start counting cron
    // slots from the old (later) cursor and skip the seed morning's 09:00 digest.
    (weft.routines as { resetCursor?: (at: string) => void }).resetCursor?.(SEED_TIME);
  });
  return { ms: Date.now() - t0, profile };
}

export function simRoutes(weft: Weft): Hono<WeftEnv> {
  const r = new Hono<WeftEnv>();

  r.get("/v1/sim/clock", (c) => c.json({ now: weft.clock.now(), rate: weft.clock.rate() }));

  r.post("/v1/sim/clock/advance", async (c) => {
    const body = AdvanceBody.parse(await c.req.json().catch(() => ({})));
    const from = weft.clock.now();
    const to = "to" in body ? new Date(Date.parse(body.to)).toISOString() : "by" in body ? new Date(Date.parse(from) + durationMs(body.by)).toISOString() : nextCronSlot(from);
    if (Number.isNaN(Date.parse(to)) || to < from) throw new ValidationError(`Cannot move the clock from ${from} to ${to}`);
    await weft.clock.advance(to);
    await withWriteLock(() => weft.db.transaction(async (tx) => {
      await emitEvent(tx, weft.clock, { body: { type: "clock.advanced", payload: { from, to } }, subjectRef: "clock", attended: true, requestedBy: c.var.session?.principalId ?? null });
    }));
    await weft.scheduler.kick();
    return c.json({ now: weft.clock.now(), rate: weft.clock.rate() });
  });

  r.post("/v1/sim/notices/deliver", async (c) => {
    const { scenario } = z.object({ scenario: NoticeScenario }).strict().parse(await c.req.json().catch(() => ({})));
    const out = await weft.executor.human.exec(session(c), "sim.deliver_notice", { scenario });
    await weft.scheduler.kick();
    return c.json(out);
  });

  r.get("/v1/sim/state", async (c) => {
    const rows = async (table: string, order = "id") => weft.db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${table}" ORDER BY "${order}" DESC LIMIT 50`));
    const state = {
      clock: { now: weft.clock.now(), rate: weft.clock.rate() },
      registrations: await rows("sim_registrations"),
      agencyMail: await rows("sim_agency_mail"),
      bankBatches: (await rows("sim_bank_batches")).map(({ entries_json: e, ...b }) => ({ ...b, entryCount: (JSON.parse(String(e)) as unknown[]).length })),
      idpAccounts: Number((await weft.db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM sim_idp_accounts`))[0]?.n ?? 0),
      deviceOrders: await rows("sim_device_orders"),
      faults: await weft.sims.faults.list(),
      catalog: weft.sims.devices.catalog(),
    };
    let text = JSON.stringify(state);
    try { text = weft.executor.redact(text); } catch { /* executor stub: nothing to redact yet */ }
    return c.body(text, 200, { "content-type": "application/json" });
  });

  r.post("/v1/sim/faults", async (c) => {
    const body = FaultBody.parse(await c.req.json().catch(() => ({})));
    if ("disarm" in body) await weft.sims.faults.disarm(body.target as never);
    else await weft.sims.faults.arm({ target: body.target as never, kind: body.kind, mode: body.mode });
    await weft.scheduler.kick();
    return c.json(await weft.sims.faults.list());
  });

  r.get("/v1/sim/chat", async (c) => {
    const channel = ChatChannel.optional().parse(c.req.query("channel") || undefined);
    const afterId = c.req.query("afterId") || undefined;
    const channels = channel ? [channel] : ChatChannel.options;
    const msgs: ChatMessageDto[] = [];
    for (const ch of channels) for (const m of await weft.sims.chat.list(ch, afterId)) msgs.push({ id: m.id, channel: m.channel, author: m.author, text: m.text, card: m.card as Record<string, unknown> | null, ts: m.ts, inbound: m.inbound });
    msgs.sort((a, b) => (a.id < b.id ? -1 : 1));
    return c.json(msgs);
  });

  r.post("/v1/sim/reset", async (c) => {
    if (!weft.testMode && process.env.WEFT_ALLOW_RESET === "0") throw new NotImplemented("reset disabled by WEFT_ALLOW_RESET=0");
    // No scheduler kick here: a reset world must digest exactly like a fresh `pnpm db:seed` (no tick has run).
    // Optional { profile: "base" | "rich" }; without it the world keeps the profile it was seeded with.
    const body = (await c.req.json().catch(() => ({}))) as { profile?: unknown };
    const profile = body && typeof body === "object" && (body.profile === "base" || body.profile === "rich") ? body.profile : undefined;
    const { ms, profile: seeded } = await resetWorld(weft, { profile });
    return c.json({ ok: true, ms, profile: seeded });
  });

  return r;
}
