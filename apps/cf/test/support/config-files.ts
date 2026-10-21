// Paths and the wrangler configs as the tests read them (no wrangler import, so the unit suite stays light).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../../../scripts/cf/lib/jsonc";

export { parseJsonc };
export const CF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO = resolve(CF_DIR, "../..");
export const readConfig = (name: "core" | "front"): Record<string, unknown> => parseJsonc(readFileSync(join(CF_DIR, `wrangler.${name}.jsonc`), "utf8"));
