// Source and output of each code.run in the run workspace (harness 3.5): runs/<run id>/code/<step>.js and
// <step>.out.json under the company folder. The output is redacted before it is written. A failed write is logged
// and never fails the run; files of a run that timed out stay as a debugging trail.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExecContext } from "@weft/contracts";
import type { Engine } from "../engine";
import { runDir } from "../workspace";

export interface CodeFiles { source: string | null; writeOutput(out: unknown): string | null }

export function codeFiles(e: Engine, ctx: ExecContext, source: string): CodeFiles {
  if (!ctx.run) return { source: null, writeOutput: () => null };
  const dir = join(runDir(e.dataDir, ctx.companyId, ctx.run.id), "code");
  const base = join(dir, String(ctx.run.stepN));
  const write = (file: string, text: string): string | null => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
      return relative(e.dataDir, file);
    } catch (err) {
      e.log(`code.run: could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  return {
    source: write(`${base}.js`, source),
    writeOutput: (out) => write(`${base}.out.json`, `${JSON.stringify(e.redactor.value(out), null, 2)}\n`),
  };
}
