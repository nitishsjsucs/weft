// Tool-count cap (harness 5.3), the OpenAI error-class mapping (harness 11.2) and the SQLITE_BUSY retry on run-store
// writes. No live calls: the SDK client is a fake that throws the SDK's own error classes.
import { describe, expect, it } from "vitest";
import type { ModelStepRequest } from "@weft/contracts";
import { assertToolCap, CHAT_TOOLS, DRAFT_TOOLS, isBusy, lockedWrite, MAX_TOOLS, OPENAI_ERRORS as OpenAI, openaiProvider } from "../src/index";

describe("tool-count cap", () => {
  it("acceptance: every agent kind stays at or under 16 tools and chat sees exactly the 14 read tools", () => {
    expect(MAX_TOOLS).toBe(16);
    expect(CHAT_TOOLS).toHaveLength(14);
    expect(new Set(CHAT_TOOLS).size).toBe(14);
    expect(DRAFT_TOOLS.length).toBeLessThanOrEqual(MAX_TOOLS);
    // The routine_draft pack offers the chat tools plus comms.send_message as the tool enum.
    expect([...CHAT_TOOLS, "comms.send_message"].length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it("refuses an allowlist over the cap", () => {
    expect(() => assertToolCap(16, "x")).not.toThrow();
    expect(() => assertToolCap(17, "routine rt_big")).toThrow(/17 tools exceed the cap of 16/);
  });
});

const req: ModelStepRequest = {
  runId: "run_0001", agentKind: "main", model: "gpt-5.6-luna", frozenPrompt: "FROZEN", toolChoice: { mode: "auto" },
  history: [{ kind: "context", text: "x" }], tools: [], effort: "low", maxOutputTokens: 8000, cacheKey: "weft:main:chat:cmp_larkspur",
};
const headers = new Headers({ "x-request-id": "req_test" });
const throwing = (e: unknown) => openaiProvider({ apiKey: "sk-test-not-real", model: "gpt-5.6-luna", client: { responses: { create: async () => { throw e; } } } as never });

describe("openai error classes", () => {
  const cases: [string, unknown, string, boolean][] = [
    ["429 rate limit", OpenAI.APIError.generate(429, { error: { message: "slow down" } }, "slow down", headers), "PROVIDER_UNAVAILABLE", true],
    ["500 server error", OpenAI.APIError.generate(500, { error: { message: "boom" } }, "boom", headers), "PROVIDER_UNAVAILABLE", true],
    ["400 bad request", OpenAI.APIError.generate(400, { error: { message: "bad schema" } }, "bad schema", headers), "PROVIDER_REQUEST_INVALID", false],
    ["401 auth", OpenAI.APIError.generate(401, { error: { message: "no key" } }, "no key", headers), "PROVIDER_CONFIG", false],
    ["404 model", OpenAI.APIError.generate(404, { error: { message: "no model" } }, "no model", headers), "PROVIDER_CONFIG", false],
    ["connection", new OpenAI.APIConnectionError({ message: "reset" }), "PROVIDER_UNAVAILABLE", true],
    ["timeout", new OpenAI.APIConnectionTimeoutError({ message: "timed out" }), "PROVIDER_TIMEOUT", true],
    ["abort", new OpenAI.APIUserAbortError({ message: "aborted" }), "PROVIDER_TIMEOUT", false],
    ["unknown", new Error("weird"), "PROVIDER_UNAVAILABLE", false],
  ];
  for (const [name, e, code, retryable] of cases) {
    it(`${name} maps to ${code} (retryable ${retryable}) and runs no tool`, async () => {
      const r = await throwing(e).step(req);
      expect(r.stop).toBe("error");
      expect(r.toolCalls).toEqual([]);
      expect(r.error).toMatchObject({ code, retryable });
    });
  }

  it("keeps the request id and never echoes the key", async () => {
    const r = await throwing(OpenAI.APIError.generate(500, { error: { message: "boom" } }, "boom", headers)).step(req);
    expect(r.requestId).toBe("req_test");
    expect(JSON.stringify(r)).not.toContain("sk-test-not-real");
  });
});

describe("run-store writes retry SQLITE_BUSY", () => {
  const busy = () => Object.assign(new Error("Failed query: insert into run_steps"), { cause: Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }) });

  it("recognizes BUSY through the cause chain only", () => {
    expect(isBusy(busy())).toBe(true);
    expect(isBusy(new Error("UNIQUE constraint failed"))).toBe(false);
  });

  it("retries a busy write until it lands", async () => {
    let n = 0;
    const out = await lockedWrite(async () => { if (++n < 3) throw busy(); return "ok"; }, { baseMs: 1 });
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("throws other errors at once and gives up on BUSY after the attempts", async () => {
    let n = 0;
    await expect(lockedWrite(async () => { n++; throw new Error("constraint"); }, { baseMs: 1 })).rejects.toThrow("constraint");
    expect(n).toBe(1);
    n = 0;
    await expect(lockedWrite(async () => { n++; throw busy(); }, { attempts: 4, baseMs: 1 })).rejects.toThrow(/Failed query/);
    expect(n).toBe(4);
  });
});
