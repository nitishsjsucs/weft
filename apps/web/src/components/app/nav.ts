import { Banknote, BookOpen, Cable, FlaskConical, Globe, HeartPulse, House, Inbox, Landmark, Laptop, Plane, Receipt, Repeat, ScrollText, Settings, UserMinus, UserPlus, Users, type LucideIcon } from "lucide-react";

export interface NavItem { slug: string; label: string; href: string; icon: LucideIcon; badge?: "inbox" | "simulated" | "soon" }
export interface NavGroup { label: string | null; items: NavItem[] }

// Sidebar per SPEC 11.3. Slugs feed the `nav-<slug>` test ids.
export const NAV: NavGroup[] = [
  { label: null, items: [
    { slug: "home", label: "Home", href: "/app", icon: House },
    { slug: "inbox", label: "Inbox", href: "/app/inbox", icon: Inbox, badge: "inbox" },
    { slug: "payroll", label: "Payroll", href: "/app/payroll", icon: Banknote },
    { slug: "people", label: "People", href: "/app/people", icon: Users },
    { slug: "hiring", label: "Hiring", href: "/app/hiring", icon: UserPlus },   // wave 2: offers and onboarding (w2-onboarding)
    { slug: "offboarding", label: "Offboarding", href: "/app/offboarding", icon: UserMinus },   // wave 2 (w2-offboarding)
  ] },
  { label: "Products", items: [
    { slug: "benefits", label: "Benefits", href: "/app/benefits", icon: HeartPulse, badge: "simulated" },
    { slug: "it", label: "IT", href: "/app/it", icon: Laptop, badge: "simulated" },
    { slug: "contractors", label: "Contractors", href: "/app/contractors", icon: Globe, badge: "simulated" },
    { slug: "expenses", label: "Expenses", href: "/app/expenses", icon: Receipt, badge: "soon" },
    { slug: "time-off", label: "Time Off", href: "/app/time-off", icon: Plane, badge: "soon" },
  ] },
  { label: "Company", items: [
    { slug: "compliance", label: "Taxes & Compliance", href: "/app/compliance", icon: Landmark },
    { slug: "routines", label: "Routines", href: "/app/routines", icon: Repeat },
    { slug: "audit", label: "Audit log", href: "/app/audit", icon: ScrollText },
    { slug: "memory", label: "Memory", href: "/app/memory", icon: BookOpen },
    { slug: "integrations", label: "Integrations", href: "/app/integrations", icon: Cable, badge: "simulated" },   // wave 3 (w3-integrations-hr)
    { slug: "simulators", label: "Simulators", href: "/app/simulators", icon: FlaskConical, badge: "simulated" },
  ] },
];
export const SETTINGS_ITEM: NavItem = { slug: "settings", label: "Settings", href: "/app/settings", icon: Settings };
export const ALL_NAV: NavItem[] = [...NAV.flatMap((g) => g.items), SETTINGS_ITEM];

/** Active nav item for a pathname (longest matching href). */
export function activeNav(pathname: string): NavItem | undefined {
  return ALL_NAV.filter((n) => pathname === n.href || (n.href !== "/app" && pathname.startsWith(`${n.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
}

/** Breadcrumb trail for a pathname: section label, then a record label when deeper. */
export function crumbs(pathname: string): { label: string; href?: string }[] {
  const item = activeNav(pathname);
  if (!item) return [{ label: pathname.startsWith("/app/runs/") ? "Runs" : "Home", href: "/app" }];
  const rest = pathname.slice(item.href.length).split("/").filter(Boolean);
  const out: { label: string; href?: string }[] = [{ label: item.label, href: item.href }];
  if (rest[0]) out.push({ label: decodeURIComponent(rest[0]) });
  return out;
}
