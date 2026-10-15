import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunHandle } from "@weft/contracts";
import { employerTaxRates } from "@weft/db";
import { count, makeWorld, type World } from "./fixtures";
import { encodings, Redactor } from "../src/index";

let w: World;
let h: RunHandle;
beforeEach(async () => {
  w = await makeWorld();
  h = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await w.close(); });

async function approvedRateChange(): Promise<number> {
  const o = await w.executor.agent.exec(h, { callId: "r", command: "tax.update_rate", args: { rate_id: "etr_0001", rate: "0.015" } });
  if (!(o.ok && o.status === "pending_approval")) throw new Error("expected a proposal");
  const r = await w.executor.human.decide({ proposalId: o.proposalId, decision: "approve", reasonCode: null, note: null, session: w.ui("usr_theo") });
  if (!(r.ok && r.proposal.executedActionSeq)) throw new Error(JSON.stringify(r));
  return r.proposal.executedActionSeq;
}

describe("action log integrity", () => {
  it("UPDATE or DELETE on actions or approval_audit aborts", async () => {
    await approvedRateChange();
    const aborts = async (q: string) => {
      const err = await w.db.run(q as never).then(() => null, (e: unknown) => e);
      expect(String((err as { cause?: unknown })?.cause ?? err)).toMatch(/append-only/);
    };
    await aborts(`UPDATE actions SET summary = 'x'`);
    await aborts(`DELETE FROM actions`);
    await aborts(`UPDATE approval_audit SET outcome = 'x'`);
    await aborts(`DELETE FROM approval_audit`);
  });

  it("verify reports ok, no gaps, one action per executed proposal; a tampered row is detected", async () => {
    await approvedRateChange();
    await w.executor.agent.exec(h, { callId: "m", command: "comms.send_message", args: { channel: "#payroll", text: "Rate updated." }, batch: 2 } as never);
    const ok = await w.executor.verifyChain();
    expect(ok).toMatchObject({ ok: true, gaps: [], badSeq: null, gitLag: 0 });
    expect(ok.head?.seq).toBe(2);
    await w.db.run(`DROP TRIGGER actions_no_update` as never);
    await w.db.run(`UPDATE actions SET summary = 'tampered', command = 'tax.revert_rate' WHERE seq = 1` as never);
    const bad = await w.executor.verifyChain();
    expect(bad).toMatchObject({ ok: false, badSeq: 1 });
  });
});

describe("rollback", () => {
  it("rollback of tax.update_rate appends a reversing row with reverses_seq and restores the rate", async () => {
    const seq = await approvedRateChange();
    const o = await w.executor.human.rollback(w.ui("usr_dana"), { seq, reason: "wrong account" });
    expect(o.ok && o.status === "done" && o.actionSeq).toBe(seq + 1);
    const [rate] = await w.db.select().from(employerTaxRates).where(eq(employerTaxRates.id, "etr_0001"));
    expect(rate!.rate).toBe("0.034");
    const [row] = await w.db.all<{ reverses_seq: number; command: string }>(`SELECT reverses_seq, command FROM actions WHERE seq = ${seq + 1}` as never);
    expect(row).toEqual({ reverses_seq: seq, command: "tax.revert_rate" });
    const again = await w.executor.human.rollback(w.ui("usr_dana"), { seq, reason: "again" });
    expect(!again.ok && again.refusal.code).toBe("NOT_PERMITTED");
    expect((await w.executor.verifyChain()).ok).toBe(true);
  });

  it("irreversible actions return a refusal with the reason; rollback needs the UI session", async () => {
    await w.executor.agent.exec(h, { callId: "m", command: "comms.send_message", args: { channel: "#payroll", text: "hello" } });
    const o = await w.executor.human.rollback(w.ui("usr_dana"), { seq: 1, reason: "oops" });
    expect(!o.ok && o.refusal).toMatchObject({ code: "DOMAIN_IRREVERSIBLE", message: "A sent message cannot be unsent." });
    const k = await w.executor.human.rollback({ ...w.ui("usr_dana"), via: "api_key", keyScope: "admin" }, { seq: 1, reason: "x" });
    expect(!k.ok && k.refusal.message).toMatch(/UI_SESSION_REQUIRED/);
  });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

describe("redaction", () => {
  it("covers raw, base64, base64url, hex and URL-encoded forms plus SSN, EIN, routing and account patterns", () => {
    const r = new Redactor();
    const secret = "sim-pass/word+=?&1234";
    r.add(secret);
    for (const f of encodings(secret)) expect(r.redact(`x ${f} y`)).not.toContain(f);
    expect(r.redact("ssn 123-45-6789")).toBe("ssn ***-**-****");
    expect(r.redact("EIN 12-3456789")).toBe("EIN **-*******");
    expect(r.redact("routing number: 021000021")).toBe("routing number: [redacted]");
    expect(r.redact("account no 12345678901")).toBe("account no [redacted]");
    expect(r.redact("payroll 150000000 cents")).toBe("payroll 150000000 cents");
  });

  it("a seeded vault value never appears in the DB file, artifacts or outcomes in any encoding", async () => {
    const value = "sim-portal-Secret-9f8e7d6c5b4a";
    await w.executor.vault.put({ name: "test-portal", kind: "portal_password", value, description: "test", by: "usr_dana" });
    // a command that leaks it into args and output text still gets redacted
    const o = await w.executor.agent.exec(h, { callId: "leak", command: "comms.send_message", args: { channel: "#payroll", text: `the password is ${value} (${Buffer.from(value).toString("base64")})` } });
    expect(JSON.stringify(o)).not.toContain(value);
    const forms = encodings(value);
    for (const f of filesUnder(w.dir)) {
      if (f.endsWith("-shm")) continue;
      const bytes = readFileSync(f).toString("latin1");
      for (const form of forms) expect(bytes.includes(form), `${form} in ${f}`).toBe(false);
    }
    expect(await count(w.db, "vault_secrets")).toBe(10);
  });
});

describe("redaction patterns stay narrow", () => {
  it("does not hit words that merely contain aba or ordinary ids", () => {
    const r = new Redactor();
    expect(r.redact("database row 123456789")).toBe("database row 123456789");
    expect(r.redact("Updated account txa_0003 for pay_2026_10_30")).toBe("Updated account txa_0003 for pay_2026_10_30");
  });
});
