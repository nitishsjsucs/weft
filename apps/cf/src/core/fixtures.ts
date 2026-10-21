// The FixtureSource the durable platform reads its fixture files from (design 4.1): the generated module
// apps/cf/generated/fixtures.ts, which pnpm cf:fixtures writes from the repo's files (migrations and their journal,
// the mailed and scenario notices, the scripted provider's scenarios). Paths are repo-relative with "/".
import { FIXTURE_FILES } from "../../generated/fixtures";
import type { FixtureSource } from "../shared/contracts";

const enc = new TextEncoder();

export function fixtureSource(files: Readonly<Record<string, string>>): FixtureSource {
  const paths = Object.keys(files).sort();
  return {
    text: (path) => (Object.hasOwn(files, path) ? files[path]! : null),
    bytes: (path) => (Object.hasOwn(files, path) ? enc.encode(files[path]!) : null),
    list(dir) {
      const prefix = dir.replace(/\/+$/, "") + "/";
      return paths.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"));
    },
  };
}

export const bundledFixtures: FixtureSource = fixtureSource(FIXTURE_FILES);
