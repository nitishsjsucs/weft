import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// `pnpm screenshots` retakes docs/screenshots/ (or SHOTS_DIR) at 1440 by 900 with the agent panel docked. It reuses
// the e2e dev runner, ports and per-test world reset, and runs only e2e/screens/capture.screens.ts.
export default defineConfig({ ...base, testDir: "e2e/screens", testMatch: /capture\.screens\.ts$/ });
