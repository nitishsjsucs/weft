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

/** The rows of an offloaded result: the value itself when it is an array, else its longest array field (the first
 * array field can be an empty list such as flags, which paged as "rows 1 to 0 of 0"), else the value as one row. */
export function rowsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    let best: unknown[] | null = null;
    for (const v of Object.values(data as Record<string, unknown>)) if (Array.isArray(v) && (!best || v.length > best.length)) best = v;
    if (best) return best;
  }
  return [data];
}

/** The total a result reports (its own numeric `total`), else the number of rows it holds. */
function totalOf(data: unknown, rows: readonly unknown[]): number {
  const t = data && typeof data === "object" && !Array.isArray(data) ? (data as { total?: unknown }).total : undefined;
  return typeof t === "number" && Number.isFinite(t) ? t : rows.length;
}

/** Top-level scalar fields of a result (total, count, limit notes, a date window): they say what the rows are. */
function scalarsOf(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = typeof v === "string" ? v.slice(0, 300) : v;
    else if (k === "start_window" && typeof v === "object" && !Array.isArray(v)) out[k] = v;
  }
  return out;
}

/** When the command stored fewer rows than it matched (a clamped limit), say so, so the two numbers never disagree silently. */
function totalNote(total: number, rowCount: number): Record<string, string> {
  return total > rowCount ? { total_note: `total counts every match (${total}); this result holds ${rowCount} rows. Narrow the original call's filters to see the rest.` } : {};
}

/**
 * One page of a stored artifact, capped to the inline budget: an `agent.read_artifact` page is never offloaded again
 * (offloadIfLarge skips that command), so rows are dropped from the end of the page until it fits, and next_offset
 * says where to continue. At least one row is always returned.
 */
export function artifactPage(ref: string, summary: string, stored: unknown, offset: number, limit: number): { data: Record<string, unknown>; summary: string } {
  const rows = rowsOf(stored);
  const lim = Math.max(1, Math.min(MAX_PAGE, Math.trunc(limit) || MAX_PAGE));
  const off = Math.max(0, Math.trunc(offset) || 0);
  const total = totalOf(stored, rows);
  let page = rows.slice(off, off + lim);
  const build = (p: unknown[]) => {
    const next = off + p.length;
    return { artifact_ref: ref, offset: off, total, row_count: rows.length, ...totalNote(total, rows.length), rows: p, returned: p.length, has_more: next < rows.length, next_offset: next < rows.length ? next : null };
  };
  let data = build(page);
  while (page.length > 1 && JSON.stringify(data).length > OBSERVATION_CAP) {
    page = page.slice(0, Math.max(1, Math.floor(page.length * 0.8)));
    data = build(page);
  }
  return { data, summary: `${summary} (rows ${page.length ? off + 1 : off} to ${off + page.length} of ${rows.length})` };
}

/** The command whose result is an artifact page: never offloaded again (artifactPage keeps it under the cap). */
export const READ_ARTIFACT = "agent.read_artifact";

export async function offloadIfLarge(e: Engine, tx: DbTx, scope: CallScope, def: WeftCommand, data: unknown, summary: string): Promise<{ data: unknown; ref: string } | null> {
  if (def.name === READ_ARTIFACT) return null;
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
  const total = totalOf(data, rows);
  return { ref: id, data: { ...scalarsOf(data), summary, total, row_count: rows.length, ...totalNote(total, rows.length), preview: rows.slice(0, PREVIEW_ROWS), artifact_ref: id } };
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
  const stored = JSON.parse(readFileSync(join(e.dataDir, a.path), "utf8")) as unknown;
  if (a.taintedBy) {
    await markTainted(tx, run.id, `artifact:${a.id}`, scope.ctx.run?.stepN ?? 0);
    if (!scope.ctx.tainted) { scope.ctx.tainted = true; scope.taintedBy = `artifact:${a.id}`; }
  }
  const page = artifactPage(a.id, a.summary, stored, offset, limit);
  return {
    ok: true, status: "done", resultId: a.id, data: page.data, summary: page.summary, actionSeq: null, artifactRef: a.id, tainted: scope.ctx.tainted, label: "synthetic",
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

