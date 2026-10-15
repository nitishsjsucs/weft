import { describe, expect, it } from "vitest";
import { ApiError, buildPath, createClient } from "../src/lib/api/client";

describe("typed api client", () => {
  it("fills path params and query", () => {
    expect(buildPath("/v1/workers/:id", { id: "wrk_0001" })).toBe("/v1/workers/wrk_0001");
    expect(buildPath("/v1/workers", {}, { limit: 5, afterId: "wrk_0005", state: undefined })).toBe("/v1/workers?limit=5&afterId=wrk_0005");
  });
  it("sends the principal header and maps _tag errors", async () => {
    const seen: Request[] = [];
    const client = createClient({
      baseUrl: "http://127.0.0.1:3070/api",
      principal: () => "usr_dana",
      fetch: async (input, init) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ _tag: "NotImplemented", message: "Not implemented: GET /v1/stats" }), { status: 501 });
      },
    });
    await expect(client.get("/v1/stats")).rejects.toBeInstanceOf(ApiError);
    expect(seen[0]!.headers.get("x-weft-principal")).toBe("usr_dana");
    expect(seen[0]!.url).toBe("http://127.0.0.1:3070/api/v1/stats");
  });
});
