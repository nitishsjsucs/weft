// Wave 4 chat domain routing (docs/evals/error-analysis.md FM2): the comms.post_update slot, which chat is never
// offered, carries one domain read chosen by code from the person's words. Read-only, at most 16 names, frozen in the
// run's allowlist when the run opens. Scripted provider only; nothing here calls a live model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CHAT_ACT_TOOLS, CHAT_DOMAIN_ROUTES, CHAT_ROUTE_SLOT, CHAT_TOOLS_W3, W3_SETTINGS } from "@weft/contracts";
import { execRuns, settings } from "@weft/db";
import { createTestWeft, type TestWeft } from "../src/testing";
import { chooseChatTools, registered, routedDomain, routeInto } from "../src/agent/chat-allowlist";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

const session = (principalId: string) => ({ principalId, companyId: "cmp_larkspur", via: "ui" as const, keyScope: null });
async function setCanPropose(on: boolean) {
  await weft.db.insert(settings).values({ key: W3_SETTINGS.chatCanPropose, valueJson: JSON.stringify(on) }).onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(on) } });
}
type Def = { effect: string; approval: unknown; autoAllow: string };
const reg = () => weft.executor.registry as typeof weft.executor.registry & { def(n: string): Def | undefined };

describe("routedDomain", () => {
  it("names the domain a request asks about, and nothing for other questions", () => {
    expect(routedDomain("Did the benefits carrier overbill us this month?")?.tool).toBe("benefits.list_findings");
    expect(routedDomain("Are our benefits invoices right?")?.tool).toBe("benefits.list_findings");
    expect(routedDomain("Fix the Workday conflict for Ruth.")?.tool).toBe("integrations.list_sync_items");
    expect(routedDomain("Is the Greenhouse sync healthy?")?.tool).toBe("integrations.list_sync_items");
    expect(routedDomain("Who's out next week?")?.tool).toBe("time_off.team_calendar");
    expect(routedDomain("Is anyone on leave in Engineering?")?.tool).toBe("time_off.team_calendar");
    for (const t of ["What's left on Imani's offboarding?", "Is Noor ready for Monday?", "Who approved the last payroll?", "Why did Hollis's gross change?", "", "   "]) {
      expect(routedDomain(t), t).toBeNull();
    }
  });

  it("every route is a registered read the main agent can use", () => {
    for (const r of CHAT_DOMAIN_ROUTES) {
      expect(reg().def(r.tool)?.effect, r.tool).toBe("read");
      expect(reg().get(r.tool)?.tiers.main, r.tool).toBe("executable");
    }
  });
});

