// The Worker entry of @weft/agent (package.json `workerd` condition; docs/cloudflare/design.md 6.4): shared.ts plus
// counterparts, under the same names, of the Node entry's file-backed parts. Secrets come from the environment only
// (Worker secrets and vars), scripts from the source the host registers (setScriptSource) or passes, and the JSONL
// ledger does not exist here: a world's ledger is the SpendDO adapter (bindSpendLedger). No module reachable from
// this file imports node:fs, node:os, node:child_process or node:net (test/portable.test.ts).
import type { ModelProvider } from "@weft/contracts";
import { createProviderFor, createProviderWith, type CreateProviderOptions, type ProviderPorts } from "./providers/factory-core";
import { scriptedProviderFrom, type ScriptedProviderOptions } from "./providers/scripted-core";
import { createAgentRuntime as createRuntime, type CreateAgentRuntimeOptions, type WeftAgentRuntime } from "./runtime";
import { requireScriptSource, type ScriptSource } from "./script-source";
import { envSecret, type Env } from "./secrets-core";
import type { SpendStore } from "./spend-core";

export * from "./shared";

const nodeOnly = (what: string): Error => new Error(`${what} is Node only; the durable platform passes its own (docs/cloudflare/design.md 3.3)`);

export class SpendLockTimeout extends Error {
  readonly code = "SPEND_LOCK_TIMEOUT";
}

/** The JSONL ledger: Node only. The durable platform's ledger is bindSpendLedger over SpendDO. */
export function createSpendLedger(_opts: { dir: string }): never {
  throw nodeOnly("createSpendLedger (the JSONL spend ledger)");
}
export function createFileSpendStore(_opts: { dir: string }): SpendStore {
  throw nodeOnly("createFileSpendStore");
}

/** There is no scenarios directory in a Worker; the name is kept so imports resolve. */
export const DEFAULT_SCRIPTS_DIR = "scenarios";

/** Environment-only secrets and the registered (or passed) script source. */
export function nodeProviderPorts(opts: Pick<CreateProviderOptions, "env" | "scriptSource">): ProviderPorts {
  return {
    secret: (name) => envSecret(name, opts.env),
    scripts: () => opts.scriptSource ?? requireScriptSource("createProvider"),
  };
}

export function createProvider(opts: CreateProviderOptions): ModelProvider {
  return createProviderWith({ ...opts, envOnlySecrets: true }, nodeProviderPorts(opts));
}

export function createNamedProvider(which: string, opts: CreateProviderOptions): ModelProvider {
  return createProviderFor(which, { ...opts, envOnlySecrets: true }, nodeProviderPorts(opts));
}

export function scriptedProvider(opts: ScriptedProviderOptions): ModelProvider {
  return scriptedProviderFrom({ ...opts, source: opts.source ?? requireScriptSource("scriptedProvider") });
}

export function dirScriptSource(_dir: string): ScriptSource {
  throw nodeOnly("dirScriptSource");
}

/** The environment only: a Worker has no secrets file. */
export function loadSecret(name: string, env: Env): string | null {
  return envSecret(name, env);
}

export function createAgentRuntime(opts: CreateAgentRuntimeOptions): WeftAgentRuntime {
  return createRuntime({ ...opts, scriptSource: opts.scriptSource ?? requireScriptSource("createAgentRuntime") });
}
