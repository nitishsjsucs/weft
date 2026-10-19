// Scaffold (frozen): boot. compose (migrate, agent boot rule), scheduler start, listen on 127.0.0.1 after a port check.
import { createServer } from "node:net";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createWeft } from "./compose";
import { startTracingFromEnv } from "./telemetry";

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

startTracingFromEnv();   // WEFT_TRACE=phoenix only (docs/telemetry.md); unset installs nothing
const weft = await createWeft({ dataDir: resolve(process.env.WEFT_DATA_DIR ?? ".data"), testMode: false });
if (weft.stubs.length) console.error(`weft: stubbed parts (NotImplemented): ${weft.stubs.join(", ")}`);
weft.scheduler.start();
const server = serve({ fetch: weft.app.fetch, hostname: host, port }, (info) => {
  console.log(`weft api listening on http://${host}:${info.port} (provider: ${weft.provider.label}, clock ${weft.clock.now()})`);
});
// The web app's proxy keeps sockets to this server alive between requests. Node closes an idle keep-alive socket
// after 5 s by default, and a request the proxy sends on a socket the server is closing fails with ECONNRESET (a 500
// in the browser). Idle sockets stay open well past the proxy's own idle time instead; headers time out after that.
if ("keepAliveTimeout" in server) {
  (server as { keepAliveTimeout: number }).keepAliveTimeout = 65_000;
  (server as { headersTimeout: number }).headersTimeout = 66_000;
}

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
