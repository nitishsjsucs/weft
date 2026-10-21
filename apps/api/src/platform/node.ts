// The Node platform's parts (docs/cloudflare/design.md 3.3): today's behavior, moved behind the WeftPlatform seams so
// assemble.ts composes both platforms the same way. Uploads under <dataDir>/uploads/<sha256>.bin (or the blobs table
// with WEFT_BLOBS=sqlite), run handles as 0600 JSON files, the proxy secret and the vault key in <dataDir>/run, the
// scheduler on setInterval. This is the only platform module that touches node:fs.
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { INTEGRATION_OPTIONAL_SECRETS, INTEGRATION_SECRETS, IntegrationVendor, type RunHandle } from "@weft/contracts";
import type { Db } from "@weft/db";
import { readSecret } from "@weft/integrations";
import type { BlobStore, PlatformContext, RunHandleStore, SchedulerHost, WeftPlatform } from "../../../../packages/contracts/src/ext/cf-platform";
import { sqlBlobStore } from "./sql";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

export const FILE_UPLOAD = /^uploads\/[0-9a-f]{64}\.bin$/;

/** Uploads as files, content-addressed: storage_path uploads/<sha256>.bin, mode 0600 (SPEC 10 upload limits are the routes'). */
export function fileBlobStore(dataDir: string): BlobStore {
  const root = resolve(dataDir);
  const abs = (storagePath: string): string | null => {
    if (!FILE_UPLOAD.test(storagePath)) return null;
    const f = resolve(join(root, storagePath));
    return f.startsWith(root + sep) ? f : null;
  };
  return {
    kind: "file",
    async put(bytes) {
      const sha = createHash("sha256").update(bytes).digest("hex");
      const storagePath = `uploads/${sha}.bin`;
      const f = join(root, storagePath);
      const fresh = !fs().existsSync(f);
      fs().mkdirSync(join(root, "uploads"), { recursive: true });
      if (fresh) fs().writeFileSync(f, bytes, { mode: 0o600 });
      return { storagePath, sha256: sha, bytes: bytes.byteLength, fresh };
    },
    async get(storagePath) {
      const f = abs(storagePath);
      if (!f) return null;
      try { return new Uint8Array(fs().readFileSync(f)); } catch { return null; }
    },
    async has(storagePath) {
      const f = abs(storagePath);
      return !!f && fs().existsSync(f);
    },
    async delete(storagePath) {
      const f = abs(storagePath);
      if (f) { try { fs().unlinkSync(f); } catch { /* already gone */ } }
    },
  };
}

/** Node uploads: files, or the blobs table with WEFT_BLOBS=sqlite (what the hosted snapshot is seeded with). */
export function nodeBlobStore(ctx: PlatformContext<Db>): BlobStore {
  return ctx.env.WEFT_BLOBS === "sqlite" ? sqlBlobStore(ctx.db) : fileBlobStore(ctx.dataDir);
}

const SAFE_RUN_ID = /^run_[A-Za-z0-9_]+$/;

/** Gate report item 2: one 0600 JSON file per open run handle in `dir` (created 0700), so a waiting routine run survives an API restart. */
export function fileRunHandleStore(dir: string): RunHandleStore {
  const file = (runId: string) => {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`unsafe run id ${JSON.stringify(runId).slice(0, 40)}`);
    return join(dir, `${runId}.json`);
  };
  return {
    async save(handle) {
      fs().mkdirSync(dir, { recursive: true, mode: 0o700 });
      const f = file(handle.runId);
      fs().writeFileSync(f, JSON.stringify(handle), { mode: 0o600 });
      fs().chmodSync(f, 0o600);
    },
    async load(runId) {
      if (!SAFE_RUN_ID.test(runId)) return null;
      try {
        const v = JSON.parse(fs().readFileSync(file(runId), "utf8")) as Partial<RunHandle> & { nonce?: unknown };
        if (v.runId !== runId || typeof v.token !== "string") return null;
        return Object.freeze(typeof v.nonce === "string" ? { runId, token: v.token, nonce: v.nonce } : { runId, token: v.token });
      } catch { return null; }
    },
    async drop(runId) {
      if (!SAFE_RUN_ID.test(runId)) return;
      try { fs().rmSync(file(runId), { force: true }); } catch { /* already gone */ }
    },
  };
}

/** The x-weft-proxy secret in <dataDir>/run/proxy.secret (0600), created on first use. */
export function readOrCreateProxySecret(dataDir: string): string {
  const dir = join(dataDir, "run");
  const file = join(dir, "proxy.secret");
  fs().mkdirSync(dir, { recursive: true });
  if (fs().existsSync(file)) { const s = fs().readFileSync(file, "utf8").trim(); if (s.length >= 32) return s; }
  const secret = randomBytes(32).toString("hex");
  fs().writeFileSync(file, secret + "\n", { mode: 0o600 });
  fs().chmodSync(file, 0o600);
  return secret;
}

/** Node: a 5 s setInterval tick (plus kick() after mutations), unref'd so tests and scripts can exit. */
export function intervalSchedulerHost(): SchedulerHost {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start({ tick, intervalMs }) {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

/**
 * Wave 3: the vendor credentials (and the DocuSign private key's contents) for the redactor, as a backstop if one ever
 * reached an action row, a refusal, the model or MCP output. Names only come from the contracts; values stay in
 * memory. Node only: hosted integrations are always simulated.
 */
export function learnVendorSecrets(env: Record<string, string | undefined>, add: (value: string) => void): void {
  const names = [...new Set(IntegrationVendor.options.flatMap((v) => [...INTEGRATION_SECRETS[v], ...INTEGRATION_OPTIONAL_SECRETS[v]]))];
  for (const k of names) {
    const v = (() => { try { return readSecret(k, env); } catch { return null; } })();
    if (!v) continue;
    add(v);
    if (k === "DOCUSIGN_PRIVATE_KEY_FILE") {
      const pem = (() => { try { return fs().readFileSync(v, "utf8").trim(); } catch { return null; } })();
      if (pem) add(pem);
    }
  }
}

/** The Node platform: no part set, so assemble uses the Node parts above (and today's code) for every one. */
export const nodePlatform: WeftPlatform<Db> = { kind: "node" };
