import { Banknote, BookOpen, Cable, ChartColumn, FlaskConical, Gauge, Globe, HeartPulse, House, Inbox, Landmark, Laptop, Plane, Receipt, Repeat, Scale, ScrollText, Settings, UserMinus, UserPlus, Users, type LucideIcon } from "lucide-react";
import { HOSTED } from "@/lib/hosted/flags";

/** `domain`: the grant a section reads; a person whose grants close it (a manager: payroll, benefits, IT) does not see the item. */
export interface NavItem { slug: string; label: string; href: string; icon: LucideIcon; badge?: "inbox" | "simulated"; domain?: "payroll" | "benefits" | "it" }
export interface NavGroup { label: string | null; items: NavItem[] }

// Sidebar per SPEC 11.3. Slugs feed the `nav-<slug>` test ids.
const BASE_NAV: NavGroup[] = [
  { label: null, items: [
    { slug: "home", label: "Home", href: "/app", icon: House },
    { slug: "inbox", label: "Inbox", href: "/app/inbox", icon: Inbox, badge: "inbox" },
    { slug: "payroll", label: "Payroll", href: "/app/payroll", icon: Banknote, domain: "payroll" },
    { slug: "people", label: "People", href: "/app/people", icon: Users },
    { slug: "hiring", label: "Hiring", href: "/app/hiring", icon: UserPlus },   // wave 2: offers and onboarding (w2-onboarding)
    { slug: "offboarding", label: "Offboarding", href: "/app/offboarding", icon: UserMinus },   // wave 2 (w2-offboarding)
  ] },
  { label: "Products", items: [
    { slug: "benefits", label: "Benefits", href: "/app/benefits", icon: HeartPulse, badge: "simulated", domain: "benefits" },
    { slug: "it", label: "IT", href: "/app/it", icon: Laptop, badge: "simulated", domain: "it" },
    { slug: "contractors", label: "Contractors", href: "/app/contractors", icon: Globe, badge: "simulated", domain: "payroll" },   // contractor pay
    { slug: "expenses", label: "Expenses", href: "/app/expenses", icon: Receipt },
    { slug: "time-off", label: "Time Off", href: "/app/time-off", icon: Plane },
  ] },
  { label: "Company", items: [
    { slug: "compliance", label: "Taxes & Compliance", href: "/app/compliance", icon: Landmark },
    { slug: "reports", label: "Reports", href: "/app/reports", icon: ChartColumn },   // wave 4 (w4-parity-admin)
    { slug: "routines", label: "Routines", href: "/app/routines", icon: Repeat },
    { slug: "audit", label: "Audit log", href: "/app/audit", icon: ScrollText },
    { slug: "memory", label: "Memory", href: "/app/memory", icon: BookOpen },
    { slug: "integrations", label: "Integrations", href: "/app/integrations", icon: Cable, badge: "simulated" },   // wave 3 (w3-integrations-hr)
    { slug: "simulators", label: "Simulators", href: "/app/simulators", icon: FlaskConical, badge: "simulated" },
  ] },
];
/** Hosted only (Weft on Cloudflare, docs/cloudflare/design.md 10): the Platform readout and the model comparison. */
export const HOSTED_NAV_ITEMS: NavItem[] = [
  { slug: "platform", label: "Platform", href: "/app/platform", icon: Gauge },
  { slug: "models", label: "Model comparison", href: "/app/models", icon: Scale },
];
/** The sidebar groups: on the hosted build the Company group ends with the hosted pages; on Node it is unchanged. */
export function navGroups(hosted: boolean): NavGroup[] {
  if (!hosted) return BASE_NAV;
  return BASE_NAV.map((g) => (g.label === "Company" ? { ...g, items: [...g.items, ...HOSTED_NAV_ITEMS] } : g));
}
export const NAV: NavGroup[] = navGroups(HOSTED);
export const SETTINGS_ITEM: NavItem = { slug: "settings", label: "Settings", href: "/app/settings", icon: Settings };
export const ALL_NAV: NavItem[] = [...NAV.flatMap((g) => g.items), SETTINGS_ITEM];

/** Active nav item for a pathname (longest matching href). */
export function activeNav(pathname: string): NavItem | undefined {
  return ALL_NAV.filter((n) => pathname === n.href || (n.href !== "/app" && pathname.startsWith(`${n.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
}

export interface Crumb { label: string; href?: string; /** a raw record id shown while its title loads */ id?: boolean }

/**
 * Breadcrumb trail for a pathname: section label, then a record crumb when deeper. A detail view registers its title
 * (shell/crumbs.tsx) and the record crumb reads it; until then the crumb is the raw id, marked so the bar can set it
 * in a small mono face.
 */
export function crumbs(pathname: string, recordTitle?: string | null): Crumb[] {
  const item = activeNav(pathname);
  if (!item) {
    const run = pathname.match(/^\/app\/runs\/([^/]+)/);
    if (run) return recordTitle ? [{ label: "Runs", href: "/app" }, { label: recordTitle }] : [{ label: "Runs", href: "/app" }];
    return [{ label: "Home", href: "/app" }];
  }
  const rest = pathname.slice(item.href.length).split("/").filter(Boolean);
  const out: Crumb[] = [{ label: item.label, href: item.href }];
  if (rest[0]) out.push(recordTitle ? { label: recordTitle } : { label: decodeURIComponent(rest[0]), id: true });
  return out;
}
