import type { NextConfig } from "next";

// The browser talks to the API only through /api/* (SPEC 2, 10). src/proxy.ts injects x-weft-proxy from
// .data/run/proxy.secret (written by the API at boot); this rewrite forwards to the API bound on 127.0.0.1.
const apiPort = process.env.WEFT_API_PORT ?? "4070";

// Weft on Cloudflare (docs/cloudflare/design.md 3.5). WEFT_STATIC_EXPORT=1 builds the static export served as Workers
// static assets: no rewrites (the front Worker owns /api/*), trailing slashes, and only .tsx page files, so src/proxy.ts
// (the one .ts file the app router would pick up) drops out of the export. NEXT_PUBLIC_WEFT_HOSTED=1 turns on the
// hosted shell and adds the hosted-only pages (page.hosted.tsx). With neither set, the config is exactly the Node one.
const staticExport = process.env.WEFT_STATIC_EXPORT === "1";
const hosted = process.env.NEXT_PUBLIC_WEFT_HOSTED === "1";

const shared: NextConfig = {
  // next dev would otherwise write an untracked apps/web/AGENTS.md on every start.
  agentRules: false,
  devIndicators: false,     // the dev badge covered the sidebar Settings link in every demo walk
  transpilePackages: ["@weft/ui", "@weft/contracts"],
  compress: false,          // SSE must not be buffered
  poweredByHeader: false,
};

const nodeConfig: NextConfig = {
  ...shared,
  // A hosted shell under next dev (NEXT_PUBLIC_WEFT_HOSTED=1 alone) also serves the hosted-only pages.
  ...(hosted ? { pageExtensions: ["hosted.tsx", "tsx", "ts", "jsx", "js"] } : {}),
  async rewrites() {
    return [{ source: "/api/:path*", destination: `http://127.0.0.1:${apiPort}/:path*` }];
  },
};

const exportConfig: NextConfig = {
  ...shared,
  output: "export",
  trailingSlash: true,
  pageExtensions: hosted ? ["hosted.tsx", "tsx"] : ["tsx"],
  images: { unoptimized: true },
  // Client code that must know it runs from the prerendered `_` shells (lib/pathname.ts hydration).
  env: { NEXT_PUBLIC_WEFT_STATIC_EXPORT: "1" },
};

export default staticExport ? exportConfig : nodeConfig;
