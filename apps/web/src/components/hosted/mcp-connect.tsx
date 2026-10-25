"use client";
// The MCP connect dialog (docs/cloudflare/design.md 3.3 and 6.3): mints this lease's MCP key once and shows how to
// point an MCP client at /mcp over Streamable HTTP. The key routes by its prefix to the visitor's own workspace
// and dies with the lease generation; its tools read and propose only (approvals stay in the app). Hosted only.
import { Dialog } from "radix-ui";
import { Check, Copy, Plug } from "lucide-react";
import { useState } from "react";
import { Button } from "@weft/ui/components";
import { HOSTED_PATHS, type McpKeyMint } from "../../../../../packages/contracts/src/ext/cf-hosted";
import { apiFetch } from "@/lib/api/client";
import { useHostedState } from "./use-hosted";

/** The client config an MCP client reads (Streamable HTTP with a bearer key). Exported for tests. */
export function mcpClientConfig(m: Pick<McpKeyMint, "key" | "url">): string {
  return JSON.stringify({ mcpServers: { weft: { type: "http", url: m.url, headers: { Authorization: `Bearer ${m.key}` } } } }, null, 2);
}

/** POST /api/_hosted/mcp-key. Exported for tests. */
export async function mintMcpKey(f: typeof fetch = apiFetch): Promise<McpKeyMint> {
  const res = await f(HOSTED_PATHS.mcpKey, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" });
  const j = (await res.json().catch(() => null)) as (McpKeyMint & { message?: string }) | null;
  if (!res.ok || !j?.key) throw new Error(j?.message ?? res.statusText);
  return j;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="xs" aria-label={done ? "Copied" : label} onClick={() => void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => undefined)}>
      {done ? <Check /> : <Copy />} {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function McpConnectButton({ size = "sm" }: { size?: "xs" | "sm" | "md" }) {
  const s = useHostedState();
  const [open, setOpen] = useState(false);
  const [mint, setMint] = useState<McpKeyMint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leased = s.status?.world === "slot";
  const go = async () => {
    setBusy(true); setError(null);
    try { setMint(await mintMcpKey()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setMint(null); setError(null); } }}>
      <Dialog.Trigger asChild>
        <Button size={size} data-testid="hosted-mcp-open"><Plug /> Connect an MCP client</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/20" />
        <Dialog.Content data-testid="hosted-mcp" className="fixed inset-0 z-[81] m-auto flex h-fit max-h-[85vh] w-[min(560px,calc(100vw-32px))] flex-col gap-3 overflow-y-auto rounded-xl bg-card p-5 text-[13px] shadow-[var(--shadow-modal)] outline-none">
          <Dialog.Title className="text-[14px] font-semibold text-gray-12">Connect an MCP client</Dialog.Title>
          <Dialog.Description className="leading-5 text-gray-11">
            Any MCP client that speaks Streamable HTTP can use Weft's tools on your workspace. The key works until your workspace ends; its tools read and propose, and every change still waits for approval here.
          </Dialog.Description>
          {!leased ? <p className="rounded-lg bg-blue-3 px-3 py-2 text-blue-11">Open your workspace first: the shared workspace has no MCP key.</p> : null}
          {error ? <p role="alert" className="text-red-11">{error}</p> : null}
          {mint ? (
            <div className="flex flex-col gap-2" data-testid="hosted-mcp-key">
              <p className="font-medium text-gray-12">Copy the key now; Weft shows it once.</p>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-md bg-gray-3 px-2 py-1 font-mono text-1">{mint.url}</code><CopyButton text={mint.url} label="Copy the MCP URL" /></div>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-md bg-gray-3 px-2 py-1 font-mono text-1">{mint.key}</code><CopyButton text={mint.key} label="Copy the MCP key" /></div>
              <div className="flex items-start gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-gray-3 px-2 py-1.5 font-mono text-0">{mcpClientConfig(mint)}</pre><CopyButton text={mcpClientConfig(mint)} label="Copy the client config" /></div>
              <p className="text-1 text-gray-10">Expires {new Date(mint.expiresAt).toUTCString()}.</p>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild><Button size="sm">Close</Button></Dialog.Close>
            {mint ? null : <Button size="sm" variant="primary" data-testid="hosted-mcp-mint" disabled={!leased || busy} onClick={() => void go()}>{busy ? "Creating..." : "Create my MCP key"}</Button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
