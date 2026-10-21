// Hardened git (harness 6.7): execFile with argv (never a shell), the hardening flags, GIT_LITERAL_PATHSPECS=1 and an
// explicit minimal env (PATH, HOME set to a temp dir, isolated GIT_CONFIG_*), never ...process.env.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** node:child_process and node:fs on first use, never as static imports: the memory store is on the durable import
 * path (docs/cloudflare/design.md 6.4), where only the SQL repository runs and git never does. */
type ChildProcess = typeof import("node:child_process");
type Fs = typeof import("node:fs");
const builtin = <T>(id: string): T => {
  const m = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.(id);
  if (!m) throw new Error(`${id} is not available here: the git memory repository runs on Node only`);
  return m as T;
};
export const nodeFs = () => builtin<Fs>("node:fs");
export const childProcess = () => builtin<ChildProcess>("node:child_process");

export const GIT_FLAGS = [
  "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.sshCommand=false", "-c", "protocol.allow=never",
  "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", "--no-pager",
] as const;

export const COMMITTER = { name: "Weft Agent", email: "agent@weft.example" } as const;

let home: string | null = null;
function isolatedHome(): string {
  if (!home) home = nodeFs().mkdtempSync(join(tmpdir(), "weft-git-home-"));
  return home;
}

/** Git date from the sim clock, so SHAs are reproducible: "@<epoch seconds> +0000". */
export function gitDate(iso: string): string { return `@${Math.floor(Date.parse(iso) / 1000)} +0000`; }

export interface GitEnvExtra { author?: { name: string; email: string }; date?: string }

export function gitEnv(extra: GitEnvExtra = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: isolatedHome(),
    LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_COMMITTER_NAME: COMMITTER.name, GIT_COMMITTER_EMAIL: COMMITTER.email,
    GIT_AUTHOR_NAME: extra.author?.name ?? COMMITTER.name, GIT_AUTHOR_EMAIL: extra.author?.email ?? COMMITTER.email,
  };
  if (extra.date) { env.GIT_AUTHOR_DATE = gitDate(extra.date); env.GIT_COMMITTER_DATE = gitDate(extra.date); }
  return env;
}

export function git(root: string, args: string[], extra: GitEnvExtra = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess().execFile("git", [...GIT_FLAGS, "-C", root, ...args], { env: gitEnv(extra), maxBuffer: 16 << 20, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`) as Error & { exitCode?: number | null; stdout?: string };
        e.exitCode = (err as { code?: number | null }).code ?? null;
        e.stdout = String(stdout);
        reject(e);
      } else resolve(String(stdout));
    });
  });
}

/** One git operation at a time per process. */
let tail: Promise<unknown> = Promise.resolve();
export function serialGit<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
