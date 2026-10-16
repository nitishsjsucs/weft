"use client";
// Read-only memory browser (harness 18 item 7, w2-memory): the folder tree, a file view with rendered wiki-links
// and backlinks, and the git log of the file with its diffs. Memory is written only by the executor; this screen
// never writes. Uses the same /api proxy and "Viewing as" principal as the typed client.
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileText, GitCommitHorizontal, Link2, Search } from "lucide-react";
import { Badge, Card } from "@weft/ui/components";
import { cn } from "@weft/ui";
import { getPrincipal, rawFetch, usePrincipal } from "@/lib/api/hooks";
import { PageHeader } from "../page";
import { fmtDateTime } from "../format";

interface Frontmatter { id: string; type: string; aliases: string[]; links: string[]; sources: string[]; updated: string; taintedBy: string | null }
interface Links { outgoing: { target: string; path: string; resolved: boolean }[]; backlinks: string[] }
interface MemoryFile { path: string; frontmatter: Frontmatter; body: string; links?: Links }
interface HistoryEntry { commit: string; date: string; author: string; subject: string; diff: string }

const FOLDERS = ["knowledge", "entities", "timeline", "workstreams", "comms"] as const;
const LINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

function useJson<T>(url: string | null): { data: T | null; error: string | null; loading: boolean } {
  const who = usePrincipal();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!url });
  useEffect(() => {
    if (!url) { setState({ data: null, error: null, loading: false }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    rawFetch(`/api${url}`, { headers: { accept: "application/json", "x-weft-principal": getPrincipal() }, signal: ctrl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error((body as { message?: string } | null)?.message ?? `Request failed (${r.status})`);
        setState({ data: body as T, error: null, loading: false });
      })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }); });
    return () => ctrl.abort();
  }, [url, who]);
  return state;
}

