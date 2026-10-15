// Scaffold (frozen): boot. compose (migrate, agent boot rule), scheduler start, listen on 127.0.0.1 after a port check.
import { createServer } from "node:net";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createWeft } from "./compose";

const port = Number(process.env.WEFT_API_PORT ?? 4070);
const host = "127.0.0.1";

function portFree(p: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(p, host, () => s.close(() => ok(true)));
  });
}

if (!(await portFree(port))) {
  console.error(`port ${port} is in use on ${host}; set WEFT_API_PORT or stop the other server`);
  process.exit(1);
}

const weft = await createWeft({ dataDir: resolve(process.env.WEFT_DATA_DIR ?? ".data"), testMode: false });
if (weft.stubs.length) console.error(`weft: stubbed parts (NotImplemented): ${weft.stubs.join(", ")}`);
weft.scheduler.start();
const server = serve({ fetch: weft.app.fetch, hostname: host, port }, (info) => {
  console.log(`weft api listening on http://${host}:${info.port} (provider: ${weft.provider.label}, clock ${weft.clock.now()})`);
});

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  console.log(`weft api: ${sig}, shutting down`);
  server.close();
  await weft.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
