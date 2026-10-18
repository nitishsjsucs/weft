// The equivalent-proposal check (fix group duplicate-proposal): a repeat of an open proposal returns it, a repeat of a
// recently decided one is refused with DOMAIN_DUPLICATE_PROPOSAL, and anything that differs still supersedes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunHandle, ToolOutcome } from "@weft/contracts";
import { count, makeWorld, type World } from "./fixtures";
import { EQUIVALENT_DECIDED_WINDOW_MS } from "../src/proposals";
import { DUPLICATE_PROPOSAL_CODE, isExistingProposalOutcome } from "../../contracts/src/ext/fx-duplicate-proposal";

let w: World;
let h1: RunHandle;
let h2: RunHandle;
beforeEach(async () => {
  w = await makeWorld();
  h1 = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
  h2 = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
});
afterEach(async () => { await w.close(); });

const RATE = { rate_id: "etr_0001", rate: "0.015", source_notice_id: "ntc_0001" };
const exec = (h: RunHandle, callId: string, args: unknown = RATE, command = "tax.update_rate") => w.executor.agent.exec(h, { callId, command, args });
const pendingId = (o: ToolOutcome) => { if (!(o.ok && o.status === "pending_approval")) throw new Error(JSON.stringify(o)); return o.proposalId; };
const decide = (proposalId: string, decision: "approve" | "deny") => w.executor.human.decide({ proposalId, decision, reasonCode: null, note: null, session: w.ui("usr_theo") });

describe("equivalent proposals", () => {
  it("a second run asking for the same change gets the open proposal back and files nothing", async () => {
    const first = pendingId(await exec(h1, "a"));
    const again = await exec(h2, "b", { source_notice_id: "ntc_0001", rate: "0.015", rate_id: "etr_0001" });   // key order does not matter
    expect(pendingId(again)).toBe(first);
    expect(isExistingProposalOutcome(again)).toBe(true);
    expect(isExistingProposalOutcome(again) && again.note).toContain(first);
    expect(await count(w.db, "proposals")).toBe(1);
    expect(await count(w.db, "proposals", "status = 'superseded'")).toBe(0);
    // The run that got the proposal back is not its proposer, so it does not wait on it.
    expect((await w.executor.agent.runState(h2)).pendingProposalIds).toEqual([]);
    expect((await w.executor.agent.runState(h1)).pendingProposalIds).toEqual([first]);
  });

  it("the same run repeating a call with a new call id also gets the open proposal back", async () => {
    const first = pendingId(await exec(h1, "a"));
    expect(pendingId(await exec(h1, "b"))).toBe(first);
    expect(await count(w.db, "proposals")).toBe(1);
  });

  it("different arguments are not a duplicate: the new proposal supersedes the old one (harness 5.4)", async () => {
    const first = pendingId(await exec(h1, "a"));
    const second = pendingId(await exec(h2, "b", { ...RATE, rate: "0.016" }));
    expect(second).not.toBe(first);
    expect(await count(w.db, "proposals", `status = 'superseded' AND id = '${first}'`)).toBe(1);
  });

  it("an approved and executed equivalent is refused with the proposal named, until the window passes", async () => {
    const first = pendingId(await exec(h1, "a"));
    expect((await decide(first, "approve")).ok).toBe(true);
    const again = await exec(h2, "b");
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal.code).toBe(DUPLICATE_PROPOSAL_CODE);
    expect(again.refusal.message).toContain(first);
    expect(again.refusal.example).toMatchObject({ proposal_id: first, status: "executed" });
    expect(await count(w.db, "proposals")).toBe(1);
    await w.clock.set(new Date(Date.parse(w.clock.now()) + EQUIVALENT_DECIDED_WINDOW_MS + 60_000).toISOString(), 0);
    // A refusal blocks the rest of its batch (harness 4.6), so the later attempt comes from a fresh run.
    const h3 = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    expect(pendingId(await exec(h3, "c"))).not.toBe(first);
  });

  it("a denied equivalent is refused while its subject is unchanged", async () => {
    const first = pendingId(await exec(h1, "a"));
    expect((await decide(first, "deny")).ok).toBe(true);
    const again = await exec(h2, "b");
    expect(!again.ok && again.refusal.code).toBe(DUPLICATE_PROPOSAL_CODE);
    expect(!again.ok && again.refusal.hint).toContain("turned it down");
    expect(await count(w.db, "proposals")).toBe(1);
  });

  it("an expired equivalent is not a duplicate", async () => {
    const first = pendingId(await exec(h1, "a"));
    await w.db.run(`UPDATE proposals SET status = 'expired', decided_at = '${w.clock.now()}' WHERE id = '${first}'` as never);
    expect(pendingId(await exec(h2, "b"))).not.toBe(first);
  });

  it("an untainted run never takes over a tainted proposal; a tainted run gets an untainted one back", async () => {
    const tainted = await w.executor.runs.openChatRun(w.ui("usr_dana"), { threadId: null, surface: "human_ui" });
    await w.executor.agent.exec(tainted, { callId: "read", command: "notices.get", args: { notice_id: "ntc_0001", response_format: "detailed" } });
    expect((await w.executor.agent.runState(tainted)).tainted).toBe(true);
    const dirty = pendingId(await exec(tainted, "a"));
    const clean = pendingId(await exec(h1, "b"));
    expect(clean).not.toBe(dirty);
    expect(await count(w.db, "proposals", `status = 'superseded' AND id = '${dirty}'`)).toBe(1);
    const back = await exec(tainted, "c");
    expect(pendingId(back)).toBe(clean);
    expect(back.tainted).toBe(true);
    expect(await count(w.db, "proposals", "status = 'pending'")).toBe(1);
  });
});
