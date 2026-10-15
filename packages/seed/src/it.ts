// Seed step "it" (SPEC 5.6). Owner: t2-world. IdP accounts (google_ws and chat for every employee, github for
// Engineering and Hardware), 48 assigned laptops (P1 view), and the closed chat channels with 6 fictional messages.
import { asc, eq } from "drizzle-orm";
import { devices, itAccounts, simChatMessages, simIdpAccounts, workers } from "@weft/db";
import type { ItSystem } from "@weft/contracts";
import { defaultGroups, GITHUB_DEPARTMENTS, handleFor, newId } from "@weft/core";
import type { SeedContext } from "./context";
import { DEPARTMENTS } from "./company";

export const SEED_CHAT = [
  { channel: "#general", author: "Jordan Pike (demo)", text: "Reminder: the Brooklyn Studio demo day is Thursday. Snacks on the third floor." },
  { channel: "#general", author: "Marcus Bell (demo)", text: "Austin Yard fleet hit 1,000 autonomous pallet moves this week." },
  { channel: "#people-ops", author: "Sam Okafor (demo)", text: "Open enrollment questions can go in this channel." },
  { channel: "#payroll", author: "Theo Marsh (demo)", text: "The Oct 15 payroll settled. Next approval deadline is Wed Oct 28 at 5 pm PT." },
  { channel: "#new-hires", author: "Dana Whitfield (demo)", text: "Welcome Ana and Ben to Larkspur (demo)!" },
  { channel: "#new-hires", author: "Imani Ferreira (demo)", text: "Hardware onboarding buddy list is pinned in the team folder." },
] as const;

export async function seedIt(ctx: SeedContext): Promise<void> {
  const { db } = ctx;
  const now = ctx.clock.now();
  const slug = new Map<string, string>(DEPARTMENTS.map((d) => [d.id, d.slug]));
  const emps = await db.select().from(workers).where(eq(workers.type, "employee")).orderBy(asc(workers.employeeNumber));
  for (const w of emps) {
    const systems: ItSystem[] = ["google_ws", "chat"];
    if ((GITHUB_DEPARTMENTS as readonly string[]).includes(w.departmentId ?? "")) systems.push("github");
    for (const system of systems) {
      const handle = handleFor(system, w.firstName, w.lastName);
      const groups = defaultGroups(system, w.departmentId ? slug.get(w.departmentId) ?? null : null);
      const ref = await newId(db, "simi_");
      await db.insert(simIdpAccounts).values({ id: ref, workerId: w.id, system, handle, groupsJson: JSON.stringify(groups), status: "active", createdAt: now });
      await db.insert(itAccounts).values({ id: await newId(db, "ita_"), workerId: w.id, system, handle, groupsJson: JSON.stringify(groups), status: "active", simRef: ref });
    }
    await db.insert(devices).values({ id: await newId(db, "dev_"), workerId: w.id, model: "Larkspur standard laptop (sim)", status: "assigned", orderRef: null, priceCents: 189_900 });
  }
  for (const m of SEED_CHAT) {
    await db.insert(simChatMessages).values({ id: await newId(db, "simc_"), channel: m.channel, author: m.author, text: m.text, inbound: true, cardJson: null, ts: now });
  }
}
