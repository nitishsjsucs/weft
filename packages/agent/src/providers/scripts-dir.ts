// Scripts from a directory of <name>.json files (Node only). A name is read and parsed once per source; the names
// are listed again on every call, so a script added during a dev session is found.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptSource } from "../script-source";
import type { Script } from "./scripted-core";

export function dirScriptSource(dir: string): ScriptSource {
  const cache = new Map<string, Script | null>();
  return {
    get(name) {
      if (cache.has(name)) return cache.get(name)!;
      const file = join(dir, `${name}.json`);
      const s = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Script) : null;
      cache.set(name, s);
      return s;
    },
    names() {
      try { return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); } catch { return []; }
    },
  };
}
