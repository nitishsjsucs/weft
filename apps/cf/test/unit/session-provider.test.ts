// GET /api/_session's provider (design 5.2 and 6.5) against the runtime's own choice: the front cannot import
// chooseHostedProvider, so its mirror is pinned here over the same inputs, the world's model switch ("world") first.
import { describe, expect, it } from "vitest";
import { chooseHostedProvider, MIN_NEURONS_FOR_RUN as RUNTIME_MIN_NEURONS } from "../../../../packages/agent/src/providers/hosted";
import { HOSTED_CAP_DEFAULTS, type HostedProviderId, type HostedSpendStatus } from "../../src/shared/contracts";
import { MIN_NEURONS_FOR_RUN, sessionProvider, wantedProvider } from "../../src/front/session";

const status = (o: { day?: number; visitor?: number | null; ip?: number | null; live?: number; liveUsd?: number | null; neurons?: number; agentNeurons?: number } = {}): HostedSpendStatus => ({
  day: "2026-10-21",
  caps: { ...HOSTED_CAP_DEFAULTS, liveUsd: o.liveUsd === undefined ? HOSTED_CAP_DEFAULTS.liveUsd : o.liveUsd },
  spentMicros: { day: o.day ?? 0, visitor: o.visitor === undefined ? 0 : o.visitor, ip: o.ip === undefined ? 0 : o.ip, live: o.live ?? 0 },
  neurons: { used: o.neurons ?? 0, byProduct: { agent: o.agentNeurons ?? 0, ocr: 0, embeddings: 0, dictation: 0 } },
  openReservations: 0,
});
const all = new Set<HostedProviderId>(["openai", "workers_ai", "scripted"]);

describe("the session's provider", () => {
  it("uses the runtime's neuron threshold", () => {
    expect(MIN_NEURONS_FOR_RUN).toBe(RUNTIME_MIN_NEURONS);
  });

  it("reports the world's model switch as reason world, over the KV default", () => {
    expect(wantedProvider({ agentEnabled: true, configured: "openai", world: "workers_ai" })).toEqual({ id: "workers_ai", reason: "world" });
    expect(wantedProvider({ agentEnabled: true, configured: "workers_ai", world: "scripted" })).toEqual({ id: "scripted", reason: "world" });
    expect(wantedProvider({ agentEnabled: true, configured: "workers_ai", world: null })).toEqual({ id: "workers_ai", reason: "default" });
    expect(wantedProvider({ agentEnabled: true, configured: "nonsense", world: "also nonsense" })).toEqual({ id: "openai", reason: "default" });
    expect(wantedProvider({ agentEnabled: false, configured: "openai", world: "workers_ai" })).toEqual({ id: "scripted", reason: "paused" });
  });

  it("matches chooseHostedProvider over the KV default, the world setting, the kill switch and every cap", () => {
    const configs = [null, "openai", "workers_ai", "scripted", "nonsense"];
    const worlds = [null, "openai", "workers_ai", "scripted"];
    const statuses: [string, HostedSpendStatus | null][] = [
      ["unknown", null],
      ["fresh", status()],
      ["day spent", status({ day: 1_995_000 })],
      ["visitor spent", status({ visitor: 1_999_000 })],
      ["ip spent", status({ ip: 1_999_500 })],
      ["no lease", status({ visitor: null, ip: null })],
      ["live cap", status({ liveUsd: 0.5, live: 495_000 })],
      ["live cap off", status({ liveUsd: null, live: 9_000_000 })],
      ["neurons spent", status({ neurons: 4_500 })],
      ["agent share spent", status({ neurons: 3_100, agentNeurons: 3_100 })],
      ["agent share nearly spent", status({ neurons: 2_900, agentNeurons: 2_900 })],
    ];
    let n = 0;
    for (const enabled of [true, false]) for (const configured of configs) for (const world of worlds) for (const [label, s] of statuses) {
      const runtime = chooseHostedProvider({ agentEnabled: enabled, configured, world, available: all, status: s });
      const session = sessionProvider(wantedProvider({ agentEnabled: enabled, configured, world }), s);
      expect(session, `${enabled ? "on" : "paused"} kv=${configured} world=${world} ${label}`).toEqual(runtime);
      n += 1;
    }
    expect(n).toBe(2 * configs.length * worlds.length * statuses.length);
  });
});
