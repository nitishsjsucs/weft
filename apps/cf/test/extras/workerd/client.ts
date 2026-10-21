// The front Worker stand-in for the extras' workerd test (track cf6-extras): it calls HostedExtras over a service
// binding to the named entrypoint, as the real front does for /api/_hosted/*.
import type { HostedExtrasApi } from "../../../src/extras/ports";

interface Env { CORE: HostedExtrasApi; AI_FAKE: { calls(): Promise<{ ai: number; search: number }> } }

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/help": return Response.json(await env.CORE.help(url.searchParams.get("q") ?? ""));
      case "/platform": return Response.json(await env.CORE.platform());
      case "/models": return Response.json(await env.CORE.models({ days: 7 }));
      case "/record": { await env.CORE.recordRun(await req.json()); return Response.json({ ok: true }); }
      case "/dictate": return Response.json(await env.CORE.dictate({ audio: new Uint8Array(await req.arrayBuffer()), contentType: "audio/wav", slot: "slot-1", gen: 1, visitor: "v_1", ipHash: "ip_1" }));
      case "/calls": return Response.json(await env.AI_FAKE.calls());
      default: return new Response("not found", { status: 404 });
    }
  },
};
