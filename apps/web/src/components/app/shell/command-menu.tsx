"use client";
import { Dialog } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@weft/ui";
import { TID } from "@weft/contracts";
import { ALL_NAV } from "../nav";
import { useCan } from "@/lib/api/access";
import { useGet } from "@/lib/api/hooks";
import { period } from "../format";
import { useTour } from "../../tour/tour-provider";
import { HOSTED } from "@/lib/hosted/flags";
import { HELP_MIN_CHARS, helpSummary, searchHelp } from "../../hosted/help-search";
import type { HelpSearchResult } from "../../../../../../packages/contracts/src/ext/cf-extras";

interface Entry { id: string; label: string; hint: string; href: string; run?: () => void; keepOpen?: boolean }

/** Cmd+K: navigation plus record search over people and payroll runs (P0 scope, SPEC 11.3). */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const tour = useTour();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  // Hosted: Help results from AI Search, fetched only when the visitor picks the "Search Weft help" entry.
  const [help, setHelp] = useState<{ q: string; busy: boolean; result: HelpSearchResult | null } | null>(null);
  const workers = useGet("/v1/workers", { query: { limit: 100 }, enabled: open });
  const runs = useGet("/v1/payrolls", { query: { limit: 25 }, enabled: open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onOpenChange(!open); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  useEffect(() => { if (!open) { setQ(""); setSel(0); setHelp(null); } }, [open]);

  const can = useCan();
  const entries = useMemo<Entry[]>(() => {
    const nav: Entry[] = ALL_NAV.filter((n) => !n.domain || can(n.domain)).map((n) => ({ id: `nav-${n.slug}`, label: n.label, hint: "Go to", href: n.href }));
    const ppl: Entry[] = (workers.data?.data ?? []).map((w) => ({ id: w.id, label: w.displayName, hint: `${w.title}, ${w.workState ?? w.country}`, href: `/app/people/${w.id}` }));
    const pay: Entry[] = (runs.data?.data ?? []).map((r) => ({ id: r.id, label: `Payroll ${period(r.periodStart, r.periodEnd)}`, hint: r.status, href: `/app/payroll/${r.id}` }));
    const demo: Entry[] = [{ id: "tour-start", label: "Take the tour", hint: "3 minute walkthrough", href: "/app", run: () => tour.start() }];
    const needle = q.trim().toLowerCase();
    const all = needle ? [...demo, ...nav, ...pay, ...ppl] : [...demo, ...nav];
    const matched = all.filter((e) => !needle || e.label.toLowerCase().includes(needle) || e.id.toLowerCase().includes(needle)).slice(0, 12);
    if (!HOSTED || needle.length < HELP_MIN_CHARS) return matched;
    const term = q.trim();
    const ask: Entry = {
      id: "help-search", label: `Search Weft help for "${term}"`, hint: "Help", href: "", keepOpen: true,
      run: () => { setHelp({ q: term, busy: true, result: null }); void searchHelp(term).then((result) => setHelp({ q: term, busy: false, result })); },
    };
    return [...matched.slice(0, 11), ask];
  }, [q, workers.data, runs.data, tour, can]);

  const go = (e: Entry | undefined) => { if (!e) return; if (e.keepOpen) { e.run?.(); return; } onOpenChange(false); if (e.run) e.run(); else router.push(e.href); };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content className="fixed top-[12vh] left-1/2 z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-xl bg-card shadow-[var(--shadow-modal)] outline-none">
          <Dialog.Title className="sr-only">Search and navigate</Dialog.Title>
          <Dialog.Description className="sr-only">Type to search pages, people and payroll runs</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-3">
            <Search className="size-4 text-gray-10" strokeWidth={1.5} />
            <input
              autoFocus
              data-testid={TID.cmdkInput}
              value={q}
              onChange={(e) => { setQ(e.target.value); setSel(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, entries.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                if (e.key === "Enter") { e.preventDefault(); go(entries[sel]); }
              }}
              placeholder="Search pages, people and payroll runs"
              className="h-11 min-w-0 flex-1 bg-transparent text-2 outline-none placeholder:text-gray-9"
            />
          </div>
          <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {entries.length === 0 ? <li className="px-3 py-6 text-center text-2 text-gray-10">No matches</li> : null}
            {entries.map((e, i) => (
              <li key={e.id} role="option" aria-selected={i === sel}>
                <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(e)} className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-2", i === sel && "bg-gray-3")}>
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  <span className="shrink-0 text-1 text-gray-10">{e.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          {HOSTED && help ? (
            <div data-testid="hosted-help" className="border-t border-[var(--app-border)] p-3 text-[13px]">
              <div className="mb-2 text-1 text-gray-10" role="status">{help.busy ? `Searching Weft help for "${help.q}"...` : help.result ? helpSummary(help.result) : ""}</div>
              {help.result?.ok ? (
                <ul className="flex max-h-[30vh] flex-col gap-2 overflow-y-auto">
                  {help.result.hits.map((h) => (
                    <li key={h.path} data-help-path={h.path} className="rounded-lg bg-gray-2 px-2.5 py-2">
                      <div className="font-medium text-gray-12">{h.title}</div>
                      <div className="mt-0.5 text-1 text-gray-11">{h.snippet}</div>
                      <div className="mt-0.5 font-mono text-0 text-gray-10">{h.path}</div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
