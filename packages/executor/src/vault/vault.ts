// The vault (harness 6.4). The executor is the only reader of vault.key. AES-256-GCM per secret; resolved values
// are returned only to simulators as an in-memory argument and are added to the redactor.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { SimClock, VaultAdmin } from "@weft/contracts";
import { vaultSecrets, type Db, type DbTx } from "@weft/db";
import type { Redactor } from "./redact";
import { writeLocked } from "../write";

/** node:fs on first use, never a static import: this module is on the hosted import graph (docs/cloudflare/design.md
 * 6.4), where only Node's code paths call it. */
const fs = () => process.getBuiltinModule("node:fs");

export const VAULT_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function loadVaultKey(dataDir: string, env: Record<string, string | undefined> = process.env): Buffer {
  const fromEnv = env.WEFT_VAULT_KEY;
  if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) return Buffer.from(fromEnv, "hex");
  const dir = join(dataDir, "run");
  const file = join(dir, "vault.key");
  fs().mkdirSync(dir, { recursive: true });
  if (fs().existsSync(file)) {
    const hex = fs().readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  }
  const key = randomBytes(32);
  fs().writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
  fs().chmodSync(file, 0o600);
  return key;
}

export function fingerprint(value: string): string {
  return "fp_" + createHash("sha256").update("weft-vault-fingerprint:" + value).digest("hex").slice(0, 12);
}

export interface Vault extends VaultAdmin {
  resolve(tx: DbTx, ref: string): Promise<string>;
  exists(name: string): Promise<boolean>;
  /** Decrypts every stored value into the redactor (boot). */
  primeRedactor(): Promise<void>;
}

/**
 * Teaches the redactor a vault value. A JSON object value (the direct-deposit blob) also registers every digit-string
 * leaf of at least 8 characters, so a bare account number is redacted on its own, not only the whole blob. Routing
 * numbers are public bank identifiers and names are not secret, so neither is registered.
 */
export function learnSecret(redactor: Redactor, value: string): void {
  redactor.add(value);
  if (!value.startsWith("{")) return;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return; }
  const walk = (v: unknown, key: string): void => {
    if (/routing/i.test(key)) return;
    if (typeof v === "string" || typeof v === "number") { const t = String(v); if (/^[0-9][0-9 -]{6,}[0-9]$/.test(t)) redactor.add(t); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(parsed, "");
}

export function createVault(opts: { db: Db; clock: SimClock; key: Buffer; redactor: Redactor }): Vault {
  const { db, key, redactor, clock } = opts;
  const decrypt = (row: { ciphertext: string; iv: string; tag: string; name: string }) => {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    d.setAAD(Buffer.from(row.name));
    d.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(row.ciphertext, "base64")), d.final()]).toString("utf8");
  };
  return {
    async put(input) {
      if (!VAULT_NAME.test(input.name)) throw new Error(`vault: bad name ${input.name}`);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(input.name));
      const ct = Buffer.concat([c.update(Buffer.from(input.value, "utf8")), c.final()]);
      const row = {
        name: input.name, kind: input.kind, description: input.description, ciphertext: ct.toString("base64"), iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"), fingerprint: fingerprint(input.value), createdBy: input.by, createdAt: clock.now(), lastUsedAt: null,
      };
      learnSecret(redactor, input.value);
      await writeLocked(() => db.insert(vaultSecrets).values(row).onConflictDoUpdate({ target: vaultSecrets.name, set: { kind: row.kind, description: row.description, ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, fingerprint: row.fingerprint } }));
    },
    async list() {
      const rows = await db.select({ name: vaultSecrets.name, kind: vaultSecrets.kind, fingerprint: vaultSecrets.fingerprint }).from(vaultSecrets).orderBy(vaultSecrets.name);
      return rows;
    },
    async exists(name) {
      const rows = await db.select({ name: vaultSecrets.name }).from(vaultSecrets).where(eq(vaultSecrets.name, name)).limit(1);
      return rows.length > 0;
    },
    async resolve(tx, ref) {
      const name = ref.startsWith("vault:") ? ref.slice(6) : ref;
      const [row] = await tx.select().from(vaultSecrets).where(eq(vaultSecrets.name, name)).limit(1);
      if (!row) throw new Error(`vault: no secret named ${name}`);
      const v = decrypt(row);
      learnSecret(redactor, v);
      return v;
    },
    async primeRedactor() {
      for (const row of await db.select().from(vaultSecrets)) {
        try { learnSecret(redactor, decrypt(row)); } catch { /* wrong key: the value stays unreadable */ }
      }
    },
  };
}
