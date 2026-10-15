// Tracked plus untracked-not-ignored files, so the lints also run before the first commit.
import { execFileSync } from "node:child_process";

export function repoFiles(cwd = process.cwd()): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

export const TEXT_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|mdx|css|html|txt|yml|yaml|svg|sql|toml|sh)$|(^|\/)(LICENSE|NOTICE|README|AGENTS|CLAUDE|\.gitignore|\.nvmrc|\.env\.example)$/;
