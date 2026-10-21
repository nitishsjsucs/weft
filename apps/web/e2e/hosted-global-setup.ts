// Fails fast when the hosted export is missing or stale (the checks need `_redirects` and `_headers` from a
// WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 build). Owner: cf5-web.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export default function globalSetup(): void {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
  const headers = join(out, "_headers");
  const build = "WEFT_STATIC_EXPORT=1 NEXT_PUBLIC_WEFT_HOSTED=1 pnpm --filter @weft/web build";
  if (!existsSync(headers) || !existsSync(join(out, "_redirects"))) throw new Error(`No hosted export in ${out}: run ${build} first`);
  if (!/hosted=1/.test(readFileSync(headers, "utf8").split("\n")[0] ?? "")) throw new Error(`${out} is not a hosted export: run ${build}`);
}
