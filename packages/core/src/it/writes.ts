// it.* writes: IdP accounts (R3, auto-allowed untainted for the main agent; R4 with admin groups) and device
// orders (R4, always; amount from the simulated vendor catalog, never from args).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { formatCents, ItSystem } from "@weft/contracts";
import { departments, devices, itAccounts, onboardingTasks, workplaces, type DbTx } from "@weft/db";
import { canonicalJson } from "../shared/canonical-json";
import { sha256Hex } from "../shared/hash";
import type { WeftCommand } from "../shared/deps";
import { DomainRefusal, notFound, writeCommand } from "../demo/define";
import { nameRef } from "../people/names";
import { getWorker } from "../people/queries";
import { defaultGroups, GITHUB_DEPARTMENTS, handleFor, hasAdminGroup } from "./handles";

export const IDP_ADMIN_REF = "vault:idp-admin" as const;
export const DEFAULT_DEVICE_SKU = "lrk-laptop-std";

async function deptSlug(tx: DbTx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [d] = await tx.select().from(departments).where(eq(departments.id, id)).limit(1);
  return d ? d.name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "").replace("go-to-market", "gtm") : null;
}

/** Systems a worker should have: google_ws and chat for everyone; github for Engineering and Hardware. */
export function requiredSystems(departmentId: string | null): ItSystem[] {
  return (GITHUB_DEPARTMENTS as readonly string[]).includes(departmentId ?? "") ? ["google_ws", "chat", "github"] : ["google_ws", "chat"];
}

async function completeTaskIf(tx: DbTx, workerId: string, kind: string, now: string) {
  const [t] = await tx.select().from(onboardingTasks).where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.kind, kind))).limit(1);
  if (t && t.status !== "done") await tx.update(onboardingTasks).set({ status: "done", doneAt: now, blockedReason: null }).where(eq(onboardingTasks.id, t.id));
}

/** A leaver (offboarding, inactive or terminated, or past their end date) is never provisioned again. */
function refuseLeaver(w: { id: string; status: string; endDate: string | null }, now: string) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(now));
  if (w.status === "offboarding" || w.status === "inactive" || w.status === "terminated" || (w.endDate !== null && w.endDate <= today)) {
    throw new DomainRefusal("DOMAIN_NOT_ACTIVE", `${w.id} is ${w.status}${w.endDate ? ` with end date ${w.endDate}` : ""}; a leaver gets no new accounts or devices`, null, null);
  }
}

const CreateInput = z.object({ worker_id: z.string(), system: ItSystem, groups: z.array(z.string().regex(/^[a-z0-9-]{2,40}$/)).max(8).optional() });
type CreateInput = z.infer<typeof CreateInput>;
async function createPlan(i: CreateInput, companyId: string, tx: DbTx, now: string) {
  const w = await getWorker(tx, companyId, i.worker_id);
  if (!w) throw notFound("worker", i.worker_id);
  if (w.type !== "employee") throw new DomainRefusal("DOMAIN_NOT_EMPLOYEE", `${w.id} is a ${w.type}`, null, null);
  refuseLeaver(w, now);
  const handle = handleFor(i.system, w.firstName, w.lastName);
  const groups = i.groups ?? defaultGroups(i.system, await deptSlug(tx, w.departmentId));
  const [existing] = await tx.select().from(itAccounts).where(and(eq(itAccounts.workerId, w.id), eq(itAccounts.system, i.system))).limit(1);
  return { w, handle, groups, existing: existing ?? null };
}
export const createAccount = writeCommand({
  name: "it.create_account", summary: "Create a worker's account in the simulated IdP.",
  description: "Create a worker's account (worker_id, system google_ws, chat, github or sso) in the simulated identity provider. The handle is derived from the worker record; groups default by department. R3, runs without approval for an untainted main agent; admin groups (admin, sso-admin, github-owners, workspace-admin) make it R4. Idempotent per worker and system.",
  input: CreateInput, domain: "it", needs: "edit", effect: "external",
  risk: (i) => (hasAdminGroup(i.groups ?? []) ? "R4" : "R3"), approval: "always", autoAllow: "untainted", reversible: false,
  lease: (i) => `it:${i.worker_id}:${i.system}`,
  async preview(i, ctx, deps) {
    const { w, handle, groups, existing } = await createPlan(i, ctx.companyId, deps.tx, ctx.now);
    return { title: `Create ${i.system} account ${handle} for ${nameRef(w.firstName, w.lastName, w.id)}${hasAdminGroup(groups) ? " with admin groups" : ""}`, diff: [{ label: `${i.system} account`, before: existing ? existing.status : "none", after: `active (${groups.join(", ")})` }], content: [], moneyCents: null, subjectRef: `${w.id}:${i.system}`, subjectHash: sha256Hex(canonicalJson({ worker: w.id, system: i.system, existing: existing?.id ?? null })), evidence: [{ label: "Worker", ref: w.id }] };
  },
  async run(i, ctx, deps) {
    const tx = deps.tx;
    const { w, handle, groups, existing } = await createPlan(i, ctx.companyId, tx, ctx.now);
    if (existing) return { data: { it_account_id: existing.id, worker_id: w.id, system: i.system, handle: existing.handle, status: existing.status, created: false }, summary: `${i.system} account ${existing.handle} already exists for ${nameRef(w.firstName, w.lastName, w.id)}` };
    const credential = await deps.resolveCredential(IDP_ADMIN_REF);
    const res = await deps.sims.idp.createAccount({ workerId: w.id, system: i.system, handle, groups, credential });
    const id = await deps.newId("ita_");
    await tx.insert(itAccounts).values({ id, workerId: w.id, system: i.system, handle, groupsJson: JSON.stringify(groups), status: res.status, simRef: res.ref });
    const have = new Set((await tx.select().from(itAccounts).where(eq(itAccounts.workerId, w.id))).map((a) => a.system));
    if (requiredSystems(w.departmentId).every((s) => have.has(s))) await completeTaskIf(tx, w.id, "it_accounts", ctx.now);
    return { data: { it_account_id: id, worker_id: w.id, system: i.system, handle, groups, status: res.status, sim_ref: res.ref, created: true }, summary: `Created ${i.system} account ${handle} for ${nameRef(w.firstName, w.lastName, w.id)}` };
  },
});

