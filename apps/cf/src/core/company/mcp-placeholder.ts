// Stands in for @weft/mcp in a checkout without cf3-agent's entry (apps/mcp/src/index.ts): scripts/cf/lib/tracks.ts
// aliases the package here for wrangler and the Miniflare suite. It exports nothing, so deps.ts reports
// createRemoteMcpHandler as missing and the real engine refuses to boot; a build that used it is never deployable.
export {};
