// pnpm cf:resources (docs/cloudflare/design.md 9.1): creates the account resources Weft needs, idempotently, with the
// account token through scripts/cf/with-cf.sh (never wrangler OAuth):
//
//   KV weft-config; D1 weft-ops; R2 weft-files with lifecycle rules (w/ and exports/ expire after 3 days); Queues
//   weft-jobs, weft-render, weft-dlq; Vectorize weft-memory (768, cosine) with metadata indexes on gen, tainted and
//   kind created before the first upsert; the AI Gateway (logs on, cache TTL 1 day, a sliding rate limit of 60 per
//   60 s) under a secret name; the Turnstile widget `weft` (managed, the workers.dev hostname).
//
// It reads the account's subscriptions (read only) before and after and stops if anything about billing changed; it
// never upgrades, adds a payment method, accepts terms or enables Analytics Engine. Ids and the public sitekey go to
// apps/cf/resources.json; the Turnstile secret and the gateway name go straight to the cf secrets file (mode 600) and
// are never printed. `--plan` only reads. AI Search (weft-help) and the gateway spend rule are first-deploy checks
// this script lists and leaves to the Deploy stage.
//
//   scripts/cf/with-cf.sh pnpm cf:resources [--plan]
import { writeFileSync } from "node:fs";
import { cfApiFromEnv, CfApiError, type CfApi } from "./lib/cf-api";
import { RESOURCES_FILE, type CfResources } from "./lib/configs";
import { CF_SECRETS_FILE, ensureEnvValue, hex, readEnvValue, writeEnvValue } from "./lib/env-file";

export const NAMES = {
  kv: "weft-config",
  d1: "weft-ops",
  r2: "weft-files",
  queues: ["weft-jobs", "weft-render", "weft-dlq"],
  vectorize: "weft-memory",
  turnstile: "weft",
  hostname: "weft.nitish-ratakonda.workers.dev",
} as const;
export const VECTOR_METADATA: readonly { propertyName: string; indexType: "number" | "boolean" | "string" }[] = [
  { propertyName: "gen", indexType: "number" },
  { propertyName: "tainted", indexType: "boolean" },
  { propertyName: "kind", indexType: "string" },
];
export const R2_LIFECYCLE = {
  rules: ["w/", "exports/"].map((prefix) => ({
    id: `expire-${prefix.replace("/", "")}`, enabled: true, conditions: { prefix },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: 3 * 86_400 } },
  })),
};
export const GATEWAY_SETTINGS = {
  collect_logs: true, cache_ttl: 86_400, cache_invalidate_on_update: true,
  rate_limiting_interval: 60, rate_limiting_limit: 60, rate_limiting_technique: "sliding",
} as const;

export type Step = { resource: string; action: "exists" | "create" | "update" | "manual"; detail?: string };

export interface ResourcesOptions {
  plan: boolean;
  secretsFile: string;
  resourcesFile: string;
  log: (line: string) => void;
}

const isMissing = (e: unknown) => e instanceof CfApiError && e.status === 404;

/** A stable view of the account's subscriptions, for the before and after billing check. */
export async function billingSnapshot(api: CfApi): Promise<string> {
  const subs = await api.get<{ id?: string; rate_plan?: { id?: string }; price?: number; frequency?: string; state?: string; product?: { name?: string } }[]>(`/accounts/:account/subscriptions`);
  return JSON.stringify((subs ?? []).map((s) => [s.id ?? "", s.rate_plan?.id ?? "", s.price ?? 0, s.frequency ?? "", s.state ?? "", s.product?.name ?? ""]).sort());
}

