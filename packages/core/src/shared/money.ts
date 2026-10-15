export { formatCents, money } from "@weft/contracts";

/** Parses "1,899.00" or "$1899" into integer cents without floats. */
export function parseDollarsToCents(s: string): number {
  const m = /^-?\$?([\d,]+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`parseDollarsToCents: ${s}`);
  const whole = Number(m[1]!.replace(/,/g, ""));
  const frac = Number((m[2] ?? "0").padEnd(2, "0"));
  const cents = whole * 100 + frac;
  return s.trim().startsWith("-") ? -cents : cents;
}

export function sumCents(values: readonly number[]): number {
  let t = 0;
  for (const v of values) { if (!Number.isInteger(v)) throw new Error(`sumCents: not an integer ${v}`); t += v; }
  return t;
}
