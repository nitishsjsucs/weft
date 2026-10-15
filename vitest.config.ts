import { defineConfig } from "vitest/config";

// One root config with projects (vitest 5.0.4; workspace files are deprecated). Each folder is a project named
// after its package.json. Tests never call a live model: the provider factory refuses unless WEFT_LIVE_OPENAI=1.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "tests"],
  },
});
