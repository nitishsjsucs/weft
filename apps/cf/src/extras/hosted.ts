// HostedExtras' logic (design 3.1 and 10): Help search, dictation, the Platform readout, the model comparison, the run
// catalog writer and world export downloads, for the front Worker's /api/_hosted/* routes. The front applies the
// gates first (design 6.3): RL_API for Help, the mutation gate (lease, human grant, RL_RUN) for dictation. This file
// builds on plain dependencies so it runs under vitest; entrypoint.ts wraps it in the WorkerEntrypoint. Track cf6-extras.
import {
  createDictation, type AiGatewayOption, type DictationResult, type HelpSearch, type MetricsSink, type NeuronBudget, type PlatformReadout, type R2BucketLike,
  type RunCatalog, type WorkersAiBindingLike,
} from "@weft/cf-extras";
import type { AigMetadata } from "../../../../packages/contracts/src/ext/cf-agent";
import { hostedWorldId } from "../../../../packages/contracts/src/ext/cf-hosted";
import { exportObjectKey } from "./queues";
import type { DictateInput, HostedExtrasApi, SlotExport } from "./ports";

export interface HostedExtrasDeps {
  help: HelpSearch;
  ai: WorkersAiBindingLike | null;
  neurons: NeuronBudget;
  dictationEnabled: () => Promise<boolean>;
  catalog: RunCatalog | null;
  platform: () => Promise<PlatformReadout>;
  files: R2BucketLike;
  metrics: MetricsSink;
  gatewayFor: (meta: AigMetadata) => AiGatewayOption | null;
}

export function createHostedExtras(deps: HostedExtrasDeps): HostedExtrasApi {
  return {
    help: (query) => deps.help.search(String(query ?? "")),
    async dictate(input: DictateInput): Promise<DictationResult> {
      if (!deps.ai) return { ok: false, code: "DICTATION_DISABLED", message: "Dictation is not available here" };
      const audio = input.audio instanceof Uint8Array ? input.audio : new Uint8Array(input.audio);
      const slot = input.slot ?? "showcase";
      const d = createDictation({
        ai: deps.ai, neurons: deps.neurons, enabled: deps.dictationEnabled,
        gateway: deps.gatewayFor({ slot, gen: input.gen ?? 0, run: null, kind: "dictation", visitor: input.visitor }),
        charge: { world: input.slot && input.gen !== null ? hostedWorldId({ slot: input.slot, gen: input.gen }) : null, visitor: input.visitor, ipHash: input.ipHash },
      });
      const r = await d.transcribe({ audio, contentType: input.contentType });
      if (r.ok) deps.metrics.emit({ name: "job.done", value: r.seconds, slot, tags: { kind: "dictation" } });
      return r;
    },
    platform: () => deps.platform(),
    async models(opts) { return deps.catalog ? deps.catalog.compare({ days: opts?.days }) : []; },
    async recordRun(row) {
      if (!deps.catalog) return;
      await deps.catalog.record(row);
      deps.metrics.emit({ name: "run.ended", value: row.latencyMs, slot: row.slot, tags: { provider: row.provider, status: row.status } });
    },
    async exportFile(input): Promise<SlotExport | null> {
      const obj = await deps.files.get(exportObjectKey(input));
      if (!obj) return null;
      // An export belongs to its world and generation; the key carries both, and so does the stored metadata.
      if (obj.customMetadata && (obj.customMetadata.slot !== input.slot || obj.customMetadata.gen !== String(input.gen))) return null;
      return { bytes: new Uint8Array(await obj.arrayBuffer()), contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
    },
  };
}
