// Route classes, the [id] shell mapping, the generated fixtures module and the two wrangler configs against design
// 9.4 with the section 0 overrides (pool 2, no cumulative live cap, visitor and IP caps follow the day cap).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTED_RATE_LIMITS } from "../../src/shared/contracts";
import { isModelAdmission, isUpload } from "../../src/shared/routes";
import { shellPath } from "../../src/front/assets";
import { fixtureSource } from "../../src/core/fixtures";
import { FIXTURE_COUNT, FIXTURE_FILES } from "../../generated/fixtures";
import { collectFixtures, renderFixtures } from "../../../../scripts/cf/fixtures";
import { CF_DIR, parseJsonc, readConfig } from "../support/config-files";

describe("route classes", () => {
  it("names the direct agent admissions (kill switch and RL_RUN)", () => {
    for (const p of ["/v1/agent/runs", "/v1/portal/agent/runs", "/v1/routines/draft", "/v1/routines/rt_x/trigger", "/v1/sim/chat/inbound", "/v1/sim/email/inbound"]) expect(isModelAdmission("POST", p)).toBe(true);
    expect(isModelAdmission("GET", "/v1/agent/runs")).toBe(false);
    expect(isModelAdmission("POST", "/v1/agent/runs/run_1/cancel")).toBe(false);
    expect(isModelAdmission("POST", "/v1/sim/notices/deliver")).toBe(false);
  });

  it("treats multipart bodies as uploads", () => {
    expect(isUpload("POST", "multipart/form-data; boundary=x")).toBe(true);
    expect(isUpload("POST", "application/json")).toBe(false);
    expect(isUpload("GET", "multipart/form-data")).toBe(false);
  });

  it("maps the five dynamic sections onto their `_` shells", () => {
    expect(shellPath("/app/people/wrk_0026/")).toBe("/app/people/_/");
    expect(shellPath("/app/people/wrk_0026")).toBe("/app/people/_/");
    expect(shellPath("/app/payroll/pr_1/index.txt")).toBe("/app/payroll/_/index.txt");
    for (const s of ["runs", "routines", "offboarding"]) expect(shellPath(`/app/${s}/x1/`)).toBe(`/app/${s}/_/`);
    expect(shellPath("/app/people/_/")).toBeNull();
    expect(shellPath("/app/people/")).toBeNull();
    expect(shellPath("/app/settings/x/")).toBeNull();
  });
});

describe("fixtures module", () => {
  it("is fresh (pnpm cf:fixtures && git diff --exit-code)", () => {
    const text = readFileSync(join(CF_DIR, "generated/fixtures.ts"), "utf8");
    expect(text).toBe(renderFixtures(collectFixtures()));
  });

  it("holds the migrations, notices and scenarios a Worker cannot read from disk", () => {
    const f = fixtureSource(FIXTURE_FILES);
    expect(FIXTURE_COUNT).toBe(Object.keys(FIXTURE_FILES).length);
    expect(f.list("packages/db/drizzle").filter((p) => p.endsWith(".sql"))).toContain("packages/db/drizzle/0008_hosted.sql");
    expect(f.text("packages/db/drizzle/meta/_journal.json")).toContain("0008_hosted");
    expect(f.list("packages/sim/fixtures/notices")).toContain("packages/sim/fixtures/notices/ca_de2088_rate_change.txt");
    expect(f.list("packages/sim/src/notices/mailed").length).toBeGreaterThanOrEqual(12);
    expect(f.list("scenarios").length).toBeGreaterThanOrEqual(50);
    expect(f.list("packages/db")).toEqual([]);
    expect(f.text("nope")).toBeNull();
    expect(new TextDecoder().decode(f.bytes("packages/sim/fixtures/notices/ny_missing_filing.txt")!)).toBe(f.text("packages/sim/fixtures/notices/ny_missing_filing.txt"));
  });
});

