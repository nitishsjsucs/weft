"use client";
import { Inbox as InboxIcon } from "lucide-react";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@weft/ui/components";
import type { Proposal } from "@weft/contracts";
import { errorText, useGet } from "@/lib/api/hooks";
import { PageHeader } from "../page";
import { ProposalCard } from "./proposal-card";

function List({ items, empty }: { items: Proposal[] | undefined; empty: string }) {
  if (!items) return <div className="text-2 text-gray-10">Loading...</div>;
  if (items.length === 0) return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--app-border)] px-6 py-12 text-center text-2 text-gray-10">
      <InboxIcon className="size-5" strokeWidth={1.5} />{empty}
    </div>
  );
  return <div className="flex flex-col gap-4">{items.map((p) => <ProposalCard key={p.id} p={p} />)}</div>;
}

export function InboxView() {
  const all = useGet("/v1/proposals", { query: { limit: 100 }, refreshMs: 4_000 });
  const rows = all.data?.data;
  const pending = rows?.filter((p) => p.status === "pending" && p.kind !== "suggestion");
  const suggestions = rows?.filter((p) => p.status === "pending" && p.kind === "suggestion");
  const decided = rows?.filter((p) => p.status !== "pending");
  return (
    <div className="mx-auto w-full max-w-[880px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Inbox" subtitle="Everything the agent wants to change waits here for a person. Approving re-runs every check on the stored arguments." />
      {all.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{errorText(all.error)}</div> : null}
      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Approvals {pending?.length ? <Badge tone="accent" size="xs">{pending.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="suggestions">Suggestions {suggestions?.length ? <Badge size="xs">{suggestions.length}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="decided">Decided</TabsTrigger>
        </TabsList>
        <TabsContent value="pending"><List items={pending} empty="Nothing waiting for a decision." /></TabsContent>
        <TabsContent value="suggestions"><List items={suggestions} empty="No suggestions right now." /></TabsContent>
        <TabsContent value="decided"><List items={decided} empty="No decisions yet." /></TabsContent>
      </Tabs>
    </div>
  );
}
