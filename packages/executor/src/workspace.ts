// Compact observations and file-system offload (harness 7.4, 6.8). Over 8,000 characters of JSON, the redacted full
// result goes to runs/<run_id>/artifacts/<step_n>-<wire>.json with a run_artifacts row; the model gets a summary,
// the row count, the first 10 rows and the artifact ref. File names are generated, never derived from model input.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { ToolOutcome } from "@weft/contracts";
import { newId, type WeftCommand } from "@weft/core";
import { execRuns, runArtifacts, type DbTx } from "@weft/db";
import type { Engine } from "./engine";
import { refusal } from "./outcome";
import { wireName } from "./registry";
import type { CallScope } from "./scope";
import { markTainted } from "./taint";

export const OBSERVATION_CAP = 8000;
export const PREVIEW_ROWS = 10;
export const MAX_PAGE = 50;

export function runDir(dataDir: string, companyId: string, runId: string): string {
  return join(dataDir, "companies", companyId, "runs", runId);
}

function rowsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) if (Array.isArray(v)) return v;
  }
  return [data];
}

export async function offloadIfLarge(e: Engine, tx: DbTx, scope: CallScope, def: WeftCommand, data: unknown, summary: string): Promise<{ data: unknown; ref: string } | null> {
  const json = JSON.stringify(data ?? null);
  if (json.length <= OBSERVATION_CAP || !scope.run) return null;
  const run = scope.run;
  const step = scope.ctx.run?.stepN ?? 0;
  const dir = join(runDir(e.dataDir, run.companyId, run.id), "artifacts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${step}-${wireName(def.name)}.json`);
  writeFileSync(file, json);   // already redacted by the caller
  const id = await newId(tx, "art_");
  const rows = rowsOf(data);
  await tx.insert(runArtifacts).values({
    id, runId: run.id, stepN: step, path: relative(e.dataDir, file), bytes: Buffer.byteLength(json), sha256: createHash("sha256").update(json).digest("hex"),
    summary, domain: def.domain, needs: def.needs, taintedBy: scope.ctx.tainted ? (scope.taintedBy ?? "external") : null,
  });
  return { ref: id, data: { summary, row_count: rows.length, preview: rows.slice(0, PREVIEW_ROWS), artifact_ref: id } };
}

/** agent.read_artifact: resolved only within the run family (this run, its parent, its children). */
export async function readArtifactInTx(e: Engine, tx: DbTx, scope: CallScope, ref: string, offset: number, limit: number): Promise<ToolOutcome> {
  const run = scope.run;
  const t = () => scope.ctx.tainted;
  if (!run) return refusal("NOT_PERMITTED", "artifacts belong to agent runs", t());
  const family = new Set<string>([run.id]);
  if (run.parentRunId) family.add(run.parentRunId);
  for (const c of await tx.select({ id: execRuns.id }).from(execRuns).where(eq(execRuns.parentRunId, run.id))) family.add(c.id);
  const [a] = await tx.select().from(runArtifacts).where(and(eq(runArtifacts.id, ref), inArray(runArtifacts.runId, [...family]))).limit(1);
  if (!a) return refusal("UNKNOWN_REFERENCE", `No artifact ${ref} in this run`, t());
  const lim = Math.max(1, Math.min(MAX_PAGE, Math.trunc(limit) || MAX_PAGE));
  const off = Math.max(0, Math.trunc(offset) || 0);
  const rows = rowsOf(JSON.parse(readFileSync(join(e.dataDir, a.path), "utf8")));
  if (a.taintedBy) {
    await markTainted(tx, run.id, `artifact:${a.id}`, scope.ctx.run?.stepN ?? 0);
    if (!scope.ctx.tainted) { scope.ctx.tainted = true; scope.taintedBy = `artifact:${a.id}`; }
  }
  const page = rows.slice(off, off + lim);
  return {
    ok: true, status: "done", resultId: a.id, data: { artifact_ref: a.id, offset: off, row_count: rows.length, rows: page, has_more: off + lim < rows.length },
    summary: `${a.summary} (rows ${off + 1} to ${off + page.length} of ${rows.length})`, actionSeq: null, artifactRef: a.id, tainted: scope.ctx.tainted, label: "synthetic",
  };
}

/** CSV with formula-injection escaping: cells starting with =, +, -, @, tab or CR get a leading single quote. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

