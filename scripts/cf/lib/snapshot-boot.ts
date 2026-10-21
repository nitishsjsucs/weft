// Child process of pnpm cf:snapshot: boots the seeded world once on Node (so the routine definitions and every other
// boot-time row already match the code; design 4.4), runs one scheduler tick, and prints what the manifest records
// beside cf1's digests as one JSON line: the world digest (db:digest), the action chain head, the memory HEAD and the
// public stats the landing page renders first. It prints no secret. WEFT_DATA_DIR and the hosted switches come from
// the parent's environment for this process only.
import { createWeft } from "../../../apps/api/src/compose";
import { digestDb } from "../../../packages/seed/src/index";

const dataDir = process.env.WEFT_DATA_DIR;
if (!dataDir) throw new Error("snapshot-boot: WEFT_DATA_DIR is not set");

const weft = await createWeft({ dataDir });
try {
  await weft.scheduler.tick();
  const stats = await (await weft.app.request("http://127.0.0.1:4070/v1/stats", { headers: { host: "127.0.0.1:4070" } })).json();
  const worldDigest = await digestDb(weft.db as never);
  const client = (weft.db as unknown as { $client: { execute(q: string): Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const head = await client.execute("SELECT hash FROM actions ORDER BY seq DESC LIMIT 1");
  let memoryHead: string | null = null;
  try { memoryHead = ((await client.execute("SELECT sha FROM mem_refs WHERE name = 'refs/heads/main'")).rows[0]?.sha as string | undefined) ?? null; } catch { memoryHead = null; }
  console.log(JSON.stringify({ worldDigest, chainHead: (head.rows[0]?.hash as string | undefined) ?? null, memoryHead, stats }));
} finally {
  await weft.close();
}
