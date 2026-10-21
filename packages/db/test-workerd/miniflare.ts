// Starts the conformance Worker in workerd through Miniflare (plain vitest, no pool plugin: design 11.3). The Worker is
// bundled with esbuild from worker.ts, so the cases and the facade run as the same code the emulator runs.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { Outcome } from "./cases";

export const COMPATIBILITY_DATE = "2026-10-01";

/** Bundles a Worker entry for workerd: ESM, Node built-ins and cloudflare:* left to the runtime (nodejs_compat). */
export async function bundleWorker(entry: string): Promise<string> {
  const out = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2024",
    conditions: ["workerd", "worker", "import", "default"], mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"], logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
}

export interface ConformanceWorker {
  /** Runs a case in its own object; a runtime reset (or any non-JSON answer) becomes { ok: false, error }. */
  run(name: string, object?: string): Promise<Outcome>;
  after(name: string, object?: string): Promise<Outcome>;
  dispose(): Promise<void>;
}

async function outcome(res: Response): Promise<Outcome> {
  const text = await res.text();
  try { return JSON.parse(text) as Outcome; } catch {
    return { ok: false, error: text.split("\n")[0]!.replace(/^Error: /, "") };
  }
}

export async function startConformanceWorker(): Promise<ConformanceWorker> {
  const script = await bundleWorker(fileURLToPath(new URL("./worker.ts", import.meta.url)));
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CONF: { className: "Conformance", useSQLite: true } }, port: 0,
  }));
  await mf.ready;
  const call = async (kind: string, name: string, object: string) =>
    outcome(await mf.dispatchFetch(`http://conformance/${kind}/${encodeURIComponent(name)}?object=${encodeURIComponent(object)}`) as unknown as Response);
  return {
    run: (name, object = name) => call("case", name, object),
    after: (name, object = name) => call("after", name, object),
    dispose: () => mf.dispose(),
  };
}