export async function ensureResources(api: CfApi, o: ResourcesOptions): Promise<{ steps: Step[]; resources: CfResources | null }> {
  const steps: Step[] = [];
  const step = (s: Step) => { steps.push(s); o.log(`${s.action.padEnd(7)} ${s.resource}${s.detail ? ` (${s.detail})` : ""}`); };
  const billingBefore = await billingSnapshot(api);

  // KV
  const kvs = await api.get<{ id: string; title: string }[]>(`/accounts/:account/storage/kv/namespaces?per_page=100`);
  let kvId = kvs.find((n) => n.title === NAMES.kv)?.id ?? null;
  if (kvId) step({ resource: `KV ${NAMES.kv}`, action: "exists" });
  else {
    step({ resource: `KV ${NAMES.kv}`, action: "create" });
    if (!o.plan) kvId = (await api.post<{ id: string }>(`/accounts/:account/storage/kv/namespaces`, { title: NAMES.kv })).id;
  }

  // D1
  const dbs = await api.get<{ uuid: string; name: string }[]>(`/accounts/:account/d1/database?name=${NAMES.d1}`);
  let d1Id = dbs.find((d) => d.name === NAMES.d1)?.uuid ?? null;
  if (d1Id) step({ resource: `D1 ${NAMES.d1}`, action: "exists" });
  else {
    step({ resource: `D1 ${NAMES.d1}`, action: "create" });
    if (!o.plan) d1Id = (await api.post<{ uuid: string }>(`/accounts/:account/d1/database`, { name: NAMES.d1 })).uuid;
  }

  // R2 and its lifecycle rules
  const buckets = await api.get<{ buckets?: { name: string }[] }>(`/accounts/:account/r2/buckets`);
  if ((buckets.buckets ?? []).some((b) => b.name === NAMES.r2)) step({ resource: `R2 ${NAMES.r2}`, action: "exists" });
  else {
    step({ resource: `R2 ${NAMES.r2}`, action: "create" });
    if (!o.plan) await api.post(`/accounts/:account/r2/buckets`, { name: NAMES.r2 });
  }
  step({ resource: `R2 ${NAMES.r2} lifecycle`, action: "update", detail: "w/ and exports/ expire after 3 days" });
  if (!o.plan) await api.put(`/accounts/:account/r2/buckets/${NAMES.r2}/lifecycle`, R2_LIFECYCLE);

  // Queues
  const queues = await api.get<{ queue_name: string }[]>(`/accounts/:account/queues`);
  for (const q of NAMES.queues) {
    if (queues.some((x) => x.queue_name === q)) step({ resource: `Queue ${q}`, action: "exists" });
    else {
      step({ resource: `Queue ${q}`, action: "create" });
      if (!o.plan) await api.post(`/accounts/:account/queues`, { queue_name: q });
    }
  }

  // Vectorize and its metadata indexes (before the first upsert)
  let haveIndex = true;
  try { await api.get(`/accounts/:account/vectorize/v2/indexes/${NAMES.vectorize}`); } catch (e) { if (!isMissing(e)) throw e; haveIndex = false; }
  if (haveIndex) step({ resource: `Vectorize ${NAMES.vectorize}`, action: "exists" });
  else {
    step({ resource: `Vectorize ${NAMES.vectorize}`, action: "create", detail: "768 dimensions, cosine" });
    if (!o.plan) await api.post(`/accounts/:account/vectorize/v2/indexes`, { name: NAMES.vectorize, config: { dimensions: 768, metric: "cosine" } });
  }
  const meta = haveIndex || !o.plan
    ? (await api.get<{ metadataIndexes?: { propertyName: string }[] }>(`/accounts/:account/vectorize/v2/indexes/${NAMES.vectorize}/metadata_index/list`).catch(() => ({ metadataIndexes: [] })))
    : { metadataIndexes: [] };
  for (const m of VECTOR_METADATA) {
    if ((meta.metadataIndexes ?? []).some((x) => x.propertyName === m.propertyName)) step({ resource: `Vectorize metadata index ${m.propertyName}`, action: "exists" });
    else {
      step({ resource: `Vectorize metadata index ${m.propertyName}`, action: "create", detail: m.indexType });
      if (!o.plan) await api.post(`/accounts/:account/vectorize/v2/indexes/${NAMES.vectorize}/metadata_index/create`, m);
    }
  }

  // AI Gateway under a secret name (design 9.3: unauthenticated until Nitish creates the gateway token)
  const gateway = o.plan ? readEnvValue(o.secretsFile, "WEFT_AIG_GATEWAY") : ensureEnvValue(o.secretsFile, "WEFT_AIG_GATEWAY", () => `weft-${hex(6)}`).value;
  let haveGateway = false;
  if (gateway) {
    try { await api.get(`/accounts/:account/ai-gateway/gateways/${gateway}`); haveGateway = true; } catch (e) { if (!isMissing(e)) throw e; }
  }
  if (haveGateway) step({ resource: "AI Gateway (secret name)", action: "exists" });
  else {
    step({ resource: "AI Gateway (secret name)", action: "create", detail: "logs on, cache 1 day, 60 per 60 s sliding" });
    if (!o.plan) await api.post(`/accounts/:account/ai-gateway/gateways`, { id: gateway, ...GATEWAY_SETTINGS });
  }
  step({ resource: "AI Gateway spend rule $2.50 a day", action: "manual", detail: "first-deploy check: whether spend rules apply on Free" });

  // Turnstile widget; its secret goes to the secrets file and is never printed
  const widgets = await api.get<{ sitekey: string; name: string }[]>(`/accounts/:account/challenges/widgets?per_page=50`);
  let sitekey = widgets.find((w) => w.name === NAMES.turnstile)?.sitekey ?? null;
  if (sitekey) {
    step({ resource: `Turnstile widget ${NAMES.turnstile}`, action: "exists" });
    if (!o.plan && !readEnvValue(o.secretsFile, "TURNSTILE_SECRET")) {
      const w = await api.get<{ secret?: string }>(`/accounts/:account/challenges/widgets/${sitekey}`);
      if (w.secret) writeEnvValue(o.secretsFile, "TURNSTILE_SECRET", w.secret);
    }
  } else {
    step({ resource: `Turnstile widget ${NAMES.turnstile}`, action: "create", detail: `managed, ${NAMES.hostname}` });
    if (!o.plan) {
      const w = await api.post<{ sitekey: string; secret: string }>(`/accounts/:account/challenges/widgets`, { name: NAMES.turnstile, domains: [NAMES.hostname], mode: "managed" });
      sitekey = w.sitekey;
      writeEnvValue(o.secretsFile, "TURNSTILE_SECRET", w.secret);
    }
  }
  step({ resource: "AI Search weft-help", action: "manual", detail: "created only after its first-deploy check (design 9.1)" });

  const billingAfter = await billingSnapshot(api);
  if (billingAfter !== billingBefore) throw new Error("STOP: the account's subscriptions changed while creating resources; check billing before going on");

  if (o.plan || !kvId || !d1Id || !sitekey) return { steps, resources: null };
  const resources: CfResources = { version: 1, kv: { CONFIG: kvId }, d1: { OPS: d1Id }, turnstile: { sitekey }, updatedAt: new Date().toISOString() };
  writeFileSync(o.resourcesFile, JSON.stringify(resources, null, 2) + "\n");
  return { steps, resources };
}

async function main(argv: string[]): Promise<void> {
  const plan = argv.includes("--plan");
  const api = cfApiFromEnv();
  const { resources } = await ensureResources(api, { plan, secretsFile: CF_SECRETS_FILE, resourcesFile: RESOURCES_FILE, log: (l) => console.log(l) });
  console.log(plan ? "cf:resources --plan: nothing written" : `cf:resources: wrote ${RESOURCES_FILE.replace(/^.*\/apps\//, "apps/")}${resources ? "" : " (incomplete)"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