const OrderInput = z.object({ worker_id: z.string(), sku: z.string().optional() });
type OrderInput = z.infer<typeof OrderInput>;
async function orderPlan(i: OrderInput, companyId: string, deps: Parameters<WeftCommand["run"]>[2], now: string) {
  const w = await getWorker(deps.tx, companyId, i.worker_id);
  if (!w) throw notFound("worker", i.worker_id);
  refuseLeaver(w, now);
  const sku = i.sku ?? DEFAULT_DEVICE_SKU;
  const item = deps.sims.devices.catalog().find((c) => c.sku === sku);
  if (!item) throw new DomainRefusal("DOMAIN_UNKNOWN_SKU", `No catalog item ${sku}`, "Use a sku from it.list_devices catalog", { worker_id: w.id, sku: DEFAULT_DEVICE_SKU });
  const [place] = w.workplaceId ? await deps.tx.select().from(workplaces).where(eq(workplaces.id, w.workplaceId)).limit(1) : [];
  const shipTo = place?.city ? `${place.name}, ${place.city}, ${place.state}` : `Home address on file (${w.workState ?? w.country})`;
  return { w, item, shipTo };
}
export const orderDevice = writeCommand({
  name: "it.order_device", summary: "Order a laptop from the simulated vendor.",
  description: "Propose ordering a device for worker_id from the simulated vendor catalog (default sku lrk-laptop-std, the standard laptop at $1,899.00). R4: always needs approval; the amount comes from the catalog and counts against the agent device ceilings. Not reversible once ordered.",
  input: OrderInput, domain: "it", needs: "edit", effect: "external", risk: () => "R4", approval: "always", reversible: false,
  amountCents: async (i, ctx, deps) => (await orderPlan(i, ctx.companyId, deps, ctx.now)).item.priceCents,
  ceilingKey: "agent.device_cents", lease: (i) => `device:${i.worker_id}`,
  async preview(i, ctx, deps) {
    const { w, item, shipTo } = await orderPlan(i, ctx.companyId, deps, ctx.now);
    return { title: `Order ${item.name} for ${nameRef(w.firstName, w.lastName, w.id)} at ${formatCents(item.priceCents)}`, diff: [{ label: "Device", before: "none", after: `${item.name}, ${formatCents(item.priceCents)}, ships to ${shipTo}` }], content: [], moneyCents: item.priceCents, subjectRef: `${w.id}:device`, subjectHash: sha256Hex(canonicalJson({ worker: w.id, sku: item.sku, price: item.priceCents })), evidence: [{ label: "Worker", ref: w.id }] };
  },
  async run(i, ctx, deps) {
    const { w, item, shipTo } = await orderPlan(i, ctx.companyId, deps, ctx.now);
    const o = await deps.sims.devices.order({ workerId: w.id, sku: item.sku, shipTo });
    const id = await deps.newId("dev_");
    await deps.tx.insert(devices).values({ id, workerId: w.id, model: item.name, status: "ordered", orderRef: o.orderRef, priceCents: o.priceCents });
    await completeTaskIf(deps.tx, w.id, "device", ctx.now);
    return {
      data: { device_id: id, worker_id: w.id, order_ref: o.orderRef, eta: o.eta, price_cents: o.priceCents, price_display: formatCents(o.priceCents) },
      summary: `Ordered ${item.name} for ${nameRef(w.firstName, w.lastName, w.id)} at ${formatCents(o.priceCents)} (${o.orderRef})`,
      moneyCents: o.priceCents,
    };
  },
});


const DeliveryInput = z.object({ order_ref: z.string() });
export const recordDelivery = writeCommand({
  name: "it.record_delivery", summary: "System: record a simulated device delivery.",
  description: "System command (svc_events): records the device vendor simulator's delivery of an order by setting the device status to delivered.",
  input: DeliveryInput, domain: "it", needs: "edit", effect: "write", risk: () => "R1", approval: "never", access: "system_only", reversible: false, preview: null,
  async run(i, _ctx, deps) {
    const [d] = await deps.tx.select().from(devices).where(eq(devices.orderRef, i.order_ref)).limit(1);
    if (!d) throw notFound("device order", i.order_ref);
    if (d.status === "ordered" || d.status === "shipped") await deps.tx.update(devices).set({ status: "delivered" }).where(eq(devices.id, d.id));
    return { data: { device_id: d.id, order_ref: i.order_ref, status: "delivered" }, summary: `Device ${d.id} delivered (${i.order_ref})` };
  },
});

export const itWriteCommands: WeftCommand[] = [createAccount, orderDevice, recordDelivery];
