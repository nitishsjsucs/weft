// Shared fixtures for the extras tests in apps/cf (track cf6-extras): queue batches that record ack and retry, a fake
// slot behind the CompanyDO extras seam, and job dependencies over the fakes in packages/cf-extras/test/fakes.ts.
import {
  d1JobLedger, memoryDailyCounters, memoryNeuronBudget, type ExtrasFlags, type MetricPoint, type MetricsSink, type QueueMessageLike,
} from "@weft/cf-extras";
import { d1Shim, fakeAi, memoryR2, type D1Shim } from "../../../../packages/cf-extras/test/fakes";
import type { ExtrasJobDeps } from "../../src/extras/queues";
import type { HiddenWriteBack, SlotExtrasPort, SlotWorldInfo, WriteBackOutcome } from "../../src/extras/ports";

export * from "../../../../packages/cf-extras/test/fakes";

export interface RecordedMessage extends QueueMessageLike<unknown> { acked: number; retried: { delaySeconds?: number }[] }
export function message(body: unknown, attempts = 1, id = `msg_${Math.random().toString(16).slice(2, 10)}`): RecordedMessage {
  const m: RecordedMessage = {
    id, body, attempts, acked: 0, retried: [],
    ack() { m.acked++; },
    retry(o) { m.retried.push(o ?? {}); },
  };
  return m;
}
export const batch = (queue: string, messages: RecordedMessage[]) => ({ queue, messages });

export interface FakeSlot extends SlotExtrasPort {
  world: SlotWorldInfo;
  blobs: Map<string, Uint8Array>;
  memory: Map<string, string>;
  writeBacks: HiddenWriteBack[];
  reply: (w: HiddenWriteBack) => WriteBackOutcome;
}
export function fakeSlot(world: Partial<SlotWorldInfo> = {}): FakeSlot {
  const s: FakeSlot = {
    world: { slot: "slot-1", gen: 3, mode: "slot", snapshot: "snap1", lease: { visitor: "v_1", ipHash: "ip_1" }, ...world },
    blobs: new Map(), memory: new Map(), writeBacks: [],
    reply: () => ({ ok: true, status: "attached", reason: null }),
    async extrasWorld() { return s.world; },
    async extrasBlob(p) { return s.blobs.get(p) ?? null; },
    async extrasWriteBack(w) { s.writeBacks.push(w); return s.reply(w); },
    async extrasMemoryText(path, commit) { return s.memory.get(`${commit}:${path}`) ?? null; },
    async extrasExport(what) { return { bytes: new TextEncoder().encode(`${what} export of ${s.world.slot}`), contentType: what === "memory" ? "application/octet-stream" : "application/json" }; },
  };
  return s;
}

export const FLAGS_ON: ExtrasFlags = { ocr: true, pdf: true, help: true, dictation: true, recallSemantic: true };

export function captureMetrics(): MetricsSink & { points: MetricPoint[] } {
  const points: MetricPoint[] = [];
  return { points, emit: (p) => { points.push(p); } };
}

export function jobDeps(slots: Record<string, SlotExtrasPort>, o: Partial<ExtrasJobDeps> & { db?: D1Shim } = {}): ExtrasJobDeps & { db: D1Shim; metrics: ReturnType<typeof captureMetrics>; logs: Record<string, unknown>[] } {
  const db = o.db ?? d1Shim();
  const logs: Record<string, unknown>[] = [];
  const metrics = captureMetrics();
  return {
    ai: fakeAi({}), images: null, vectors: null, launch: null, files: memoryR2(), ledger: d1JobLedger(db), counters: memoryDailyCounters(),
    neurons: memoryNeuronBudget(), flags: async () => FLAGS_ON, gatewayFor: () => null,
    slots: (slot) => { const s = slots[slot]; if (!s) throw new Error(`no slot ${slot}`); return s; },
    log: (e) => { logs.push(e); },
    ...o,
    metrics, db, logs,
  };
}
