// Writes the assets-only wrangler config the hosted checks serve the export with. playwright.hosted.config.ts runs it
// as the first step of its webServer command, so loading the config (in the runner and in every worker) writes
// nothing. Owner: cf5-web.
//
//   node e2e/hosted-wrangler.ts <config path> <assets directory>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [config, assets] = process.argv.slice(2);
if (!config || !assets) throw new Error("usage: node e2e/hosted-wrangler.ts <config path> <assets directory>");
mkdirSync(dirname(config), { recursive: true });
writeFileSync(config, JSON.stringify({
  name: "weft-hosted-web-check",
  compatibility_date: "2026-10-01",
  // The same asset settings as apps/cf/wrangler.front.jsonc (design 9.4), without the Worker.
  assets: { directory: assets, html_handling: "force-trailing-slash", not_found_handling: "404-page" },
}, null, 2));
