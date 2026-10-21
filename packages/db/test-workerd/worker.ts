// The conformance Worker (bundled by miniflare.ts): one Durable Object class whose fetch runs a case from cases.ts on
// its own SQLite storage. Each case gets its own object (idFromName), so cases never share a database. A case's
// second event (`deliver`) is a fetch from the object to itself, which workerd queues behind the input gate.
import { CASES, SUBS, messageOf, type CaseHost } from "./cases";

interface Env { CONF: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } } }
interface State { id: unknown; storage: CaseHost["storage"] }

export class Conformance {
  constructor(private readonly state: State, private readonly env: Env) {}
  private host(): CaseHost {
    return {
      storage: this.state.storage,
      platform: "workerd",
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      deliver: async (name) => (await this.env.CONF.get(this.state.id).fetch(`http://conformance/sub/${String(name)}`)).json(),
    };
  }
  async fetch(req: Request): Promise<Response> {
    const [, kind, raw] = new URL(req.url).pathname.split("/");
    const name = decodeURIComponent(raw ?? "");
    try {
      if (kind === "sub") return Response.json(await SUBS[name as keyof typeof SUBS](this.host()));
      const c = CASES.find((x) => x.name === name);
      if (!c) return Response.json({ ok: false, error: `no case ${name}` });
      if (kind === "after") return Response.json({ ok: true, value: await c.after!(this.host()) });
      return Response.json({ ok: true, value: await c.run(this.host()) });
    } catch (e) {
      return Response.json({ ok: false, error: messageOf(e) });
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const object = url.searchParams.get("object") ?? "default";
    return env.CONF.get(env.CONF.idFromName(object)).fetch(req.url);
  },
};
