// Structured memory citations (wave 4 round 2, R3; harness 4.3 amendment). A routine summary is built from result
// summaries, never from the model's prose, so a run that follows a remembered procedure can only say so through a
// field the executor checks: `procedure_ref` on notices.escalate. When the registry is built (index.ts), the executor
// wraps each command that takes the field and, before it runs, checks that the reference names an existing
// knowledge/procedures/ note that is not tainted. A run can never cite a note that is missing, outside the
// procedures folder, or written from untrusted content. Names and schemas are unchanged; only run (and a preview,
// when the command has one) gains the check.
import { Refused } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import type { LocalMemory } from "./store";
import { MemoryError, normalizeMemoryPath } from "./store";

export const PROCEDURES_PREFIX = "knowledge/procedures/";

/** The core commands that take a `procedure_ref` (only notices.escalate today). */
export const PROCEDURE_REF_COMMANDS = ["notices.escalate"] as const;

const HINT = { hint: "procedure_ref must be a knowledge/procedures/ path from <recall> or memory.search; leave it null when no procedure applies", example: { notice_id: "ntc_0001", reason_code: "missing_filing", procedure_ref: null } };

/**
 * Checks one procedure reference against the memory repo at its working tree (which every executor write commits).
 * Throws a refusal the pipeline returns to the model: UNKNOWN_REFERENCE for a path that is not a procedure note,
 * NOT_PERMITTED for a tainted one. Returns the normalized path.
 */
export async function checkProcedureRef(memory: Pick<LocalMemory, "read">, ref: string): Promise<string> {
  let path: string;
  try { path = normalizeMemoryPath(ref); } catch { throw new Refused("UNKNOWN_REFERENCE", "procedure_ref is not a memory path", HINT); }
  if (path !== ref || !path.startsWith(PROCEDURES_PREFIX)) throw new Refused("UNKNOWN_REFERENCE", `procedure_ref must name a note under ${PROCEDURES_PREFIX}`, HINT);
  let doc: Awaited<ReturnType<LocalMemory["read"]>> = null;
  try { doc = await memory.read(path); } catch (e) {
    if (e instanceof MemoryError && e.code !== "NOT_PERMITTED") throw new Refused("UNKNOWN_REFERENCE", `procedure_ref ${path} could not be read`, HINT);
    doc = null;
  }
  if (!doc) throw new Refused("UNKNOWN_REFERENCE", `No procedure note ${path} in memory`, HINT);
  if (doc.frontmatter.taintedBy) throw new Refused("NOT_PERMITTED", `${path} came from untrusted content and cannot be cited`, HINT);
  return path;
}

/** The core command with its procedure_ref checked by the executor before it runs (and before a preview, if any). */
export function withProcedureRefCheck(memory: Pick<LocalMemory, "read">, def: WeftCommand): WeftCommand {
  const ref = (i: unknown): string | null => {
    const v = i && typeof i === "object" ? (i as { procedure_ref?: unknown }).procedure_ref : undefined;
    return typeof v === "string" ? v : null;
  };
  return {
    ...def,
    preview: def.preview ? async (i, ctx, deps) => { const r = ref(i); if (r) await checkProcedureRef(memory, r); return def.preview!(i, ctx, deps); } : null,
    async run(i, ctx, deps) {
      const r = ref(i);
      if (r) await checkProcedureRef(memory, r);
      return def.run(i, ctx, deps);
    },
  };
}

/** The command list with every procedure_ref command wrapped by the check; any other command is returned as is. */
export function withMemoryCitations(memory: Pick<LocalMemory, "read">, defs: WeftCommand[]): WeftCommand[] {
  const names = new Set<string>(PROCEDURE_REF_COMMANDS);
  return defs.map((d) => (names.has(d.name) ? withProcedureRefCheck(memory, d) : d));
}
