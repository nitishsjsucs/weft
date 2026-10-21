// Which committed commands need an after-commit job (design 3.4), as the queue side and its tests see it. The one
// mapping is the executor's jobsFor (packages/executor/src/hosted/outbox.ts), which the outbox writer calls inside the
// command's own transaction (reads only, no I/O: the IO_IN_TX guard applies): a newly attached receipt and an
// uploaded notice need OCR, and a memory note written while semantic recall is on needs an embedding. This wraps it
// with the job envelope. PDF renders are not outbox jobs: the PDF route enqueues them on demand. Track cf6-extras.
import type { DbTx } from "@weft/db";
import { jobsFor, OUTBOX_COMMANDS } from "@weft/executor";
import type { HostedJob } from "@weft/cf-extras";

export { OUTBOX_COMMANDS };

/** One command that committed, as the outbox writer sees it. */
export interface CommittedCall { command: string; input: unknown; data: unknown }
export interface OutboxJobOptions {
  world: { slot: string; gen: number };
  newJobId: () => string;
  /** The memoized `recall.semantic` flag: off means no embedding jobs (and no embedding neurons). */
  semanticRecall: boolean;
  /** The writing run was tainted (its note's embedding is untrusted). */
  tainted?: boolean;
}

export async function extrasOutboxJobs(tx: DbTx, call: CommittedCall, o: OutboxJobOptions): Promise<HostedJob[]> {
  const drafts = await jobsFor(tx, o.world, { name: call.command as never }, call.input, call.data, { tainted: o.tainted ?? false, semanticRecall: o.semanticRecall });
  return drafts.map((d) => ({ v: 1, ...d, jobId: o.newJobId(), slot: o.world.slot, gen: o.world.gen }) as HostedJob);
}
