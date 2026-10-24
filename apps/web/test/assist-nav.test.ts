// The cursor assistant's nav registry (packages/contracts/src/ext/assist.ts ASSIST_NAV) is the sidebar (nav.ts) plus
// Settings and Permissions: the same slugs, labels, hrefs, the hosted pages flagged hosted and the grant-gated ones
// with their grant. A page added, renamed or moved in one list and not the other fails here, not in production, where
// checkRoute would refuse the new page and #nav-<slug> would point at nothing.
import { describe, expect, it } from "vitest";
import { ASSIST_NAV } from "../../../packages/contracts/src/ext/assist";
import { HOSTED_NAV_ITEMS, navGroups, SETTINGS_ITEM } from "../src/components/app/nav";

const shape = (n: { slug: string; label: string; href: string; domain?: string }) => ({ slug: n.slug, label: n.label, href: n.href, domain: n.domain ?? null });

describe("ASSIST_NAV", () => {
  it("is the sidebar, hosted pages flagged, then Settings, plus Permissions only", () => {
    const base = [...navGroups(false).flatMap((g) => g.items), SETTINGS_ITEM].map(shape);
    const hosted = HOSTED_NAV_ITEMS.map(shape);
    const assist = ASSIST_NAV.filter((n) => n.slug !== "permissions");
    expect(assist.filter((n) => !n.hosted).map(shape)).toEqual(base);
    expect(assist.filter((n) => n.hosted).map(shape)).toEqual(hosted);
    expect(navGroups(true).flatMap((g) => g.items).map((n) => n.slug)).toEqual(assist.filter((n) => n.slug !== "settings").map((n) => n.slug));
    expect(ASSIST_NAV.filter((n) => !base.some((b) => b.slug === n.slug) && !hosted.some((h) => h.slug === n.slug)).map((n) => n.href)).toEqual(["/app/settings/permissions"]);
  });
});
