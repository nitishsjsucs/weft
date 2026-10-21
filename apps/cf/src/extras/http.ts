// HostedExtras over HTTP (design 3.1 and 6.3): the front Worker forwards /api/_hosted/{platform,models,help,dictate,
// export/...} to weft-core's CORE service binding with an HMAC'd x-weft-ctx, after its own gates (RL_API for reads;
// the lease, the human grant and RL_MUTATE for dictation). This verifies the ctx and dispatches to the entrypoint's
// RPC methods, so the visitor's slot, generation, visitor id and IP hash come from the signed ctx only. PDFs go to
// the visitor's slot instead (CompanyDO answers /_hosted/pdf/...). It never evaluates @weft/* (design 3.2).
import { HOSTED_PATHS } from "../../../../packages/contracts/src/ext/cf-hosted";
import { readCtx } from "../shared/tokens";
import type { HostedExtrasApi } from "./ports";

/** Dictation clips are at most 30 s of 16 kHz mono PCM WAV (960,044 bytes); bigger bodies are refused unread. */
export const DICTATE_MAX_BYTES = 1024 * 1024;
const EXPORT_PATH = "/api/_hosted/export/";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const refused = (status: number, tag: string, code: string, message: string) => json({ _tag: tag, code, message }, status);

export async function extrasFetch(request: Request, api: HostedExtrasApi, ctxSecret: string): Promise<Response> {
  const checked = await readCtx(ctxSecret, request.headers.get("x-weft-ctx"));
  if (!checked.ok) return refused(401, "Unauthorized", "SESSION_INVALID", "This request did not come through Weft's front door");
  const c = checked.claims;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  if (method === "GET" && path === HOSTED_PATHS.platform) return json(await api.platform());
  if (method === "GET" && path === HOSTED_PATHS.models) {
    const days = Number(url.searchParams.get("days") ?? "7");
    return json(await api.models({ days: Number.isFinite(days) ? days : 7 }));
  }
  if (method === "GET" && path === HOSTED_PATHS.help) {
    const r = await api.help((url.searchParams.get("q") ?? "").slice(0, 500));
    return json(r, !r.ok && r.code === "HELP_DAILY_CAP" ? 429 : 200);
  }
  if (method === "POST" && path === HOSTED_PATHS.dictate) {
    const len = Number(request.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(len) && len > DICTATE_MAX_BYTES) return refused(413, "ValidationError", "DICTATION_TOO_LONG", "Dictation clips are at most 30 seconds");
    const audio = new Uint8Array(await request.arrayBuffer());
    if (audio.byteLength > DICTATE_MAX_BYTES) return refused(413, "ValidationError", "DICTATION_TOO_LONG", "Dictation clips are at most 30 seconds");
    const r = await api.dictate({ audio, contentType: request.headers.get("content-type") ?? "application/octet-stream", slot: c.slot, gen: c.gen, visitor: c.visitor, ipHash: c.ipHash });
    return json(r);
  }
  if (method === "GET" && path.startsWith(EXPORT_PATH)) {
    const [what, jobId] = path.slice(EXPORT_PATH.length).split("/");
    if ((what !== "memory" && what !== "world") || !jobId || !/^[A-Za-z0-9_]{3,64}$/.test(jobId)) return refused(404, "NotFound", "NOT_FOUND", "No such export");
    const file = await api.exportFile({ slot: c.slot, gen: c.gen, jobId, what });
    if (!file) return refused(404, "NotFound", "NOT_FOUND", "That export is not ready or has expired");
    const name = `weft-${c.slot}-g${c.gen}-${what}.${what === "world" ? "json" : "fi"}`;
    return new Response(file.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }
  return refused(404, "NotFound", "NOT_FOUND", "No such hosted route");
}
