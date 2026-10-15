// Shared builders for t2-world commands. Read commands take response_format (concise by default), return
// readable names with short ids, and money as *_cents plus *_display (harness 5.2).
import { z } from "zod";
import { Refused, type CommandDef, type Domain, type Namespace, type RiskClass } from "@weft/contracts";
import type { CommandDeps, WeftCommand } from "../shared/deps";

export const ResponseFormat = z.enum(["concise", "detailed"]);
export type ResponseFormat = z.infer<typeof ResponseFormat>;
export const responseFormatField = { response_format: ResponseFormat.optional() };
export const isDetailed = (i: { response_format?: ResponseFormat | undefined }) => i.response_format === "detailed";

type ReadSpec<I, O> = {
  name: `${Namespace}.${string}`; summary: string; description: string; compactDescription?: string;
  input: z.ZodType<I>; domain: Domain; untrustedFields?: string[];
  run: CommandDef<I, O, CommandDeps>["run"];
};

/** An R0 read: executable on every agent surface, MCP read, sandbox read, never needs approval. */
export function readCommand<I, O>(s: ReadSpec<I, O>): WeftCommand<I, O> {
  if (s.description.length > 400) throw new Error(`${s.name}: description over 400 chars`);
  return {
    name: s.name, namespace: s.name.split(".")[0] as Namespace, summary: s.summary, description: s.description,
    compactDescription: (s.compactDescription ?? s.summary).slice(0, 200), input: s.input, domain: s.domain, needs: "view", effect: "read",
    risk: () => "R0", approval: "never", autoAllow: "never", amountCents: null, ceilingKey: null, reversible: false, lease: null,
    tiers: { main: "executable", task: "executable" }, mcp: "read", sandbox: "read", access: "all",
    untrustedFields: s.untrustedFields ?? [], afterPending: "run", errorHints: {}, preview: null, run: s.run,
  };
}

/** "0.034" to "3.4%", "0.0305" to "3.05%", exact. */
export function rateDisplay(rate: string): string {
  const [i = "0", f = ""] = rate.split(".");
  const digits = (i + f.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const whole = digits.slice(0, digits.length - (f.length > 2 ? f.length - 2 : 0)) || "0";
  const frac = f.length > 2 ? f.slice(2) : "";
  const w = whole.replace(/^0+(?=\d)/, "");
  return `${w}${frac ? `.${frac.replace(/0+$/, "")}` : ""}%`.replace(/\.%$/, "%");
}

/** Domain refusal thrown by run() or preview(): a contracts `Refused` (extra: code, hint, example) that the
 * executor maps to `{ ok: false, refusal: { code, message, hint, example } }`. Hints may carry derived values. */
export class DomainRefusal extends Refused {
  constructor(readonly code: `DOMAIN_${string}`, message: string, readonly hint: string | null = null, readonly example: unknown = null) {
    super(code, message, { hint, example });
    this.name = "DomainRefusal";
  }
}

export function notFound(kind: string, id: string): DomainRefusal {
  return new DomainRefusal("DOMAIN_NOT_FOUND", `No ${kind} ${id} in this company`, `Use an id returned by a list or search tool`, null);
}

const ptFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
/** The sim date in America/Los_Angeles (YYYY-MM-DD) for an ISO instant. */
export function ptDateOf(iso: string): string { return ptFmt.format(new Date(Date.parse(iso))); }

/** Cursor paging over rows sorted by id (SPEC 10): afterId, beforeId, limit; returns limit + 1 rows for hasMore. */
export function pageById<T extends { id: string }>(rows: readonly T[], p: { limit: number; afterId: string | null; beforeId: string | null }): T[] {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let r = sorted;
  if (p.afterId) r = r.filter((x) => x.id > p.afterId!);
  if (p.beforeId) r = r.filter((x) => x.id < p.beforeId!).slice(-(p.limit + 1));
  return r.slice(0, p.limit + 1);
}

type WriteSpec<I, O> = Omit<CommandDef<I, O, CommandDeps>, "namespace" | "compactDescription" | "sandbox" | "lease" | "errorHints" | "untrustedFields" | "afterPending" | "autoAllow" | "amountCents" | "ceilingKey" | "mcp" | "tiers" | "access">
  & Partial<Pick<CommandDef<I, O, CommandDeps>, "compactDescription" | "lease" | "errorHints" | "untrustedFields" | "afterPending" | "autoAllow" | "amountCents" | "ceilingKey" | "mcp" | "tiers" | "access">>;

/** A state-changing command. human_only and system_only get tiers "unavailable" and mcp "hidden" (SPEC 9.0). */
export function writeCommand<I, O>(s: WriteSpec<I, O>): WeftCommand<I, O> {
  if (s.description.length > 400) throw new Error(`${s.name}: description over 400 chars`);
  const restricted = s.access === "human_only" || s.access === "system_only";
  return {
    namespace: s.name.split(".")[0] as Namespace, compactDescription: (s.compactDescription ?? s.summary).slice(0, 200), sandbox: "hidden", lease: null,
    errorHints: {}, untrustedFields: [], afterPending: "run", autoAllow: "never", amountCents: null, ceilingKey: null,
    ...s,
    access: s.access ?? "all",
    tiers: restricted ? { main: "unavailable", task: "unavailable" } : s.tiers ?? { main: "executable", task: "delegated" },
    mcp: restricted ? "hidden" : s.mcp ?? "propose",
  };
}

export const riskOf = (r: RiskClass) => () => r;

/** The seq the executor will give this command's action row: it appends exactly one row, in this transaction,
 * under the write lock, after run() returns. */
export async function nextActionSeq(tx: import("@weft/db").DbTx): Promise<number> {
  const { sql } = await import("drizzle-orm");
  const rows = await tx.all<{ n: number | null }>(sql`SELECT MAX(seq) AS n FROM actions`);
  return (rows[0]?.n ?? 0) + 1;
}

/** YYYY-MM-DD minus one day. */
export function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}
