// Where the visitor-facing extras plug into weft-core (design 3.1, 5.4 and 7.1; track cf6-extras). Two seams:
//
// - HostedExtras, the WorkerEntrypoint the front Worker reaches over the CORE service binding for
//   /api/_hosted/{platform,models,help,dictate,pdf/...}. The front forwards the request with its x-weft-ctx; the
//   entrypoint answers it. src/core/index.ts exports cf6's entrypoint once it lands, and this file's
//   ExtrasFallback until then: every extra is off (each answers its *_DISABLED code) and the Platform readout comes
//   from the Lobby and SpendDO.
// - Job handlers for the weft-jobs and weft-render queues, keyed by HostedJob kind, registered by the extras module.
//   A job whose kind has no handler is acknowledged and logged: with every flag off no outbox row is ever written.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DO_NAMES, HOSTED_PATHS, TRUST_HEADERS,
  type DictationResult, type HelpSearchResult, type HostedJob, type HostedJobKind, type PlatformReadout,
} from "../shared/contracts";
import type { CoreEnv } from "../shared/env";
import { json, plainError } from "../shared/http";
import { readCtx } from "../shared/tokens";

/** What the front calls on the CORE binding. */
export interface HostedExtrasApi {
  fetch(request: Request): Promise<Response>;
}

export type JobHandler = (job: HostedJob, env: CoreEnv) => Promise<void>;
export type DeadLetterHandler = (job: unknown, env: CoreEnv, info: { queue: string; attempts: number; id: string }) => Promise<void>;

const handlers = new Map<HostedJobKind, JobHandler>();
let deadLetter: DeadLetterHandler | null = null;

/** The extras module registers its handlers once at module evaluation. */
export function registerJobHandlers(h: Partial<Record<HostedJobKind, JobHandler>>, dlq?: DeadLetterHandler): void {
  for (const [k, fn] of Object.entries(h)) if (fn) handlers.set(k as HostedJobKind, fn);
  if (dlq) deadLetter = dlq;
}
export function jobHandler(kind: HostedJobKind): JobHandler | null {
  return handlers.get(kind) ?? null;
}
export function deadLetterHandler(): DeadLetterHandler | null {
  return deadLetter;
}
/** Tests only. */
export function clearJobHandlers(): void {
  handlers.clear();
  deadLetter = null;
}

/** The Platform readout from what weft-core itself knows: the Lobby's counters and SpendDO's ledger. */
export async function platformReadout(env: CoreEnv): Promise<PlatformReadout> {
  const lobby = env.LOBBY.get(env.LOBBY.idFromName(DO_NAMES.lobby));
  const spend = env.SPEND.get(env.SPEND.idFromName(DO_NAMES.spend));
  const [l, s] = await Promise.all([lobby.readout(), spend.status({})]);
  let deadLetters = 0;
  if (env.OPS) {
    try {
      const row = await env.OPS.prepare(`SELECT COUNT(*) AS n FROM failed_jobs WHERE failed_at >= ?1`).bind(`${l.day}T00:00:00.000Z`).first<{ n: number }>();
      deadLetters = row?.n ?? 0;
    } catch { /* the D1 schema is apps/cf/d1's; absent means none recorded */ }
  }
  return {
    day: l.day,
    level: l.level,
    dollars: { spentUsd: s.spentMicros.day / 1e6, dayCapUsd: s.caps.dayUsd, runCapUsd: s.caps.runUsd },
    neurons: { used: s.neurons.used, cap: s.caps.neuronsDay },
    restoresLeft: l.restoresLeft,
    leases: l.leases,
    deadLetters,
    lastSweepAt: l.lastSweepAt,
    shares: l.shares,
  };
}

/** HostedExtras while the extras are not built in: Platform from the Lobby and SpendDO, everything else off. */
export class ExtrasFallback extends WorkerEntrypoint<CoreEnv> implements HostedExtrasApi {
  override async fetch(request: Request): Promise<Response> {
    const ctx = await readCtx(this.env.WEFT_CTX_SECRET ?? "", request.headers.get(TRUST_HEADERS.ctx));
    if (!ctx.ok) return plainError(401, "Unauthorized", "SESSION_INVALID", "This request did not come through Weft's front door");
    const path = new URL(request.url).pathname;
    if (path === HOSTED_PATHS.platform) return json(await platformReadout(this.env));
    if (path === HOSTED_PATHS.models) return json([]);
    if (path === HOSTED_PATHS.help) {
      const body: HelpSearchResult = { ok: false, code: "HELP_DISABLED", message: "Help search is off on this deployment" };
      return json(body);
    }
    if (path === HOSTED_PATHS.dictate) {
      const body: DictationResult = { ok: false, code: "DICTATION_DISABLED", message: "Dictation is off on this deployment" };
      return json(body);
    }
    if (path.startsWith(`${HOSTED_PATHS.pdf}/`)) return plainError(404, "NotFound", "PDF_DISABLED", "PDF rendering is off on this deployment");
    return plainError(404, "NotFound", "NOT_FOUND", "No such hosted route");
  }
}
