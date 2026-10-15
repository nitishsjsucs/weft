// IT reads shared by it.* commands and the /v1/it routes.
import { and, asc, eq, inArray } from "drizzle-orm";
import { money, type Device, type ItAccount } from "@weft/contracts";
import { devices, itAccounts, workers, type DbTx } from "@weft/db";

export type ItAccountRow = typeof itAccounts.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;

export function toItAccountDto(a: ItAccountRow): ItAccount {
  return { id: a.id, workerId: a.workerId, system: a.system as ItAccount["system"], handle: a.handle, groups: JSON.parse(a.groupsJson) as string[], status: a.status as ItAccount["status"], simRef: a.simRef };
}
export function toDeviceDto(d: DeviceRow): Device {
  return { id: d.id, workerId: d.workerId, model: d.model, status: d.status as Device["status"], orderRef: d.orderRef, price: money(d.priceCents) };
}

async function companyWorkerIds(tx: DbTx, companyId: string, workerId?: string): Promise<string[]> {
  return (await tx.select({ id: workers.id }).from(workers).where(workerId ? and(eq(workers.companyId, companyId), eq(workers.id, workerId)) : eq(workers.companyId, companyId))).map((r) => r.id);
}

export async function listItAccounts(tx: DbTx, companyId: string, workerId?: string): Promise<ItAccountRow[]> {
  const ids = await companyWorkerIds(tx, companyId, workerId);
  return ids.length ? tx.select().from(itAccounts).where(inArray(itAccounts.workerId, ids)).orderBy(asc(itAccounts.id)) : [];
}
export async function listDevices(tx: DbTx, companyId: string, workerId?: string): Promise<DeviceRow[]> {
  const ids = await companyWorkerIds(tx, companyId, workerId);
  return ids.length ? tx.select().from(devices).where(inArray(devices.workerId, ids)).orderBy(asc(devices.id)) : [];
}
