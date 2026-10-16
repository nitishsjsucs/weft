// Integration records (docs/wave3.md 3.1, research/wave3/integrations-hr.md 3.4 and 3.5). Owner: w3-integrations-hr.
// Domain tables written only by integrations.* commands: integration_connections (mode, cursor, value maps),
// ext_links (one Weft record per vendor record), ext_snapshots (value hashes for conflict detection),
// integration_deliveries (ids only, never a body) and sync_items (human-only conflicts and unmapped values).
import { and, desc, eq } from "drizzle-orm";
import type { IntegrationVendor, SyncItem, SyncItemKind } from "@weft/contracts";
import { extLinks, extSnapshots, integrationConnections, syncItems, type DbTx } from "@weft/db";
import { sha256Hex } from "../shared/hash";
import type { CommandDeps } from "../shared/deps";

export interface ConnectionSettings { departments?: Record<string, string>; offices?: Record<string, string> }
export type ConnectionRow = typeof integrationConnections.$inferSelect;
export type SyncItemRow = typeof syncItems.$inferSelect;
export type ExtLinkRow = typeof extLinks.$inferSelect;

export const connectionId = (vendor: IntegrationVendor) => `intc_${vendor}`;

export async function getConnection(tx: DbTx, companyId: string, vendor: IntegrationVendor): Promise<ConnectionRow | null> {
  const [row] = await tx.select().from(integrationConnections).where(and(eq(integrationConnections.companyId, companyId), eq(integrationConnections.vendor, vendor))).limit(1);
  return row ?? null;
}

export async function upsertConnection(tx: DbTx, companyId: string, vendor: IntegrationVendor, now: string, patch: Partial<Pick<ConnectionRow, "mode" | "lastSyncAt" | "cursor" | "health" | "detail" | "ownershipJson" | "settingsJson">>): Promise<ConnectionRow> {
  const have = await getConnection(tx, companyId, vendor);
  if (have) {
    await tx.update(integrationConnections).set({ ...patch, updatedAt: now }).where(eq(integrationConnections.id, have.id));
    return { ...have, ...patch, updatedAt: now };
  }
  const row: ConnectionRow = { id: connectionId(vendor), companyId, vendor, mode: "simulated", lastSyncAt: null, cursor: null, health: "ok", detail: null, ownershipJson: null, settingsJson: "{}", ...patch, updatedAt: now };
  await tx.insert(integrationConnections).values(row);
  return row;
}

export const settingsOf = (c: ConnectionRow | null): ConnectionSettings => { try { return c ? (JSON.parse(c.settingsJson) as ConnectionSettings) : {}; } catch { return {}; } };

export async function findLink(tx: DbTx, vendor: string, extType: string, extId: string): Promise<ExtLinkRow | null> {
  const [l] = await tx.select().from(extLinks).where(and(eq(extLinks.vendor, vendor), eq(extLinks.extType, extType), eq(extLinks.extId, extId))).limit(1);
  return l ?? null;
}
export async function linksTo(tx: DbTx, weftType: string, weftId: string): Promise<ExtLinkRow[]> {
  return tx.select().from(extLinks).where(and(eq(extLinks.weftType, weftType), eq(extLinks.weftId, weftId)));
}

export const valueHash = (v: unknown) => sha256Hex(JSON.stringify(v ?? null));

export async function readSnapshot(tx: DbTx, vendor: string, extType: string, extId: string): Promise<Record<string, string>> {
  const rows = await tx.select().from(extSnapshots).where(and(eq(extSnapshots.vendor, vendor), eq(extSnapshots.extType, extType), eq(extSnapshots.extId, extId)));
  return Object.fromEntries(rows.map((r) => [r.field, r.valueHash]));
}
export async function writeSnapshot(tx: DbTx, vendor: string, extType: string, extId: string, fields: Record<string, unknown>, now: string): Promise<void> {
  for (const [field, v] of Object.entries(fields)) {
    await tx.insert(extSnapshots).values({ vendor, extType, extId, field, valueHash: valueHash(v), seenAt: now })
      .onConflictDoUpdate({ target: [extSnapshots.vendor, extSnapshots.extType, extSnapshots.extId, extSnapshots.field], set: { valueHash: valueHash(v), seenAt: now } });
  }
}

export function toSyncItem(r: SyncItemRow): SyncItem {
  return { id: r.id, vendor: r.vendor as IntegrationVendor, kind: r.kind as SyncItemKind, subjectRef: r.subjectRef, status: r.status as SyncItem["status"], detail: JSON.parse(r.detailJson) as Record<string, string>, createdAt: r.createdAt, resolvedAt: r.resolvedAt };
}

export async function listSyncItems(tx: DbTx, companyId: string, f: { status?: string; vendor?: string; subjectRef?: string } = {}): Promise<SyncItemRow[]> {
  const rows = await tx.select().from(syncItems).where(eq(syncItems.companyId, companyId)).orderBy(desc(syncItems.id));
  return rows.filter((r) => (!f.status || f.status === "all" || r.status === f.status) && (!f.vendor || r.vendor === f.vendor) && (!f.subjectRef || r.subjectRef === f.subjectRef));
}

/** Opens a sync item unless an open one with the same kind, subject and detail key already exists. */
export async function openSyncItem(deps: CommandDeps, companyId: string, now: string, i: { vendor: IntegrationVendor; kind: SyncItemKind; subjectRef: string; detail: Record<string, string>; key: string }): Promise<{ id: string; created: boolean }> {
  const open = await listSyncItems(deps.tx, companyId, { status: "open", vendor: i.vendor, subjectRef: i.subjectRef });
  const same = open.find((r) => r.kind === i.kind && (JSON.parse(r.detailJson) as Record<string, string>).key === i.key);
  if (same) return { id: same.id, created: false };
  const id = await deps.newId("syn_");
  await deps.tx.insert(syncItems).values({ id, companyId, vendor: i.vendor, kind: i.kind, subjectRef: i.subjectRef, status: "open", detailJson: JSON.stringify({ ...i.detail, key: i.key }), createdAt: now, resolvedAt: null, resolvedBy: null });
  return { id, created: true };
}
