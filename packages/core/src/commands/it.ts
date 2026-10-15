// it.* commands. Owner: t2-world. Append WeftCommand definitions to this array; commands/index.ts concatenates it.
import { z } from "zod";
import { formatCents } from "@weft/contracts";
import type { WeftCommand } from "../shared/deps";
import { readCommand, responseFormatField } from "../demo/define";
import { lookups } from "../people/queries";
import { listDevices, listItAccounts } from "../it/queries";

const ListAccountsInput = z.object({ worker_id: z.string().optional(), ...responseFormatField });
type ListAccountsInput = z.infer<typeof ListAccountsInput>;
const listAccounts = readCommand({
  name: "it.list_accounts", domain: "it",
  summary: "List IT accounts (Google Workspace, chat, GitHub, SSO) by worker.",
  description: "List IT accounts in the simulated identity provider: worker, system (google_ws, chat, github, sso), handle, groups and status (provisioning, active, suspended). Filter by worker_id. by_system counts accounts per system.",
  input: ListAccountsInput,
  async run(i: ListAccountsInput, ctx, deps) {
    const rows = await listItAccounts(deps.tx, ctx.companyId, i.worker_id);
    const L = await lookups(deps.tx, ctx.companyId);
    const bySystem: Record<string, number> = {};
    for (const a of rows) bySystem[a.system] = (bySystem[a.system] ?? 0) + 1;
    const limit = i.worker_id ? rows.length : 40;
    const accounts = rows.slice(0, limit).map((a) => ({ id: a.id, worker: L.person(a.workerId), system: a.system, handle: a.handle, groups: JSON.parse(a.groupsJson) as string[], status: a.status }));
    return { data: { total: rows.length, count: accounts.length, by_system: bySystem, accounts }, summary: `Listed ${rows.length} IT accounts` };
  },
});

const ListDevicesInput = z.object({ worker_id: z.string().optional(), ...responseFormatField });
type ListDevicesInput = z.infer<typeof ListDevicesInput>;
const listDevicesCmd = readCommand({
  name: "it.list_devices", domain: "it",
  summary: "List devices and the simulated vendor catalog.",
  description: "List company devices (model, status ordered, shipped, delivered or assigned, order reference, price in cents with display) and the simulated vendor catalog. Filter by worker_id.",
  input: ListDevicesInput,
  async run(i: ListDevicesInput, ctx, deps) {
    const rows = await listDevices(deps.tx, ctx.companyId, i.worker_id);
    const L = await lookups(deps.tx, ctx.companyId);
    const limit = i.worker_id ? rows.length : 40;
    const list = rows.slice(0, limit).map((d) => ({ id: d.id, worker: L.person(d.workerId), model: d.model, status: d.status, order_ref: d.orderRef, price_cents: d.priceCents, price_display: formatCents(d.priceCents) }));
    const catalog = deps.sims.devices.catalog().map((c) => ({ sku: c.sku, name: c.name, price_cents: c.priceCents, price_display: formatCents(c.priceCents), eta_business_days: c.etaBusinessDays }));
    return { data: { total: rows.length, count: list.length, devices: list, catalog }, summary: `Listed ${rows.length} devices` };
  },
});

export const itCommands: WeftCommand[] = [listAccounts, listDevicesCmd];
