// design 11.3 on the node:sqlite emulator: the same cases and the same expected observations as the workerd run
// (test-workerd/conformance.workerd.test.ts), so the emulator stays pinned to the runtime it stands in for.
import { describe, expect, it } from "vitest";
import { DurableEmulator, WORKERD_MESSAGES } from "../src/emu";
import { CASES, GATE_TIMEOUT_MESSAGE, SUBS, messageOf, type CaseHost, type Outcome } from "../test-workerd/cases";

/** The gate timeout is 30 s as in workerd; the hang cases use 1 s here so the suite stays quick. */
const host = (emu: DurableEmulator): CaseHost => {
  const h: CaseHost = {
    storage: emu, platform: "emulator",
    sleep: (ms) => emu.sleep(ms),
    deliver: (name) => emu.deliver(() => SUBS[name](h)),
  };
  return h;
};

async function run(fn: () => Promise<unknown>): Promise<Outcome> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: messageOf(e) }; }
}

describe("transaction conformance on the emulator (design 11.3)", () => {
  for (const c of CASES) {
    it.concurrent(c.name, async () => {
      const emu = new DurableEmulator({ gateTimeoutMs: c.slow ? 1_000 : 30_000 });
      try {
        expect(await run(() => c.run(host(emu)))).toEqual(c.expect);
        if (c.after) {
          const next = emu.reset ? emu.revive() : emu;
          expect(await run(() => c.after!(host(next)))).toEqual({ ok: true, value: c.expectAfter });
        }
        expect(emu.replayFailures).toBe(0);
      } finally { emu.close(); }
    }, 20_000);
  }

  it("uses workerd's 30 s gate timeout and message by default", () => {
    expect(GATE_TIMEOUT_MESSAGE).toBe(WORKERD_MESSAGES.gateTimeout);
    expect((new DurableEmulator() as unknown as { gateTimeoutMs: number }).gateTimeoutMs).toBe(30_000);
  });
});
