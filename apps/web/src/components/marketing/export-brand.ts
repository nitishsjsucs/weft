// Writes the static brand files in apps/web/public/brand/ from art.ts. Run from the repo root:
//   pnpm exec tsx apps/web/src/components/marketing/export-brand.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loomGlyphsSvg, weaveMarkSvg, wordmarkSvg, wovenBandsSvg } from "./art";

const out = join(import.meta.dirname, "../../../public/brand");
const files: Record<string, string> = {
  "mark.svg": weaveMarkSvg(),
  "wordmark.svg": wordmarkSvg(),
  "woven-bands.svg": wovenBandsSvg(),
  "loom-glyphs.svg": loomGlyphsSvg(),
};
for (const [name, svg] of Object.entries(files)) writeFileSync(join(out, name), svg + "\n");
console.log(`wrote ${Object.keys(files).join(", ")} to ${out}`);
