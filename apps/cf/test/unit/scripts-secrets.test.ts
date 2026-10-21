// with-cf.sh and put-secret.sh (design 9.3): secrets files are parsed with awk, never sourced; a value reaches one
// child command's environment or stdin only and is never printed. Plus the TS helpers over the same awk parser.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureEnvValue, readEnvValue, WORKER_SECRETS, writeEnvValue } from "../../../../scripts/cf/lib/env-file";
import { REPO } from "../support/config-files";

const dir = mkdtempSync(join(tmpdir(), "weft-cf-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const WITH_CF = join(REPO, "scripts/cf/with-cf.sh");
const PUT_SECRET = join(REPO, "scripts/cf/put-secret.sh");
const TOKEN = "tok_" + "z".repeat(36);

function tokenFile(lines: string[]): string {
  const f = join(dir, `t${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
  return f;
}
const cleanEnv = () => { const e: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir }; return e; };

describe("with-cf.sh", () => {
  it("parses the token line with a space after =, quotes and CRLF, and gives it to one command only", () => {
    for (const line of [`CF_SETUP_TOKEN= ${TOKEN}`, `CF_SETUP_TOKEN="${TOKEN}"`, `export CF_SETUP_TOKEN=${TOKEN}\r`, `  CF_SETUP_TOKEN = ${TOKEN}  `]) {
      const f = tokenFile(["# a comment", "OTHER=1", line]);
      const r = spawnSync(WITH_CF, ["sh", "-c", `test "$CLOUDFLARE_API_TOKEN" = "${TOKEN}" && test "$CLOUDFLARE_ACCOUNT_ID" = acct123 && echo matched`], {
        env: { ...cleanEnv(), WEFT_CF_TOKEN_FILE: f, CLOUDFLARE_ACCOUNT_ID: "acct123" }, encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("matched");
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    }
  });

  it("reads the account id from the file when the environment has none", () => {
    const f = tokenFile([`CF_SETUP_TOKEN=${TOKEN}`, "CF_ACCOUNT_ID=acct456"]);
    const r = spawnSync(WITH_CF, ["sh", "-c", 'echo "$CLOUDFLARE_ACCOUNT_ID"'], { env: { ...cleanEnv(), WEFT_CF_TOKEN_FILE: f }, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("acct456");
  });

  it("refuses without a token, an account id or a command, and never echoes the file", () => {
    const noToken = tokenFile(["OTHER=1"]);
    const a = spawnSync(WITH_CF, ["true"], { env: { ...cleanEnv(), WEFT_CF_TOKEN_FILE: noToken, CLOUDFLARE_ACCOUNT_ID: "x" }, encoding: "utf8" });
    expect(a.status).toBe(1);
    expect(a.stderr).toContain("CF_SETUP_TOKEN is not in the token file");
    const noAcct = tokenFile([`CF_SETUP_TOKEN=${TOKEN}`]);
    const b = spawnSync(WITH_CF, ["true"], { env: { ...cleanEnv(), WEFT_CF_TOKEN_FILE: noAcct }, encoding: "utf8" });
    expect(b.status).toBe(1);
    expect(b.stderr).not.toContain(TOKEN);
    expect(spawnSync(WITH_CF, [], { env: { ...cleanEnv(), WEFT_CF_TOKEN_FILE: noAcct }, encoding: "utf8" }).status).toBe(2);
    // The parent's environment never gains the token.
    expect(process.env.CLOUDFLARE_API_TOKEN ?? "").not.toBe(TOKEN);
  });
});

describe("put-secret.sh", () => {
  const fake = join(dir, "fake-wrangler.sh");
  writeFileSync(fake, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho "wrangler noise"\n`, { mode: 0o755 });

  it("pipes the value to wrangler secret put on stdin and prints the name only", () => {
    const f = tokenFile(["WEFT_PROXY_SECRET= abcdef0123456789abcdef0123456789"]);
    const out = execFileSync(PUT_SECRET, ["WEFT_PROXY_SECRET", f, "WEFT_PROXY_SECRET", "apps/cf/wrangler.core.jsonc"], { env: { ...cleanEnv(), WEFT_WRANGLER: fake }, encoding: "utf8" });
    expect(out.trim()).toBe("put-secret: WEFT_PROXY_SECRET");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("abcdef0123456789abcdef0123456789");
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe("secret put WEFT_PROXY_SECRET --config apps/cf/wrangler.core.jsonc");
  });

  it("refuses a lower-case name, a missing key or a missing config", () => {
    const f = tokenFile(["A_KEY=v"]);
    expect(spawnSync(PUT_SECRET, ["lower", f, "A_KEY", "c"], { env: { ...cleanEnv(), WEFT_WRANGLER: fake } }).status).toBe(2);
    const missing = spawnSync(PUT_SECRET, ["NAME", f, "NOPE", "c"], { env: { ...cleanEnv(), WEFT_WRANGLER: fake }, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("NOPE is not in the secrets file");
    expect(spawnSync(PUT_SECRET, ["NAME", f, "A_KEY"], { env: { ...cleanEnv(), WEFT_WRANGLER: fake } }).status).toBe(2);
  });
});

describe("secrets file helpers", () => {
  it("read with awk, write mode 600, replace a line, generate once", () => {
    const f = join(dir, "cf.secrets.env");
    expect(readEnvValue(f, "X_ONE")).toBeNull();
    writeEnvValue(f, "X_ONE", "first");
    writeEnvValue(f, "X_TWO", "second");
    writeEnvValue(f, "X_ONE", "again");
    expect(readFileSync(f, "utf8")).toBe("X_TWO=second\nX_ONE=again\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readEnvValue(f, "X_ONE")).toBe("again");
    let made = 0;
    const a = ensureEnvValue(f, "X_GEN", () => { made += 1; return "g1"; });
    const b = ensureEnvValue(f, "X_GEN", () => { made += 1; return "g2"; });
    expect([a, b, made]).toEqual([{ value: "g1", created: true }, { value: "g1", created: false }, 1]);
    expect(() => writeEnvValue(f, "X_BAD", "two\nlines")).toThrow();
    expect(() => readEnvValue(f, "lower")).toThrow();
  });

  it("lists every Worker secret of design 9.3 once per Worker", () => {
    const core = WORKER_SECRETS.filter((s) => s.workers.includes("weft-core")).map((s) => s.name).sort();
    const front = WORKER_SECRETS.filter((s) => s.workers.includes("weft")).map((s) => s.name).sort();
    expect(core).toEqual(["CF_AIG_TOKEN", "OPENAI_API_KEY", "WEFT_AIG_GATEWAY", "WEFT_CTX_SECRET", "WEFT_PROXY_SECRET", "WEFT_SESSION_SECRET", "WEFT_VAULT_KEY"]);
    expect(front).toEqual(["TURNSTILE_SECRET", "WEFT_ADMIN_TOKEN", "WEFT_CTX_SECRET", "WEFT_PROXY_SECRET", "WEFT_SESSION_SECRET", "WEFT_SMOKE_TOKEN"]);
    expect(WORKER_SECRETS.find((s) => s.name === "WEFT_VAULT_KEY")!.make!()).toMatch(/^[0-9a-f]{64}$/);
  });
});
