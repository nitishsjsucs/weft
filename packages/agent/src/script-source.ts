// Where the scripted provider and the deterministic templates read scenarios/<name>.json (harness 11.5). On Node a
// directory (providers/scripts-dir.ts); on the durable platform the bundled fixtures (FixtureSource, the generated
// module apps/cf/generated/fixtures.ts), so a hosted world reads no file. Portable: no node: imports.
import type { FixtureSource } from "../../contracts/src/ext/cf-platform";
import type { Script } from "./providers/scripted-core";

export interface ScriptSource {
  /** The script, or null when there is none by that name. */
  get(name: string): Script | null;
  /** Every script name, sorted. */
  names(): string[];
}

/** Inline scripts by name (tests, and the scripts that win over files). */
export function inlineScriptSource(scripts: Record<string, Script>): ScriptSource {
  return {
    get: (name) => (Object.hasOwn(scripts, name) ? scripts[name]! : null),
    names: () => Object.keys(scripts).sort(),
  };
}

/** Scripts from bundled fixtures: `<dir>/<name>.json` (repo-relative paths with "/"), parsed once each. */
export function fixtureScriptSource(fixtures: Pick<FixtureSource, "text" | "list">, dir = "scenarios"): ScriptSource {
  const cache = new Map<string, Script | null>();
  const base = dir.replace(/\/+$/, "");
  return {
    get(name) {
      if (cache.has(name)) return cache.get(name)!;
      const text = /^[A-Za-z0-9_.-]+$/.test(name) ? fixtures.text(`${base}/${name}.json`) : null;
      const s = text === null ? null : (JSON.parse(text) as Script);
      cache.set(name, s);
      return s;
    },
    names() {
      return fixtures.list(base).map((p) => p.slice(p.lastIndexOf("/") + 1)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    },
  };
}

let registered: ScriptSource | null = null;

/** The script source a host registers once (the Worker registers its bundled fixtures); null clears it. */
export function setScriptSource(source: ScriptSource | null): void {
  registered = source;
}

export function registeredScriptSource(): ScriptSource | null {
  return registered;
}

/** The registered source, or a clear error naming what to pass: the portable entry never reads a directory. */
export function requireScriptSource(what: string): ScriptSource {
  if (!registered) throw new Error(`${what}: no script source; pass scriptSource or call setScriptSource(fixtureScriptSource(fixtures)) once`);
  return registered;
}
