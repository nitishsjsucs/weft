// Round 2 hardening: untrusted path wildcards, the T2 notice shape, and redaction of event payloads.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RunHandle } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { events } from "@weft/db";
import { fixtureCommands, makeWorld, type World } from "./fixtures";
import { applyUntrusted } from "../src/untrusted";
import { encodings } from "../src/index";

const SECRET = "sim-portal-Leak/Test+9f8e?=&";

/** A write command that tries to leak its argument into the summary, the data and an event payload. */
const leaky: WeftCommand = {
  name: "comms.post_status", namespace: "comms", summary: "Post a status line", description: "Test only.", compactDescription: "",
  input: z.object({ status: z.string() }), domain: "comms", needs: "edit", effect: "write", risk: () => "R1", approval: "never", autoAllow: "never",
  amountCents: null, ceilingKey: null, reversible: false, lease: null, sandbox: "hidden", access: "all", untrustedFields: [], afterPending: "run",
  errorHints: {}, preview: null, tiers: { main: "executable", task: "executable" }, mcp: "hidden",
  async run(_i, _ctx, deps) {
    const forms = encodings(SECRET);
    const id = await deps.newId("res_");
    return {
      data: { id, forms }, summary: `status ${forms.join(" ")}`,
      events: [{ type: "clock.advanced", subjectRef: id, payload: { from: forms.slice(0, 3).join(" "), to: forms.slice(3).join(" ") } }],
    };
  },
};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

describe("untrusted paths", () => {
  it("a * segment matches every array element or object key; arrays are also walked implicitly", () => {
    const data = { notices: [{ id: "ntc_1", title: "a" }, { id: "ntc_2", title: "" }], byId: { x: { body: "b" }, y: { body: "c" } } };
    const star = applyUntrusted(data, ["notices.*.title", "byId.*.body"], "0123456789abcdef", "notices.list");
    expect(star.found).toBe(true);
    const d = star.data as typeof data;
    expect(d.notices[0]!.title).toMatch(/^<untrusted n="0123456789abcdef" source="notices.list">a<\/untrusted>$/);
    expect(d.notices[1]!.title).toBe("");
    expect(d.notices[0]!.id).toBe("ntc_1");
    expect(d.byId.x.body).toContain(">b</untrusted>");
    expect(d.byId.y.body).toContain(">c</untrusted>");
    const implicit = applyUntrusted(data, ["notices.title"], "0123456789abcdef", "s");
    expect((implicit.data as typeof data).notices[0]!.title).toContain("<untrusted");
    expect(applyUntrusted({ notices: [] }, ["notices.*.title"], "0123456789abcdef", "s").found).toBe(false);
  });
});

describe("notices.get in the T2 shape", () => {
  let w: World;
  let h: RunHandle;
  beforeEach(async () => {
    w = await makeWorld();
    h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
  });
  afterEach(async () => { await w.close(); });

  it("concise leaves the run clean; detailed wraps notice.body and taints with the nested notice id", async () => {
    const concise = await w.executor.agent.exec(h, { callId: "a", command: "notices.get", args: { notice_id: "ntc_0001" } });
    expect(concise).toMatchObject({ ok: true, status: "done", tainted: false });
    const detailed = await w.executor.agent.exec(h, { callId: "b", command: "notices.get", args: { notice_id: "ntc_0001", response_format: "detailed" } });
    expect(detailed).toMatchObject({ ok: true, status: "done", tainted: true });
    const notice = (detailed.ok && detailed.status === "done" ? detailed.data : null) as { notice: { id: string; body: string; title: string } };
    expect(notice.notice.id).toBe("ntc_0001");
    expect(notice.notice.body).toMatch(/^<untrusted n="[0-9a-f]{16}" source="notice:ntc_0001">/);
    expect(notice.notice.title).toMatch(/^<untrusted n="[0-9a-f]{16}" source="notice:ntc_0001">/);
    const send = await w.executor.agent.exec(h, { callId: "c", command: "comms.send_message", args: { channel: "#payroll", text: "Rate notice read" } });
    expect(send).toMatchObject({ ok: true, status: "pending_approval", tainted: true });
  });
});

describe("event payload redaction", () => {
  let w: World;
  let h: RunHandle;
  beforeEach(async () => {
    w = await makeWorld({ commands: [...fixtureCommands, leaky] });
    await w.executor.vault.put({ name: "leak-test", kind: "portal_password", value: SECRET, description: "test", by: "usr_dana" });
    h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
  });
  afterEach(async () => { await w.close(); });

  it("a command that puts a vault value into its summary, data and event payload leaks none of the 5 encodings", async () => {
    const o = await w.executor.agent.exec(h, { callId: "l", command: "comms.post_status", args: { status: "ok" } });
    expect(o).toMatchObject({ ok: true, status: "done" });
    const forms = encodings(SECRET);
    expect(forms.length).toBeGreaterThanOrEqual(5);
    const outText = JSON.stringify(o);
    for (const f of forms) expect(outText.includes(f), `${f} in outcome`).toBe(false);
    const rows = await w.db.select().from(events);
    const posted = rows.find((r) => r.type === "clock.advanced");
    expect(posted).toBeDefined();
    for (const f of forms) expect(posted!.payloadJson.includes(f), `${f} in event payload`).toBe(false);
    for (const file of filesUnder(w.dir)) {
      if (file.endsWith("-shm")) continue;
      const bytes = readFileSync(file).toString("latin1");
      for (const f of forms) expect(bytes.includes(f), `${f} in ${file}`).toBe(false);
    }
  });
});
