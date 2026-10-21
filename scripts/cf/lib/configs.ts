// The wrangler configs in three forms (docs/cloudflare/design.md 9.4, 11.4 and 11.5):
//
// - deploy: wrangler.{core,front}.jsonc with the resource ids from apps/cf/resources.json (pnpm cf:resources), the
//   Turnstile sitekey and the AI Gateway account id filled in, written next to the originals (gitignored) so their
//   relative paths still hold.
// - local: for the Miniflare suite and pnpm cf:dev. weft-core points at the real entry or the suite's fake-engine
//   entry, the bindings Miniflare does not emulate locally (Workers AI, Vectorize, Browser Run) become service
//   bindings to a fakes worker, the origin and pool size are local, and the KV memo is short. Everything else is the
//   deploy config unchanged.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "./jsonc";
import { REPO_ROOT } from "./env-file";

export const APPS_CF = join(REPO_ROOT, "apps/cf");
export const RESOURCES_FILE = join(APPS_CF, "resources.json");

export type WorkerName = "core" | "front";
export const readWranglerConfig = (name: WorkerName, appsCf = APPS_CF): Record<string, unknown> => parseJsonc(readFileSync(join(appsCf, `wrangler.${name}.jsonc`), "utf8"));

/** What pnpm cf:resources records (no secret: ids and the public sitekey only). */
export interface CfResources {
  version: 1;
  kv: { CONFIG: string };
  d1: { OPS: string };
  turnstile: { sitekey: string };
  updatedAt: string;
}

export const PLACEHOLDER_IDS = { kv: "00000000000000000000000000000000", d1: "00000000-0000-0000-0000-000000000000", sitekey: "set-by-cf-resources" } as const;

export function readResources(file = RESOURCES_FILE): CfResources | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as CfResources;
    return r.version === 1 && r.kv?.CONFIG && r.d1?.OPS && r.turnstile?.sitekey ? r : null;
  } catch {
    return null;
  }
}

/** The deploy configs, with resources filled in (or the placeholders kept, for a dry run before cf:resources). */
export function deployConfigs(o: { resources: CfResources | null; accountId?: string | null; assetsDir?: string; appsCf?: string }): Record<WorkerName, Record<string, unknown>> {
  const core = readWranglerConfig("core", o.appsCf);
  const front = readWranglerConfig("front", o.appsCf);
  delete core.$schema;
  delete front.$schema;
  const r = o.resources;
  for (const c of [core, front]) {
    const kv = c.kv_namespaces as { binding: string; id: string }[];
    for (const k of kv) if (k.binding === "CONFIG") k.id = r?.kv.CONFIG ?? PLACEHOLDER_IDS.kv;
  }
  for (const d of core.d1_databases as { binding: string; database_id: string }[]) if (d.binding === "OPS") d.database_id = r?.d1.OPS ?? PLACEHOLDER_IDS.d1;
  (front.vars as Record<string, string>).TURNSTILE_SITEKEY = r?.turnstile.sitekey ?? PLACEHOLDER_IDS.sitekey;
  if (o.accountId) (core.vars as Record<string, string>).WEFT_AIG_ACCOUNT_ID = o.accountId;
  if (o.assetsDir) (front.assets as { directory: string }).directory = o.assetsDir;
  return { core, front };
}

/** Writes the deploy configs next to the originals (wrangler.<name>.deploy.json, gitignored) and returns their paths. */
export function writeDeployConfigs(cfgs: Record<WorkerName, Record<string, unknown>>, suffix = "deploy", appsCf = APPS_CF): Record<WorkerName, string> {
  const out = {} as Record<WorkerName, string>;
  for (const name of ["core", "front"] as const) {
    out[name] = join(appsCf, `wrangler.${name}.${suffix}.json`);
    writeFileSync(out[name], JSON.stringify(cfgs[name], null, 2) + "\n");
  }
  return out;
}

export interface LocalConfigOptions {
  /** Where the three configs are written. */
  dir: string;
  engine: "fake" | "real";
  origin: string;
  poolSize?: number;
  assetsDir: string;
  runWorkerFirst?: string[];
  coreVars?: Record<string, string>;
  frontVars?: Record<string, string>;
  configMemoMs?: number;
}

/** Writes core.json, front.json and fakes.json for a local run and returns their paths. */
export function writeLocalConfigs(o: LocalConfigOptions): { core: string; front: string; fakes: string } {
  mkdirSync(o.dir, { recursive: true });
  const { core, front } = deployConfigs({ resources: null });
  delete core.observability; delete core.ai; delete core.vectorize; delete core.browser;
  delete front.observability;
  core.main = o.engine === "real" ? join(APPS_CF, "src/core/index.ts") : join(APPS_CF, "test/support/core-entry.ts");
  core.services = [
    { binding: "AI", service: "weft-fakes", entrypoint: "FakeAi" },
    { binding: "MEMVEC", service: "weft-fakes", entrypoint: "FakeVectorize" },
    { binding: "BROWSER", service: "weft-fakes", entrypoint: "FakeBrowser" },
  ];
  (core.d1_databases as { migrations_dir?: string }[])[0]!.migrations_dir = join(APPS_CF, "d1");
  const memo = String(o.configMemoMs ?? 1000);
  const pool = String(o.poolSize ?? 2);
  core.vars = { ...(core.vars as Record<string, string>), WEFT_LLM: "scripted", WEFT_PUBLIC_ORIGIN: o.origin, WEFT_POOL_SIZE: pool, WEFT_CONFIG_MEMO_MS: memo, ...o.coreVars };
  front.main = join(APPS_CF, "src/front/index.ts");
  const fa = front.assets as { directory: string; run_worker_first: string[] };
  fa.directory = o.assetsDir;
  fa.run_worker_first = [...fa.run_worker_first, ...(o.runWorkerFirst ?? [])];
  front.vars = { ...(front.vars as Record<string, string>), TURNSTILE_SITEKEY: "1x00000000000000000000AA", WEFT_PUBLIC_ORIGIN: o.origin, WEFT_POOL_SIZE: pool, WEFT_CONFIG_MEMO_MS: memo, ...o.frontVars };
  const fakes = { name: "weft-fakes", main: join(APPS_CF, "test/support/fakes-worker.ts"), compatibility_date: core.compatibility_date, compatibility_flags: core.compatibility_flags };
  const paths = { core: join(o.dir, "core.json"), front: join(o.dir, "front.json"), fakes: join(o.dir, "fakes.json") };
  writeFileSync(paths.core, JSON.stringify(core, null, 1));
  writeFileSync(paths.front, JSON.stringify(front, null, 1));
  writeFileSync(paths.fakes, JSON.stringify(fakes, null, 1));
  return paths;
}
