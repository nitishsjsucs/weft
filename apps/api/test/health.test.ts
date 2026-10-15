// Contract test for GET /v1/health (owner: t3-governance) and the scaffold's 501 and _tag conventions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_STATUS, Health, ROUTES } from "@weft/contracts";
import { createTestWeft, type TestWeft } from "../src/testing";

let weft: TestWeft;
beforeAll(async () => { weft = await createTestWeft(); });
afterAll(async () => { await weft.close(); });

describe("GET /v1/health", () => {
  it("answers with the provider badge and the frozen clock", async () => {
    const res = await weft.app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = Health.parse(await res.json());
    expect(body.ok).toBe(true);
    expect(body.clock).toEqual({ now: "2026-10-26T15:30:00.000Z", rate: 0 });
    expect(body.provider.live).toBe(false);
  });
  it("rejects a Host outside the allowlist", async () => {
    const res = await weft.app.request("http://evil.example/v1/health");
    expect(res.status).toBe(403);
    expect((await res.json())._tag).toBe("Forbidden");
  });
  it("accepts the web and api ports on 127.0.0.1 and localhost", async () => {
    for (const host of ["127.0.0.1:4070", "localhost:3070"]) {
      const res = await weft.app.request("/v1/health", { headers: { host } });
      expect(res.status).toBe(200);
    }
  });
});

describe("route table", () => {
  it("every route answers (501 until its owner lands) and never 404", async () => {
    for (const r of ROUTES) {
      if (r.path === "/v1/health") continue;
      const path = r.path.replace(/:[A-Za-z]+/g, "x_0001");
      const res = await weft.app.request(path, { method: r.method, headers: weft.uiHeaders("usr_dana") });
      expect(res.status, `${r.method} ${r.path}`).not.toBe(404);
      const body = await res.json();
      const answered = res.status < 400 ? body !== null && typeof body === "object" : Object.keys(ERROR_STATUS).includes(body._tag);
      expect(answered, `${r.method} ${r.path}`).toBe(true);
    }
  });
  it("unknown paths give a NotFound _tag", async () => {
    const res = await weft.app.request("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ _tag: "NotFound" });
  });
});
