import type { NextConfig } from "next";

// The browser talks to the API only through /api/* (SPEC 2, 10). src/proxy.ts injects x-weft-proxy from
// .data/run/proxy.secret (written by the API at boot); this rewrite forwards to the API bound on 127.0.0.1.
const apiPort = process.env.WEFT_API_PORT ?? "4070";

const config: NextConfig = {
  // next dev would otherwise write an untracked apps/web/AGENTS.md on every start.
  agentRules: false,
  devIndicators: false,     // the dev badge covered the sidebar Settings link in every demo walk
  transpilePackages: ["@weft/ui", "@weft/contracts"],
  compress: false,          // SSE must not be buffered
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `http://127.0.0.1:${apiPort}/:path*` }];
  },
};

export default config;
