// The initial memory content (SPEC 5.6), built from DB rows in one commit: README, the company, one file per sim
// agency (masked account ids), one per worker (no pay amounts), the SUI rate notice procedure and agent preferences.
import { eq } from "drizzle-orm";
import { companies, taxAccounts, workers, type DbTx } from "@weft/db";
import type { MemoryFrontmatter } from "@weft/contracts";
import { renderDoc } from "./store";
import { companyDay } from "./time";

const fm = (id: string, type: MemoryFrontmatter["type"], day: string, extra: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter =>
  ({ id, type, aliases: [], links: [], sources: ["seed"], status: null, updated: day, taintedBy: null, ...extra });
const mask = (s: string | null) => (s ? `${"*".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}` : "not registered");

export async function seedMemoryFiles(db: DbTx, companyId: string, now: string): Promise<{ path: string; text: string }[]> {
  const day = companyDay(now);
  const files: { path: string; text: string }[] = [];
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (c) {
    files.push({ path: `entities/company/${c.id}.md`, text: renderDoc(fm(c.id, "company", day, { aliases: [c.legalName] }),
      `# ${c.legalName}\n\n- Headquarters state ${c.hqState} (${day}, src: seed)\n- Founded ${c.foundedOn} (${day}, src: seed)\n- Domain ${c.domain} (${day}, src: seed)\n`) });
  }
  for (const a of await db.select().from(taxAccounts).where(eq(taxAccounts.companyId, companyId))) {
    files.push({ path: `entities/agencies/${a.agency}-${a.accountType}.md`, text: renderDoc(fm(a.id, "agency", day, { aliases: [a.agency] }),
      `# ${a.agency} ${a.accountType}\n\n- Jurisdiction ${a.jurisdiction} (${day}, src: seed)\n- Status ${a.status} (${day}, src: seed)\n- Account ${mask(a.accountNumber)} (${day}, src: seed)\n`) });
  }
  for (const w of await db.select().from(workers).where(eq(workers.companyId, companyId))) {
    files.push({ path: `entities/people/${w.id}.md`, text: renderDoc(fm(w.id, "person", day, { aliases: [`${w.firstName} ${w.lastName}`] }),
      `# ${w.firstName} ${w.lastName}\n\n- Title ${w.title} (${day}, src: seed)\n- Status ${w.status} (${day}, src: seed)\n- Work state ${w.workState ?? "none"} (${day}, src: seed)\n- Start date ${w.startDate} (${day}, src: seed)\n`) });
  }
  files.push({ path: "knowledge/procedures/state-sui-rate-notice.md", text: renderDoc(fm("proc-state-sui-rate-notice", "procedure", day),
    "# State SUI rate notice\n\n1. Read the notice and its extracted fields.\n2. Check the rate, the effective date and the account against the employer rates table.\n3. Propose `tax.update_rate` with the notice as the source.\n4. Draft the acknowledgement and propose sending it.\n5. Never pay or file anything without an approval.\n") });
  const prefs: [string, string][] = [
    ["autonomy", "# Autonomy\n\nPropose every change to pay, tax and benefits data. Execute drafts and internal notes. Ask before any external effect.\n"],
    ["notifications", "# Notifications\n\nQuiet hours 19:00 to 07:00 Pacific defer digest posts only. Interrupts for deadlines and agency notices.\n"],
    ["drafting", "# Drafting\n\nShort, plain sentences. Cite the action or notice id for every number.\n"],
  ];
  for (const [k, body] of prefs) files.push({ path: `knowledge/preferences/agent/${k}.md`, text: renderDoc(fm(`pref-${k}`, "preference", day), body) });
  return files;
}
