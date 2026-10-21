// Child process of pnpm cf:snapshot: boots the seeded world once on Node (so the routine definitions and every other
// boot-time row already match the code; design 4.4), runs one scheduler tick, revokes the seeded API keys (their
// plaintexts sit in the data dir, and a hosted world takes keys only from its own lease), and prints what the
// manifest records beside cf1's digests as one JSON line: the world digest (db:digest), the action chain head, the
// memory HEAD with the SQL repo's object and commit counts, and the public stats the landing page renders first. It
// prints no secret. WEFT_DATA_DIR and the hosted switches come from the parent's environment for this process only.
import { createWeft } from "../../../apps/api/src/compose";
import { digestDb } from "../../../packages/seed/src/index";
import { MEMORY_MAIN_REF } from "../../../packages/contracts/src/ext/cf-memory";

const dataDir = process.env.WEFT_DATA_DIR;
if (!dataDir) throw new Error("snapshot-boot: WEFT_DATA_DIR is not set");

const weft = await createWeft({ dataDir });
try {
  await weft.scheduler.tick();
  const client = (weft.db as unknown as { $client: { execute(q: string | { sql: string; args: unknown[] }): Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  // Revoked before the digest is taken, so the manifest's world digest is the world every slot restores.
  await client.execute({ sql: "UPDATE api_keys SET revoked_at = ? WHERE revoked_at IS NULL", args: [weft.clock.now()] });
  const stats = await (await weft.app.request("http://127.0.0.1:4070/v1/stats", { headers: { host: "127.0.0.1:4070" } })).json();
  const worldDigest = await digestDb(weft.db as never);
  const head = await client.execute("SELECT hash FROM actions ORDER BY seq DESC LIMIT 1");
  // The company memory in the SQL repo (WEFT_MEMORY=sqlite): its HEAD and how many objects and commits it holds. A
  // failed read is an error, never "no memory": pnpm cf:snapshot refuses a snapshot without it.
  const memoryHead = ((await client.execute(`SELECT sha FROM mem_refs WHERE name = '${MEMORY_MAIN_REF}'`)).rows[0]?.sha as string | undefined) ?? null;
  const count = async (t: string) => Number((await client.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]?.n ?? 0);
  const memory = { objects: await count("mem_objects"), commits: await count("mem_log"), refs: await count("mem_refs") };
  console.log(JSON.stringify({ worldDigest, chainHead: (head.rows[0]?.hash as string | undefined) ?? null, memoryHead, memory, stats }));
} finally {
  await weft.close();
}
