// The conformance Worker (bundled by miniflare.ts): one Durable Object class whose fetch runs a case from cases.ts on
// its own SQLite storage. Each case gets its own object (idFromName), so cases never share a database. A case's
// second event (`deliver`) is a fetch from the object to itself, which workerd queues behind the input gate.
import { CASES, SUBS, messageOf, type CaseHost } from "./cases";
import { beginRestore, deltaReset, finishRestore, restoreChunks, snapshotFromJson, snapshotToJson, verifyAgainstManifest, type SeedRows, type SnapshotChunk, type SnapshotManifest } from "../src/snapshot";
import type { MigrationEntry } from "../src/migrations";

interface Env { CONF: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } } }
interface State { id: unknown; storage: CaseHost["storage"] }

export class Conformance {
  constructor(private readonly state: State, private readonly env: Env) {}
  private host(): CaseHost {
    return {
      storage: this.state.storage,
      platform: "workerd",
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      deliver: async (name) => (await (this.env.CONF.get(this.state.id) as unknown as { fetch(u: string): Promise<Response> }).fetch(`http://conformance/sub/${String(name)}`)).json(),
    };
  }
  /** The recorded-session steps: a full restore in steps (as the Workflow runs it), replays and delta resets. */
  private async session(step: string, body: unknown): Promise<unknown> {
    const s = this.state.storage;
    if (step === "begin") {
      const b = body as { manifest: SnapshotManifest; migrations: MigrationEntry[]; journalHash: string };
      await s.deleteAll();
      return beginRestore(s, { manifest: b.manifest }, b.migrations, b.journalHash);
    }
    if (step === "chunks") return restoreChunks(s, body as SnapshotChunk[]);
    if (step === "finish") {
      const b = body as { manifest: SnapshotManifest; triggers: { sql: string }[] };
      return finishRestore(s, { manifest: b.manifest }, b.triggers);
    }
    if (step === "replay") {
      const writes = body as { sql: string; args: unknown[] }[];
      let rowsWritten = 0;
      s.transactionSync(() => {
        s.sql.exec("PRAGMA defer_foreign_keys = ON");
        for (const w of writes) { const c = s.sql.exec(w.sql, ...w.args); c.toArray(); rowsWritten += c.rowsWritten; }
      });
      return { statements: writes.length, rowsWritten };
    }
    if (step === "reset") {
      const b = body as { manifest: SnapshotManifest; seed: SeedRows };
      const out = deltaReset(s, b);
      return { ...out, mismatched: verifyAgainstManifest(s, b.manifest).mismatched };
    }
    throw new Error(`no session step ${step}`);
  }

  async fetch(req: Request): Promise<Response> {
    const [, kind, raw] = new URL(req.url).pathname.split("/");
    const name = decodeURIComponent(raw ?? "");
    try {
      if (kind === "session") return new Response(snapshotToJson({ ok: true, value: await this.session(name, snapshotFromJson(await req.text())) }), { headers: { "content-type": "application/json" } });
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
    const stub = env.CONF.get(env.CONF.idFromName(object)) as unknown as { fetch(r: Request): Promise<Response> };
    return stub.fetch(new Request(req.url, { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
  },
};
