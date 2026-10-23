// Provider selection on Node (harness 11.1, SPEC 9.1): factory-core.ts with Node's ports, so a secret comes from the
// environment or the file named by WEFT_SECRETS_FILE, and scripts from scenarios/ (or WEFT_SCRIPTS_DIR). A caller may
// pass `scriptSource` and `envOnlySecrets` (the durable platform does), and then no file is read.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelProvider } from "@weft/contracts";
import { envSecret } from "../secrets-core";
import { loadSecret } from "../secrets";
import { createProviderFor, createProviderWith, type CreateProviderOptions, type ProviderPorts } from "./factory-core";
import { dirScriptSource } from "./scripts-dir";

export {
  AIG_BYOK_ENV, asModelProvider, createProviderFor, createProviderWith, DEFAULT_MODEL, EFFORT_OVERRIDES, effortOverrideFromEnv, isTestEnv,
  localConfigFromEnv, openaiSettingsFromEnv, PROVIDER_CHOICES, ProviderError, WORKERS_AI_TOKEN_ENV,
  type CreateProviderOptions, type ProviderChoice, type ProviderPorts,
} from "./factory-core";

/**
 * The repo root, resolved when Node first asks for a repo path. import.meta.url is null in workerd, so a path built
 * while this module evaluates would throw before the world exists if a Worker bundle ever reached this file.
 */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/** <repo>/scenarios, the deterministic templates' default directory. */
export function defaultScriptsDir(): string {
  return join(repoRoot(), "scenarios");
}

/** Node's ports: the secrets file unless `envOnlySecrets`, the scenarios directory unless `scriptSource`. */
export function nodeProviderPorts(opts: Pick<CreateProviderOptions, "env" | "envOnlySecrets" | "scriptSource">): ProviderPorts {
  return {
    secret: (name) => (opts.envOnlySecrets ? envSecret(name, opts.env) : loadSecret(name, opts.env)),
    scripts: () => opts.scriptSource ?? dirScriptSource(opts.env.WEFT_SCRIPTS_DIR ?? defaultScriptsDir()),
  };
}

export function createProvider(opts: CreateProviderOptions): ModelProvider {
  return createProviderWith(opts, nodeProviderPorts(opts));
}

/** One named provider with Node's ports (the hosted pool on Node, evals' side by side). */
export function createNamedProvider(which: string, opts: CreateProviderOptions): ModelProvider {
  return createProviderFor(which, opts, nodeProviderPorts(opts));
}
