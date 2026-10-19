import { defineConfig } from "@playwright/test";
import rich from "./playwright.rich.config";

// `pnpm screenshots:rich` retakes the plain route shots in docs/screenshots/ (or SHOTS_DIR) on a fresh rich world: the
// same runner, ports, data dir and scripted provider as `pnpm e2e:rich`, running only e2e/screens/rich.screens.ts.
export default defineConfig({ ...rich, testDir: "e2e/screens", testMatch: /rich\.screens\.ts$/, outputDir: "test-results/screens-rich" });
