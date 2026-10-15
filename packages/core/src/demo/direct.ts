// Direct command runner for tests, the seed fallback and tooling: builds an ExecContext and CommandDeps over a db
// handle and calls a command's run() without the executor pipeline (no grants, approvals, taint or action rows).
// Production calls always go through the executor.
import type { ExecContext, SimClock, Simulators } from "@weft/contracts";
import type { DbTx } from "@weft/db";
import { commands } from "../commands/index";
import type { CommandDeps, WeftCommand } from "../shared/deps";
import { idMinter } from "../shared/ids";

export function directDeps(db: DbTx, clock: SimClock, sims: Simulators, resolve?: (ref: string) => Promise<string>): CommandDeps {
  return { tx: db, sims, clock, newId: idMinter(db), resolveCredential: async (ref) => (resolve ? resolve(ref) : `sim-credential:${ref}`) };
}

export function directCtx(clock: SimClock, over: Partial<ExecContext> = {}): ExecContext {
  return {
    companyId: "cmp_larkspur", principal: { id: "agt_weft", kind: "agent", role: null }, onBehalfOf: "usr_dana", surface: "agent", agentKind: "main",
    run: null, tainted: false, routineRunId: null, approvedProposalId: null, now: clock.now(), ...over,
  };
}

export function findCommand(name: string, list: readonly WeftCommand[] = commands): WeftCommand {
  const c = list.find((x) => x.name === name);
  if (!c) throw new Error(`no command ${name}`);
  return c;
}

/** Parses input with the command's schema (null mapped to undefined first, as the executor does), then runs it. */
export async function runDirect(name: string, input: unknown, ctx: ExecContext, deps: CommandDeps) {
  const def = findCommand(name);
  const parsed = def.input.parse(nullToUndefined(input));
  return def.run(parsed, ctx, deps);
}

export function nullToUndefined(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) return v.map(nullToUndefined);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nullToUndefined(x)]));
  return v;
}

/** Values at dotted paths (`*` walks every array element or object value); used to test untrustedFields. */
export function valuesAt(data: unknown, path: string): unknown[] {
  let cur: unknown[] = [data];
  for (const seg of path.split(".")) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c === null || typeof c !== "object") continue;
      if (seg === "*") next.push(...(Array.isArray(c) ? c : Object.values(c)));
      else if (seg in (c as Record<string, unknown>)) next.push((c as Record<string, unknown>)[seg]);
    }
    cur = next;
  }
  return cur;
}

/** The declared untrusted paths that are non-empty in `data` (what makes the executor taint a run). */
export function nonEmptyUntrusted(def: Pick<WeftCommand, "untrustedFields">, data: unknown): string[] {
  return def.untrustedFields.filter((p) => valuesAt(data, p).some((v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)));
}

/** Tests only: the three demo humans, inserted only when absent (T3's governance seed owns the real rows). */
export async function ensureTestPrincipals(db: DbTx): Promise<void> {
  const { principals } = await import("@weft/db");
  const all = (level: string) => JSON.stringify({ people: level, payroll: level, tax: level, benefits: level, it: level, comms: level, company: level });
  const rows = [
    { id: "usr_dana", workerId: "wrk_0001", display: "Dana Whitfield (demo)", email: "dana.whitfield@larkspur.example", role: "admin", grantsJson: all("approve") },
    { id: "usr_theo", workerId: "wrk_0002", display: "Theo Marsh (demo)", email: "theo.marsh@larkspur.example", role: "payroll_admin", grantsJson: JSON.stringify({ people: "view", payroll: "approve", tax: "approve", benefits: "none", it: "none", comms: "view", company: "view" }) },
    { id: "usr_sam", workerId: "wrk_0025", display: "Sam Okafor (demo)", email: "sam.okafor@larkspur.example", role: "hr_manager", grantsJson: JSON.stringify({ people: "edit", payroll: "view", tax: "view", benefits: "edit", it: "edit", comms: "edit", company: "view" }) },
  ];
  for (const r of rows) await db.insert(principals).values({ ...r, companyId: "cmp_larkspur", kind: "human" }).onConflictDoNothing();
}