describe("chooseChatTools with routing", () => {
  it("swaps the routed read into the comms.post_update slot: still 16 at most, still read-only", async () => {
    await setCanPropose(false);
    const base = registered(reg(), CHAT_TOOLS_W3)!;
    for (const [text, tool] of [["Did the benefits carrier overbill us this month?", "benefits.list_findings"], ["Fix the Workday conflict for Ruth.", "integrations.list_sync_items"], ["Who's out next week?", "time_off.team_calendar"]] as const) {
      const c = await chooseChatTools({ db: weft.db, registry: reg() }, session("usr_dana"), text);
      expect(c.mode, text).toBe("read");
      expect(c.routed, text).toEqual({ domain: CHAT_DOMAIN_ROUTES.find((r) => r.tool === tool)!.domain, tool });
      expect(c.allowlist!.length).toBeLessThanOrEqual(16);
      expect(c.allowlist!.length).toBe(base.length);
      expect(c.allowlist).toContain(tool);
      expect(c.allowlist).not.toContain(CHAT_ROUTE_SLOT);
      // Same position, so every other name keeps its place.
      expect(c.allowlist!.indexOf(tool)).toBe(base.indexOf(CHAT_ROUTE_SLOT));
      // Read-only: every name on a routed default run is a read.
      expect(c.allowlist!.filter((n) => reg().def(n)?.effect !== "read")).toEqual([]);
    }
  });

  it("an unrouted question keeps the wave 3 list, and route: false turns routing off", async () => {
    const plain = await chooseChatTools({ db: weft.db, registry: reg() }, session("usr_dana"), "What's left on Imani's offboarding?");
    expect(plain.routed).toBeNull();
    expect(plain.allowlist).toEqual(registered(reg(), CHAT_TOOLS_W3));
    const off = await chooseChatTools({ db: weft.db, registry: reg(), route: false }, session("usr_dana"), "Who's out next week?");
    expect(off.routed).toBeNull();
    expect(off.allowlist).toEqual(registered(reg(), CHAT_TOOLS_W3));
  });

  it("fails closed: a route the registry lacks, cannot offer, or registers as a write is never swapped in", () => {
    const names = registered(reg(), CHAT_TOOLS_W3)!;
    const asWrite = { get: (n: string) => (n === "benefits.list_findings" ? { tiers: { main: "executable" }, effect: "write" } : reg().get(n)), def: (n: string) => (n === "benefits.list_findings" ? { effect: "write", approval: "never", autoAllow: "never" } : reg().def(n)) };
    expect(routeInto(asWrite, names, "Did the carrier overbill us?")).toEqual({ names, routed: null });
    const missing = { get: (n: string) => (n === "time_off.team_calendar" ? undefined : reg().get(n)) };
    expect(routeInto(missing, names, "Who's out next week?")).toEqual({ names, routed: null });
    const hidden = { get: (n: string) => (n === "integrations.list_sync_items" ? { tiers: { main: "unavailable" }, effect: "read" } : reg().get(n)) };
    expect(routeInto(hidden, names, "Fix the Workday conflict")).toEqual({ names, routed: null });
    expect(routeInto(undefined, names, "Who's out next week?")).toEqual({ names, routed: null });
    // A list without the slot never grows.
    const noSlot = names.filter((n) => n !== CHAT_ROUTE_SLOT);
    expect(routeInto(reg(), noSlot, "Who's out next week?")).toEqual({ names: noSlot, routed: null });
  });

  it("the chat_can_propose variant routes the same read and keeps every act write proposal-only", async () => {
    await setCanPropose(true);
    try {
      const c = await chooseChatTools({ db: weft.db, registry: reg() }, session("usr_dana"), "Please fix the Workday conflict for Ruth");
      expect(c.mode).toBe("act");
      expect(c.routed?.tool).toBe("integrations.list_sync_items");
      expect(c.allowlist!.length).toBeLessThanOrEqual(16);
      expect(c.allowlist).not.toContain(CHAT_ROUTE_SLOT);
      const writes = c.allowlist!.filter((n) => reg().def(n)?.effect !== "read");
      expect(writes.every((n) => (CHAT_ACT_TOOLS as readonly string[]).includes(n))).toBe(true);
      for (const n of writes) expect(reg().def(n)).toMatchObject({ approval: "always", autoAllow: "never" });
    } finally {
      await setCanPropose(false);
    }
  });

  it("a live provider keeps the routed reads (their schemas pass the strict check)", async () => {
    for (const text of ["Did the carrier overbill us?", "Fix the Workday conflict", "Who's out next week?"]) {
      const c = await chooseChatTools({ db: weft.db, registry: reg(), liveProvider: true }, session("usr_dana"), text);
      expect(c.dropped, text).toEqual([]);
      expect(c.routed, text).not.toBeNull();
    }
  });
});

describe("POST /v1/agent/runs freezes the routed list in the run", () => {
  it("the run's allowlist holds the routed read, and a call to it is allowed while comms.post_update is not", async () => {
    const res = await weft.app.request("/v1/agent/runs", { method: "POST", headers: { ...weft.uiHeaders("usr_dana"), "content-type": "application/json" }, body: JSON.stringify({ text: "Did the benefits carrier overbill us this month?", pageContext: null }) });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    // The runtime settles runs (the AgentRuntime type does not list it); wait so the scripted run ends before close.
    const rt = weft.agent as unknown as { settled?: (id: string) => Promise<unknown> };
    if (typeof rt.settled === "function") await rt.settled(runId);
    const [row] = await weft.db.select().from(execRuns).where(eq(execRuns.id, runId)).limit(1);
    const frozen = JSON.parse(String((row as { allowlistJson?: string }).allowlistJson ?? "null")) as string[] | null;
    expect(frozen).toContain("benefits.list_findings");
    expect(frozen).not.toContain(CHAT_ROUTE_SLOT);
    expect(frozen!.length).toBeLessThanOrEqual(16);
    // The executor enforces the frozen list: the routed read runs, the swapped-out slot is refused.
    const h = await weft.executor.runs.openChatRun(session("usr_dana"), { threadId: null, surface: "human_ui", allowlist: frozen! });
    const ok = await weft.executor.agent.exec(h, { callId: "c1", command: "benefits.list_findings", args: {} });
    expect(ok.ok).toBe(true);
    const no = await weft.executor.agent.exec(h, { callId: "c2", command: "comms.post_update", args: { text: "hi" } });
    expect(!no.ok && no.refusal.code).toBe("UNAVAILABLE");
  });
});
