// Strict function-tool schemas (harness 5.2, 4.6). zod 4 z.toJSONSchema, then: additionalProperties false on every
// object, every property required, optional fields as ["T","null"] unions, no numeric or length bounds, keys sorted.
import { z, type ZodType } from "zod";

type Json = Record<string, unknown>;
const DROP = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
  "minItems", "maxItems", "minProperties", "maxProperties", "format", "pattern", "default", "uniqueItems", "contentEncoding"]);

/** The raw JSON schema of the input side of a zod type (before strict rewriting). */
export function rawJsonSchema(schema: ZodType): Json {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
}

function nullable(s: Json): Json {
  if (Array.isArray(s.anyOf)) {
    const has = (s.anyOf as Json[]).some((x) => x.type === "null");
    return has ? s : { ...s, anyOf: [...(s.anyOf as Json[]), { type: "null" }] };
  }
  if (typeof s.type === "string") {
    const out: Json = { ...s, type: s.type === "null" ? "null" : [s.type, "null"] };
    if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(null)) out.enum = [...(s.enum as unknown[]), null];
    return out;
  }
  if (Array.isArray(s.type)) return (s.type as string[]).includes("null") ? s : { ...s, type: [...(s.type as string[]), "null"] };
  return { anyOf: [s, { type: "null" }] };
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (!node || typeof node !== "object") return node;
  const s = node as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k)) continue;
    if (k === "properties" || k === "required" || k === "additionalProperties") continue;
    out[k] = rewrite(v);
  }
  const isObject = s.type === "object" || (s.properties !== undefined && typeof s.properties === "object");
  if (isObject) {
    const props = (s.properties ?? {}) as Record<string, Json>;
    const req = new Set((s.required as string[] | undefined) ?? []);
    const np: Json = {};
    for (const key of Object.keys(props)) {
      const child = rewrite(props[key]) as Json;
      np[key] = req.has(key) ? child : nullable(child);
    }
    out.type = "object";
    out.properties = np;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function sortKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (!node || typeof node !== "object") return node;
  const o = node as Json;
  const out: Json = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
}

export function toStrictJsonSchema(schema: ZodType): Record<string, unknown> {
  const raw = rawJsonSchema(schema);
  const strict = rewrite(raw) as Json;
  if (strict.type !== "object") throw new Error("toStrictJsonSchema: tool inputs must be objects");
  return sortKeys(strict) as Record<string, unknown>;
}

/** Luna sends null for omitted optional fields; the executor maps null to undefined recursively before Zod. */
export function nullToUndefined(v: unknown): unknown {
  if (v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => (x === null ? x : nullToUndefined(x)));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const m = nullToUndefined(x);
      if (m !== undefined) out[k] = m;
    }
    return out;
  }
  return v;
}

/** Validates a strict schema by the rules above; returns the list of problems (empty when valid). */
export function strictSchemaProblems(schema: unknown, path = "$"): string[] {
  const out: string[] = [];
  if (Array.isArray(schema)) { schema.forEach((x, i) => out.push(...strictSchemaProblems(x, `${path}[${i}]`))); return out; }
  if (!schema || typeof schema !== "object") return out;
  const s = schema as Json;
  for (const k of Object.keys(s)) if (DROP.has(k)) out.push(`${path}: has ${k}`);
  const keys = Object.keys(s);
  if (keys.join(",") !== [...keys].sort().join(",")) out.push(`${path}: keys not sorted`);
  if (s.type === "object") {
    if (s.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const props = Object.keys((s.properties ?? {}) as Json);
    const req = (s.required as string[] | undefined) ?? [];
    if (props.length !== req.length || props.some((p) => !req.includes(p))) out.push(`${path}: every property must be required`);
  }
  for (const [k, v] of Object.entries(s)) if (typeof v === "object") out.push(...strictSchemaProblems(v, `${path}.${k}`));
  return out;
}

/**
 * A sample input from the raw JSON schema: required fields get a type-shaped value, optional fields get null
 * (the all-null-optionals test). Patterns of the form ^prefix_ produce `${prefix}0001`.
 */
export function sampleFromSchema(node: unknown, optional = false): unknown {
  if (optional) return null;
  if (!node || typeof node !== "object") return null;
  const s = node as Json;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return (s.enum as unknown[])[0];
  if (Array.isArray(s.anyOf)) return sampleFromSchema((s.anyOf as Json[]).find((x) => x.type !== "null") ?? {});
  if (Array.isArray(s.oneOf)) return sampleFromSchema((s.oneOf as Json[])[0]);
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== "null") : s.type;
  switch (type) {
    case "object": {
      const props = (s.properties ?? {}) as Record<string, Json>;
      const req = new Set((s.required as string[] | undefined) ?? []);
      const o: Json = {};
      for (const [k, v] of Object.entries(props)) o[k] = sampleFromSchema(v, !req.has(k));
      return o;
    }
    case "array": return s.minItems ? [sampleFromSchema(s.items)] : [];
    case "integer": case "number": return typeof s.minimum === "number" ? s.minimum : 1;
    case "boolean": return false;
    case "string": {
      const m = typeof s.pattern === "string" ? /^\^([a-z]{2,5}_)/.exec(s.pattern) : null;
      if (m) return `${m[1]}0001`;
      const min = typeof s.minLength === "number" ? s.minLength : 1;
      return "x".repeat(Math.max(1, min));
    }
    default: return null;
  }
}
