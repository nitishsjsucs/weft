import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// The web project's vitest settings (the root vitest.config.ts lists it under apps/*). Components import through the
// Next "@/..." path alias from tsconfig.json, so component tests resolve it the same way.
export default defineProject({
  resolve: { alias: [{ find: /^@\//, replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/` }] },
  test: { name: "@weft/web" },
});