/** One body line with [[target|label]] rendered as buttons that open the target file. */
function Line({ text, onOpen, resolved }: { text: string; onOpen: (path: string) => void; resolved: (path: string) => boolean }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const path = `${m[1]!.trim()}.md`;
    const ok = resolved(path);
    parts.push(
      <button key={at} type="button" data-testid="memory-wikilink" data-target={path} data-resolved={ok} onClick={() => ok && onOpen(path)}
        className={cn("rounded px-0.5 font-medium", ok ? "text-blue-11 hover:bg-blue-3" : "cursor-not-allowed text-gray-10 line-through decoration-dotted")}
        title={ok ? `Open ${path}` : `${path} does not exist yet`}>
        {m[2] ?? m[1]!.split("/").pop()}
      </button>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  if (text.startsWith("# ")) return <h2 className="mb-2 mt-1 text-4 font-semibold">{text.slice(2)}</h2>;
  if (text.startsWith("## ")) return <h3 className="mb-1 mt-4 text-2 font-semibold text-gray-12">{text.slice(3)}</h3>;
  if (text.trim() === "") return <div className="h-2" aria-hidden />;
  if (text.startsWith("- ")) {
    if (typeof parts[0] === "string") parts[0] = parts[0].slice(2);
    return <div className="relative whitespace-pre-wrap break-words pl-4 before:absolute before:left-1 before:top-[0.6em] before:size-1 before:rounded-full before:bg-gray-9">{parts}</div>;
  }
  return <div className="whitespace-pre-wrap break-words">{parts}</div>;
}

function Tree({ paths, current, onOpen }: { paths: string[]; current: string | null; onOpen: (p: string) => void }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ knowledge: true, entities: false, timeline: false, workstreams: true, comms: false });
  const shown = paths.filter((p) => !filter || p.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Card className="p-3" data-testid="memory-tree">
      <label className="mb-3 flex items-center gap-2 rounded-md bg-gray-2 px-2 py-1.5 text-1">
        <Search className="size-3.5 text-gray-10" aria-hidden />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter memory files" className="w-full bg-transparent outline-none" />
      </label>
      {FOLDERS.map((f) => {
        const files = shown.filter((p) => p.startsWith(`${f}/`));
        const expanded = (open[f] ?? false) || (filter !== "" && files.length > 0) || (current?.startsWith(`${f}/`) ?? false);
        return (
          <div key={f} className="mb-1">
            <button type="button" onClick={() => setOpen((o) => ({ ...o, [f]: !o[f] }))} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-1 font-medium hover:bg-gray-3" aria-expanded={expanded}>
              <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden />
              {f}/ <span className="ml-auto tabular text-gray-10">{files.length}</span>
            </button>
            {expanded ? (
              <ul className="ml-4 max-h-[340px] overflow-y-auto">
                {files.map((p) => (
                  <li key={p}>
                    <button type="button" data-testid="memory-tree-file" data-path={p} onClick={() => onOpen(p)}
                      className={cn("w-full truncate rounded px-1 py-0.5 text-left font-mono text-[12px] hover:bg-gray-3", current === p && "bg-blue-3 text-blue-11")} title={p}>
                      {p.slice(f.length + 1)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </Card>
  );
}

function History({ path }: { path: string }) {
  const h = useJson<HistoryEntry[]>(`/v1/memory/history?path=${encodeURIComponent(path)}&limit=20`);
  const [openSha, setOpenSha] = useState<string | null>(null);
  return (
    <Card className="p-4" data-testid="memory-history">
      <h3 className="mb-2 flex items-center gap-1.5 text-2 font-semibold"><GitCommitHorizontal className="size-4" aria-hidden /> History</h3>
      {h.error ? <div className="text-1 text-red-11">{h.error}</div> : null}
      <ul className="divide-y divide-gray-4">
        {(h.data ?? []).map((c) => (
          <li key={c.commit} className="py-2">
            <button type="button" className="w-full text-left" onClick={() => setOpenSha((s) => (s === c.commit ? null : c.commit))} aria-expanded={openSha === c.commit} data-testid="memory-history-entry">
              <div className="truncate text-1 font-medium">{c.subject}</div>
              <div className="text-0 text-gray-10"><code className="font-mono">{c.commit.slice(0, 10)}</code> by {c.author}, {fmtDateTime(c.date)}</div>
            </button>
            {openSha === c.commit ? <pre className="mt-2 max-h-[320px] overflow-auto rounded-md bg-gray-2 p-2 font-mono text-[11px] leading-snug">{c.diff.split("\n").map((l, i) => (
              <div key={i} className={cn(l.startsWith("+") && !l.startsWith("+++") && "text-green-11", l.startsWith("-") && !l.startsWith("---") && "text-red-11")}>{l || " "}</div>
            ))}</pre> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function MemoryView() {
  const tree = useJson<string[]>("/v1/memory/tree");
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (current || !tree.data) return;
    const fromHash = typeof window !== "undefined" ? decodeURIComponent(window.location.hash.slice(1)) : "";
    setCurrent(fromHash && tree.data.includes(fromHash) ? fromHash : tree.data.includes("knowledge/company/one-pager.md") ? "knowledge/company/one-pager.md" : (tree.data.find((p) => p.startsWith("knowledge/")) ?? tree.data[0] ?? null));
  }, [tree.data, current]);
  useEffect(() => {
    const onHash = () => { const p = decodeURIComponent(window.location.hash.slice(1)); if (p) setCurrent(p); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const open = (p: string) => { setCurrent(p); try { window.history.replaceState(null, "", `#${encodeURIComponent(p)}`); } catch { /* ignore */ } };
  const file = useJson<MemoryFile>(current ? `/v1/memory/file?path=${encodeURIComponent(current)}` : null);
  const known = useMemo(() => new Set(tree.data ?? []), [tree.data]);
  const f = file.data;
  const body = f ? f.body.split("\n") : [];
  const backlinkAt = body.indexOf("## Backlinks");
  const content = backlinkAt >= 0 ? body.slice(0, backlinkAt) : body;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 tablet:px-8 tablet:py-8">
      <PageHeader title="Memory" subtitle="The company memory the agent reads: Markdown in a git repo, facts in entities and knowledge, events in the timeline. Read-only here; the executor is the only writer." />
      {tree.error ? <div role="alert" className="mb-4 rounded-lg bg-red-3 px-3 py-2 text-1 text-red-11">{tree.error}</div> : null}
      <div className="grid gap-4 laptop:grid-cols-[300px_minmax(0,1fr)]">
        <Tree paths={tree.data ?? []} current={current} onOpen={open} />
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="p-4" data-testid="memory-file" data-path={current ?? ""}>
            {file.error ? <div className="text-1 text-red-11">{file.error}</div> : null}
            {!f && !file.error ? <div className="text-1 text-gray-10">{file.loading ? "Loading..." : "Pick a file."}</div> : null}
            {f ? (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <FileText className="size-4 text-gray-10" aria-hidden />
                  <code className="font-mono text-1">{f.path}</code>
                  <Badge tone="outline">{f.frontmatter.type}</Badge>
                  {f.frontmatter.updated ? <Badge tone="gray">updated {f.frontmatter.updated}</Badge> : null}
                  {f.frontmatter.taintedBy ? <Badge tone="amber" data-testid="memory-tainted">untrusted: {f.frontmatter.taintedBy}</Badge> : null}
                </div>
                <div className="text-2 leading-relaxed">{content.map((l, i) => <Line key={i} text={l} onOpen={open} resolved={(p) => known.has(p)} />)}</div>
              </>
            ) : null}
          </Card>
          {f ? (
            <Card className="p-4" data-testid="memory-backlinks">
              <h3 className="mb-2 flex items-center gap-1.5 text-2 font-semibold"><Link2 className="size-4" aria-hidden /> Backlinks</h3>
              {(f.links?.backlinks ?? []).length === 0 ? <div className="text-1 text-gray-10">No file links here yet.</div> : (
                <ul className="flex flex-wrap gap-1.5">
                  {f.links!.backlinks.map((p) => (
                    <li key={p}><button type="button" onClick={() => open(p)} className="rounded-md bg-gray-3 px-2 py-0.5 font-mono text-[12px] hover:bg-blue-3 hover:text-blue-11" data-testid="memory-backlink">{p}</button></li>
                  ))}
                </ul>
              )}
              {(f.links?.outgoing ?? []).some((o) => !o.resolved) ? <div className="mt-2 text-0 text-gray-10">Struck-through links point at files that do not exist yet.</div> : null}
            </Card>
          ) : null}
          {current ? <History key={current} path={current} /> : null}
        </div>
      </div>
    </div>
  );
}
