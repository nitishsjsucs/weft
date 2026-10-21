// Scripted provider (harness 11.5, SPEC 9.1) on Node: scripted-core.ts over scenarios/<name>.json in `scriptsDir`, or
// over `source` when the caller passes one (the durable platform's bundled fixtures read no file).
import type { ModelProvider } from "@weft/contracts";
import { scriptedProviderFrom, type ScriptedProviderOptions } from "./scripted-core";
import { dirScriptSource } from "./scripts-dir";

export {
  applyTemplates, lookup, parseContext, SCRIPTED_LABEL, ScriptExpectationError, scriptedProviderFrom,
  type Script, type ScriptedProviderOptions, type ScriptOutput, type ScriptStep,
} from "./scripted-core";

export function scriptedProvider(opts: ScriptedProviderOptions): ModelProvider {
  const source = opts.source ?? dirScriptSource(opts.scriptsDir ?? "");
  return scriptedProviderFrom({ ...opts, source });
}
