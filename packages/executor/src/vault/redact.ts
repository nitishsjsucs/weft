// Redaction (SPEC 9.3, harness 6.4). A plain substring loop over each secret (vault values, OPENAI_API_KEY,
// ANTHROPIC_API_KEY, WEFT_VAULT_KEY, API key plaintexts, the proxy secret) in 5 encodings, plus SSN, routing,
// account and full EIN patterns. Decrypted values live in process memory only.
export const REDACTED = "[redacted]";
const MIN_SECRET = 8;

export function encodings(value: string): string[] {
  const b = Buffer.from(value, "utf8");
  const forms = [value, b.toString("base64"), b.toString("base64url"), b.toString("hex"), encodeURIComponent(value)];
  const noPad = b.toString("base64").replace(/=+$/, "");
  forms.push(noPad, b.toString("hex").toUpperCase());
  return [...new Set(forms)].filter((f) => f.length >= MIN_SECRET);
}

const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "***-**-****"],                                       // full SSN
  [/\b\d{2}-\d{7}\b/g, "**-*******"],                                              // full EIN
  [/(\b(?:routing|aba|rtn)[^0-9\n]{0,24})\d{9}\b/gi, `$1${REDACTED}`],               // routing number in context
  [/(\b(?:account|acct)(?:[ _-]?(?:no|number|num))?[^0-9\n]{0,24})\d{6,17}\b/gi, `$1${REDACTED}`],   // account number in context
];

export class Redactor {
  private forms: string[] = [];
  private seen = new Set<string>();

  add(secret: string | undefined | null): void {
    if (!secret || secret.length < MIN_SECRET || this.seen.has(secret)) return;
    this.seen.add(secret);
    for (const f of encodings(secret)) if (!this.forms.includes(f)) this.forms.push(f);
    this.forms.sort((a, b) => b.length - a.length);   // longest first so a raw value never leaves its encoded tail
  }

  size(): number { return this.seen.size; }

  redact(text: string): string {
    let out = text;
    for (const f of this.forms) if (out.includes(f)) out = out.split(f).join(REDACTED);
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  /** True when the text carries any registered secret in any encoding. */
  hasSecret(text: string): boolean { return this.forms.some((f) => text.includes(f)); }
  /** True when the text matches the SSN, EIN, routing or account patterns. */
  hasPattern(text: string): boolean { return PATTERNS.some(([re]) => { re.lastIndex = 0; const hit = re.test(text); re.lastIndex = 0; return hit; }); }

  /** Deep redaction of a JSON-like value (strings only; keys untouched). */
  value<T>(v: T): T {
    if (typeof v === "string") return this.redact(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as T;
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = this.value(x);
      return out as T;
    }
    return v;
  }
}
