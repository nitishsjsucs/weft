// pnpm cf:help-corpus: builds the Help search corpus (design 7.1 and 9.1; track cf6-extras) from Weft's own
// visitor-facing docs (HELP_CORPUS in packages/cf-extras/src/help.ts) and, with --upload, puts it in R2 `weft-files`
// under `help/`, where AI Search `weft-help` indexes it.
//
//   pnpm cf:help-corpus                 build into .scratch/cf-help/ and print what would be uploaded
//   pnpm cf:help-corpus --out <dir>     build into <dir>
//   pnpm cf:help-corpus --upload        build, then upload each file with wrangler through scripts/cf/with-cf.sh
//
// Only the Deploy stage runs --upload: it is the one path here that calls the Cloudflare API, and it does so through
// with-cf.sh, which loads the account token into the wrangler child process only (never printed). The build refuses a
// doc that holds a secret-shaped string, and every file names the doc it came from.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { buildHelpCorpus, HELP_CORPUS } from "../../packages/cf-extras/src/help";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUCKET = "weft-files";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const out = resolve(ROOT, value("--out") ?? join(".scratch", "cf-help"));
const read = (source: string) => { const p = join(ROOT, source); return existsSync(p) ? readFileSync(p, "utf8") : null; };
const files = buildHelpCorpus(read, HELP_CORPUS);

rmSync(join(out, "help"), { recursive: true, force: true });
for (const f of files) {
  const p = join(out, f.key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.body);
}
const manifest = { bucket: BUCKET, prefix: "help/", files: files.map((f) => ({ key: f.key, title: f.title, source: f.source, bytes: f.bytes })) };
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const total = files.reduce((a, f) => a + f.bytes, 0);
console.log(`help corpus: ${files.length} files, ${total} bytes in ${relative(ROOT, out) || "."}`);
for (const f of files) console.log(`  ${f.key}  ${f.bytes} bytes  (${f.source})`);

if (flag("--upload")) {
  const withCf = join(ROOT, "scripts", "cf", "with-cf.sh");
  if (!existsSync(withCf)) {
    console.error("help corpus: scripts/cf/with-cf.sh is not built yet (track cf4-worker); nothing was uploaded");
    process.exit(1);
  }
  for (const f of files) {
    execFileSync(withCf, ["pnpm", "exec", "wrangler", "r2", "object", "put", `${BUCKET}/${f.key}`, "--file", join(out, f.key), "--content-type", "text/markdown; charset=utf-8", "--remote"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    console.log(`  uploaded ${BUCKET}/${f.key}`);
  }
  console.log("help corpus: uploaded; AI Search weft-help indexes help/ on its next sync");
} else {
  console.log("help corpus: not uploaded (pass --upload in the Deploy stage)");
}
