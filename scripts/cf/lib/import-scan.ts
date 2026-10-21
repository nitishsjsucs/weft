// The import scan (docs/cloudflare/design.md 6.4): which of node:fs, node:child_process and node:net a bundle can
// reach from its entry, static and dynamic imports alike, read from the esbuild metafile `wrangler deploy --dry-run
// --metafile` writes. For each forbidden module it returns one import chain, so the report names the file to fix.
export const FORBIDDEN_NODE_MODULES = ["node:fs", "node:child_process", "node:net", "fs", "child_process", "net", "node:fs/promises", "fs/promises"] as const;

export interface Metafile { inputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>; outputs?: Record<string, { entryPoint?: string }> }

export interface ScanResult { entry: string; reachable: { module: string; chain: string[] }[]; inputs: number }

export function scanImports(meta: Metafile, entryMatch: (path: string) => boolean, forbidden: readonly string[] = FORBIDDEN_NODE_MODULES): ScanResult {
  const entry = Object.keys(meta.inputs).find(entryMatch);
  if (!entry) throw new Error("import scan: the entry is not in the metafile");
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const hits = new Map<string, string>();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const imp of meta.inputs[cur]?.imports ?? []) {
      if (forbidden.includes(imp.path)) { if (!hits.has(imp.path)) hits.set(imp.path, cur); continue; }
      if (imp.external || parent.has(imp.path) || !meta.inputs[imp.path]) continue;
      parent.set(imp.path, cur);
      queue.push(imp.path);
    }
  }
  const chainTo = (from: string): string[] => { const out: string[] = []; for (let c: string | null = from; c; c = parent.get(c) ?? null) out.unshift(c); return out; };
  return {
    entry,
    inputs: parent.size,
    reachable: [...hits].map(([module, from]) => ({ module, chain: chainTo(from) })),
  };
}