describe("wrangler configs (design 9.4, section 0)", () => {
  const core = readConfig("core");
  const front = readConfig("front");
  const vars = core.vars as Record<string, string>;

  it("keeps weft-core off the public internet and binds what the design lists", () => {
    expect(core).toMatchObject({ name: "weft-core", main: "src/core/index.ts", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false });
    expect((core.durable_objects as { bindings: { name: string; class_name: string }[] }).bindings.map((b) => `${b.name}=${b.class_name}`)).toEqual(["COMPANY=CompanyDO", "LOBBY=LobbyDO", "SPEND=SpendDO"]);
    expect(core.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["CompanyDO", "LobbyDO", "SpendDO"] }]);
    expect(core.workflows).toEqual([{ name: "weft-reseed", binding: "RESEED", class_name: "ReseedWorkflow" }]);
    expect((core.triggers as { crons: string[] }).crons).toEqual(["*/15 * * * *"]);
    const q = core.queues as { producers: { binding: string; queue: string }[]; consumers: Record<string, unknown>[] };
    expect(q.producers.map((p) => p.queue)).toEqual(["weft-jobs", "weft-render"]);
    expect(q.consumers.find((c) => c.queue === "weft-render")).toMatchObject({ max_batch_size: 1, max_concurrency: 1, retry_delay: 20, dead_letter_queue: "weft-dlq" });
    expect(core.ratelimits).toEqual([{ name: "RL_RUN", namespace_id: "4103", simple: HOSTED_RATE_LIMITS.RL_RUN }]);
    expect(core.rules).toEqual([{ type: "Text", globs: ["**/*.sql", "**/*.txt"], fallthrough: true }, { type: "Data", globs: ["**/*.gz"], fallthrough: true }]);
    expect(core).not.toHaveProperty("analytics_engine_datasets");
  });

  it("applies the settings Nitish chose on 2026-10-20", () => {
    expect(vars.WEFT_POOL_SIZE).toBe("2");
    expect(vars.WEFT_LIVE_USD_CAP).toBe("off");
    expect(vars.WEFT_RUN_USD_CAP).toBe("0.10");
    expect(vars.WEFT_DAY_USD_CAP).toBe("2.00");
    // Visitor and IP-hash caps equal the day cap: no var pins them below it.
    expect(vars).not.toHaveProperty("WEFT_VISITOR_DAY_USD_CAP");
    expect(vars).not.toHaveProperty("WEFT_IP_DAY_USD_CAP");
    expect(vars).toMatchObject({ WEFT_RUNTIME: "cloudflare", WEFT_LLM: "openai", WEFT_MODEL: "gpt-5.6-luna", WEFT_BACKGROUND_LLM: "1", WEFT_CLOCK_RATE: "0", WEFT_SANDBOX: "off", WEFT_REQUIRE_VAULT_KEY: "1", WEFT_SEMANTIC_RECALL: "0" });
  });

  it("serves the web from assets and runs the front Worker first only for the API and MCP", () => {
    expect(front).toMatchObject({ name: "weft", main: "src/front/index.ts", workers_dev: true, preview_urls: false });
    expect(front.assets).toEqual({ directory: "../web/out", binding: "ASSETS", html_handling: "force-trailing-slash", not_found_handling: "404-page", run_worker_first: ["/api/*", "/mcp", "/mcp/*"] });
    expect((front.durable_objects as { bindings: { script_name: string }[] }).bindings.every((b) => b.script_name === "weft-core")).toBe(true);
    expect(front.services).toEqual([{ binding: "CORE", service: "weft-core", entrypoint: "HostedExtras" }]);
    const rl = Object.fromEntries((front.ratelimits as { name: string; simple: unknown }[]).map((r) => [r.name, r.simple]));
    expect(rl).toEqual({ RL_API: HOSTED_RATE_LIMITS.RL_API, RL_MUTATE: HOSTED_RATE_LIMITS.RL_MUTATE, RL_MCP: HOSTED_RATE_LIMITS.RL_MCP });
    expect((front.vars as Record<string, string>).WEFT_PUBLIC_ORIGIN).toBe("https://weft.nitish-ratakonda.workers.dev");
  });

  it("commits no secret and no account id", () => {
    for (const name of ["core", "front"]) {
      const text = readFileSync(join(CF_DIR, `wrangler.${name}.jsonc`), "utf8");
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}|dc93c3bc8aa4f9e09a0d7e7354a80873|SECRET"\s*:|TOKEN"\s*:|API_KEY"\s*:/);
    }
    expect(parseJsonc('{ "a": "x // not a comment", /* c */ "b": [1, 2,], }')).toEqual({ a: "x // not a comment", b: [1, 2] });
  });
});
