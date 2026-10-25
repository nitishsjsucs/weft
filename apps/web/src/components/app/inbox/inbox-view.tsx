"use client";
import { useEffect, useRef } from "react";
import { oneOf, useUrlState } from "@/lib/url-state";
import { PAGE_TABS } from "../../../../../../packages/contracts/src/ext/assist";
import { Inbox as InboxIcon } from "lucide-react";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@weft/ui/components";
import { tid, type Proposal } from "@weft/contracts";
import { errorText, useGet } from "@/lib/api/hooks";
import { PageHeader } from "../page";
import { ProposalCard } from "./proposal-card";
import { inboxRows, nextLinkTab, tabParamFor, type LinkTab } from "./inbox-link";
import { HandoffsPanel } from "../compliance/w4-calendar";   // wave 4: hand-off cases for a tax specialist, an HR person or a vendor specialist

function List({ items, empty, failed }: { items: Proposal[] | undefined; empty: string; failed?: boolean }) {
  if (!items) return <div className="text-2 text-gray-10">{failed ? "The Inbox is not available right now." : "Loading..."}</div>;
  if (items.length === 0) return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--app-border)] px-6 py-12 text-center text-2 text-gray-10">
      <InboxIcon className="size-5" strokeWidth={1.5} />{empty}
    </div>
  );
  return <div className="flex flex-col gap-4">{items.map((p) => <ProposalCard key={p.id} p={p} />)}</div>;
}

export function InboxView() {
  const all = useGet("/v1/proposals", { query: { limit: 100 }, refreshMs: 4_000 });
  const [target] = useUrlState("proposal", (v) => /^prp_[0-9]{4,6}$/.test(v));
  // The list holds one page (the lowest ids first), so a proposal the link names past it, such as one a handoff just
  // filed, is fetched on its own and shown in its tab beside the list.
  const inList = !!target && !!all.data?.data.some((p) => p.id === target);
  const one = useGet("/v1/proposals/:id", { params: { id: target ?? "" }, enabled: !!target && !!all.data && !inList, refreshMs: 4_000 });
  const { rows, linked } = inboxRows(all.data?.data, target, one.data);
  const pending = rows?.filter((p) => p.status === "pending" && p.kind !== "suggestion");
  const suggestions = rows?.filter((p) => p.status === "pending" && p.kind === "suggestion");
  const decided = rows?.filter((p) => p.status !== "pending");
  // The tab is in the link (?tab=decided; Approvals when absent). A deep link (/app/inbox?proposal=prp_...) with no tab
  // opens the tab that held the proposal, each time a link names it (nextLinkTab); while one is named, a tab the person
  // picks is written out, Approvals too, so their pick sticks. The card is scrolled to and ringed each time its tab
  // opens for a link.
  const [tabParam, setTabParam] = useUrlState("tab", oneOf(PAGE_TABS.inbox));
  const opened = useRef<LinkTab | null>(null);
  opened.current = nextLinkTab(opened.current, tabParam, target, linked);
  const linkTab = opened.current?.tab ?? null;
  const tab = tabParam ?? linkTab ?? "pending";
  const setTab = (v: string) => setTabParam(tabParamFor(v, target));
  useEffect(() => {
    if (!target || !linkTab) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-testid="${tid.inboxCard(target)}"]`);
      if (el instanceof HTMLElement) { el.scrollIntoView({ block: "center" }); el.classList.add("ring-2", "ring-[var(--blue-9)]", "rounded-xl"); }
    }, 50);
    return () => clearTimeout(t);
  }, [target, linkTab]);
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Inbox" subtitle="Every change the agent, a routine or a person proposes waits here for a decision. Approving re-runs every check on the stored arguments." />
      {all.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(all.error)}</div> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pending">Approvals {pending?.length ? <Badge tone="accent" size="xs">{pending.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="suggestions">Suggestions {suggestions?.length ? <Badge size="xs">{suggestions.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="decided">Decided</TabsTrigger>
          <TabsTrigger value="handoffs">Hand-offs</TabsTrigger>
        </TabsList>
        <TabsContent value="pending"><List items={pending} failed={!!all.error} empty="Nothing waiting for a decision." /></TabsContent>
        <TabsContent value="suggestions"><List items={suggestions} failed={!!all.error} empty="No suggestions right now." /></TabsContent>
        <TabsContent value="decided"><List items={decided} failed={!!all.error} empty="No decisions yet." /></TabsContent>
        <TabsContent value="handoffs"><HandoffsPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
