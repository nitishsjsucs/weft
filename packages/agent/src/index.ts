// The brain (SPEC 9.1, 9.5 to 9.10, harness 4, 7, 10, 11). Owner: t4-agent.
// Imports only @weft/contracts, @weft/grounding, its own run store tables and its providers (tests/boundaries.test.ts).
// The Node entry: shared.ts plus the parts that read files (the JSONL spend ledger, WEFT_SECRETS_FILE, scenarios/).
// A Worker bundle resolves portable.ts instead (package.json `workerd` condition), with the same export names.
import type { ScriptSource } from "./script-source";
import { defaultScriptsDir } from "./providers/factory";
import { dirScriptSource } from "./providers/scripts-dir";
import { createAgentRuntime as createRuntime, type CreateAgentRuntimeOptions, type WeftAgentRuntime } from "./runtime";

export * from "./shared";
export { createFileSpendStore, createSpendLedger, SpendLockTimeout, type FileSpendStoreOptions, type SpendLedgerOptions, type WeftSpendLedger } from "./spend";
export type { SpendLedgerOptions as CreateSpendLedgerOptions } from "./spend";
export { createNamedProvider, createProvider, defaultScriptsDir, nodeProviderPorts } from "./providers/factory";
export { scriptedProvider } from "./providers/scripted";
export { dirScriptSource } from "./providers/scripts-dir";
export { loadSecret } from "./secrets";

/** Node: the deterministic templates read scenarios/ (or WEFT_SCRIPTS_DIR) unless the caller passes a script source. */
export function createAgentRuntime(opts: CreateAgentRuntimeOptions): WeftAgentRuntime {
  const env = opts.env ?? process.env;
  const scriptSource: ScriptSource = opts.scriptSource ?? dirScriptSource(env.WEFT_SCRIPTS_DIR ?? defaultScriptsDir());
  return createRuntime({ ...opts, scriptSource });
}
