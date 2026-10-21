// Source and output of each code.run in the run workspace (harness 3.5): runs/<run id>/code/<step>.js and
// <step>.out.json under the company folder. The output is redacted before it is written. A failed write is logged
// and never fails the run; files of a run that timed out stay as a debugging trail. Bodies go through the engine's
// RunFileStore (files on Node, the run_files table on the durable platform, docs/cloudflare/design.md 4.1).
import type { ExecContext } from "@weft/contracts";
import type { Engine } from "../engine";
import { runRel } from "../hosted/run-files";

export interface CodeFiles { source: string | null; writeOutput(out: unknown): Promise<string | null> }

export async function codeFiles(e: Engine, ctx: ExecContext, source: string): Promise<CodeFiles> {
  if (!ctx.run) return { source: null, writeOutput: async () => null };
  const base = `${runRel(ctx.companyId, ctx.run.id)}/code/${ctx.run.stepN}`;
  const write = async (path: string, text: string): Promise<string | null> => {
    try {
      await e.runFiles.write(path, text);
      return path;
    } catch (err) {
      e.log(`code.run: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  return {
    source: await write(`${base}.js`, source),
    writeOutput: (out) => write(`${base}.out.json`, `${JSON.stringify(e.redactor.value(out), null, 2)}\n`),
  };
}
