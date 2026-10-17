// The redactor's provider key shapes: a key nothing registers (pasted into chat, a second org key, one inside vendor
// text) is still redacted, the shapes come from the telemetry contract's SECRET_PATTERNS, and ordinary words with an
// "sk-" inside them ("task-...", "desk-...") are left alone.
import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS } from "@weft/contracts";
import { PROVIDER_KEY_PATTERNS, REDACTED, Redactor } from "../src/vault/redact";

const OPENAI = "sk-proj-FAKEfake0000000000000000000000abcd";
const ANTHROPIC = "sk-ant-api03-FAKEfake000000000000000000wxyz";
const BARE = "sk-FAKEfake00000000000000000000000000mnop";

describe("provider key shapes", () => {
  it("redacts unregistered OpenAI, Anthropic and bare sk- keys", () => {
    const r = new Redactor();
    const out = r.redact(`chat: here is our new key ${OPENAI}, the other org uses ${ANTHROPIC}; vendor note "${BARE}".`);
    for (const k of [OPENAI, ANTHROPIC, BARE]) expect(out.includes(k)).toBe(false);
    expect(out.split(REDACTED).length - 1).toBe(3);
  });
  it("leaves words that only contain sk- alone", () => {
    const r = new Redactor();
    const s = "task-0000000000000000000000000 and desk-aaaaaaaaaaaaaaaaaaaaaaaa stay as written";
    expect(r.redact(s)).toBe(s);
  });
  it("hasSecret flags a key shape, so memory refuses it as a secret", () => {
    const r = new Redactor();
    expect(r.hasSecret(`note ${OPENAI}`)).toBe(true);
    expect(r.hasSecret("note with no key")).toBe(false);
  });
  it("derives every sk- shape from SECRET_PATTERNS", () => {
    const sk = SECRET_PATTERNS.filter((re) => re.source.startsWith("sk-"));
    expect(sk.length).toBeGreaterThan(0);
    expect(PROVIDER_KEY_PATTERNS.map((re) => re.source)).toEqual(sk.map((re) => `(?<![A-Za-z0-9])${re.source}`));
  });
  it("deep values are redacted too", () => {
    expect(new Redactor().value({ a: [`x ${ANTHROPIC}`] })).toEqual({ a: [`x ${REDACTED}`] });
  });
});
