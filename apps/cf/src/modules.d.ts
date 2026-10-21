// Module types for the snapshot artifacts pnpm cf:snapshot writes into apps/cf/generated/ (gitignored, design 4.1).
// wrangler's Data rule (wrangler.core.jsonc) bundles the .gz files as ArrayBuffer modules; the JSON is bundled as is.
declare module "*.gz" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*/generated/manifest.json" {
  const manifest: Record<string, unknown>;
  export default manifest;
}
