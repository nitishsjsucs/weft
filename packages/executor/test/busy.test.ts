// A writer outside withWriteLock (the scaffold clock and scheduler cursor today) can hold SQLite's write lock while
// the executor starts a transaction. The executor waits and retries instead of failing the call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { RunHandle } from "@weft/contracts";
import { makeWorld, type World } from "./fixtures";

let w: World;
let h: RunHandle;
beforeEach(async () => {
  w = await makeWorld();
  h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await w.close(); });

describe("an outside writer holding the SQLite write lock", () => {
  it("delays an executor write instead of failing it", async () => {
    let release!: () => void;
    const held = new Promise<void>((ok) => { release = ok; });
    const outside = w.db.transaction(async (tx) => {
      await tx.run(sql`INSERT INTO settings (key, value_json) VALUES ('test.outside', '1') ON CONFLICT (key) DO UPDATE SET value_json = '1'`);
      await held;
    });
    await new Promise((r) => setTimeout(r, 20));
    const call = w.executor.agent.exec(h, { callId: "b1", command: "comms.send_message", args: { channel: "#payroll", text: "Payroll is ready for review" } });
    setTimeout(release, 150);
    await outside;
    expect(await call).toMatchObject({ ok: true, status: "done" });
    expect(await w.executor.verifyChain()).toMatchObject({ ok: true });
  });
});
