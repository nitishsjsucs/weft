// One registry, four surfaces (harness 5.1 to 5.3). Registry name namespace.action, wire name namespace__action.
import type { AgentKind, RegistryView, ToolSpec } from "@weft/contracts";
import type { WeftCommand } from "@weft/core";
import { toStrictJsonSchema } from "./strict-schema";

export const MAX_TOOLS = 16;
export const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function wireName(name: string): string { return name.replace(".", "__"); }

export interface Registry extends RegistryView {
  def(nameOrWire: string): WeftCommand | undefined;
  all(): WeftCommand[];
  schema(nameOrWire: string): Record<string, unknown>;
}

export function tierFor(def: Pick<WeftCommand, "tiers" | "access">, agentKind: AgentKind) {
  if (def.access !== "all") return "unavailable" as const;
  return agentKind === "main" ? def.tiers.main : def.tiers.task;
}

export function createRegistry(commands: WeftCommand[]): Registry {
  const byName = new Map<string, WeftCommand>();
  const byWire = new Map<string, WeftCommand>();
  const schemas = new Map<string, Record<string, unknown>>();
  for (const c of commands) {
    if (byName.has(c.name)) throw new Error(`registry: duplicate command ${c.name}`);
    const w = wireName(c.name);
    if (!WIRE_NAME.test(w)) throw new Error(`registry: bad wire name ${w}`);
    byName.set(c.name, c);
    byWire.set(w, c);
  }
  const def = (n: string) => byName.get(n) ?? byWire.get(n);
  const schema = (n: string) => {
    const d = def(n);
    if (!d) throw new Error(`registry: unknown command ${n}`);
    let s = schemas.get(d.name);
    if (!s) { s = toStrictJsonSchema(d.input); schemas.set(d.name, s); }
    return s;
  };
  return {
    def,
    all: () => [...byName.values()],
    schema,
    get(n) {
      const d = def(n);
      if (!d) return undefined;
      return Object.freeze({ name: d.name, description: d.description, effect: d.effect, tiers: d.tiers, mcp: d.mcp });
    },
    wireName,
    toolSpecs({ agentKind, allowlist }) {
      const specs: ToolSpec[] = [];
      for (const n of new Set(allowlist)) {
        const d = def(n);
        if (!d) throw new Error(`registry: allowlist names unknown command ${n}`);
        if (tierFor(d, agentKind) === "unavailable") throw new Error(`registry: ${d.name} is unavailable to ${agentKind}`);
        specs.push(Object.freeze({ name: wireName(d.name), description: d.description, parameters: schema(d.name) }));
      }
      if (specs.length > MAX_TOOLS) throw new Error(`registry: ${specs.length} tools exceeds the cap of ${MAX_TOOLS}`);
      specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return Object.freeze(specs) as ToolSpec[];
    },
  };
}
