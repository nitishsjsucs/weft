// The import scan (docs/cloudflare/design.md 6.4): which of node:fs, node:child_process and node:net a bundle can
// reach from its entry, static and dynamic imports alike, read from the esbuild metafile `wrangler deploy --dry-run
// --metafile` writes. For each forbidden module it returns one import chain, so the report names the file to fix.
export const FORBIDDEN_NODE_MODULES = ["node:fs", "node:child_process", "node:net", "fs", "child_process", "net", "node:fs/promises", "fs/promises"] as const;

export interface Metafile { inputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>; outputs?: Record<string, { entryPoint?: string }> }

/**
 * Reaches that are not Weft code touching the disk, each checked by hand and named: a forbidden module imported only
 * by a guarded dynamic import inside a third-party Workers library, on a code path Weft never takes.
 */
export interface AllowedReach { module: string; importer: RegExp; kind: "dynamic-import"; reason: string }
export const ALLOWED_REACH: readonly AllowedReach[] = [{
  module: "fs/promises",
  importer: /@cloudflare\/puppeteer\/lib\/esm\/puppeteer\/common\/util\.js$/,
  kind: "dynamic-import",
  reason: "@cloudflare/puppeteer's importFSPromises(): a try/catch dynamic import for writing a PDF or screenshot to a file path, which the PDF renderer never passes",
}];
const allowedReach = (module: string, importer: string, kind: string, allowed: readonly AllowedReach[]) =>
  allowed.some((a) => a.module === module && a.kind === kind && a.importer.test(importer));

export interface ScanResult { entry: string; reachable: { module: string; chain: string[] }[]; inputs: number }

export function scanImports(meta: Metafile, entryMatch: (path: string) => boolean, forbidden: readonly string[] = FORBIDDEN_NODE_MODULES, allowed: readonly AllowedReach[] = ALLOWED_REACH): ScanResult {
  const entry = Object.keys(meta.inputs).find(entryMatch);
  if (!entry) throw new Error("import scan: the entry is not in the metafile");
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const hits = new Map<string, string>();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const imp of meta.inputs[cur]?.imports ?? []) {
      if (forbidden.includes(imp.path)) { if (!hits.has(imp.path) && !allowedReach(imp.path, cur, imp.kind, allowed)) hits.set(imp.path, cur); continue; }
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
