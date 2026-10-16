// Memory snapshots (harness 18 item 6), mirroring Instinct's single-bundle sync: `git bundle create --all` into
// .data/companies/<id>/bundles/<iso>.bundle, and a restore that verifies the bundle, rebuilds the repo beside the
// live one, checks it, then swaps it in and keeps the replaced repo next to it (never deleted). Uses the hardened
// git helper (argv only, isolated config, hooks off). Dependency-free so the pnpm scripts can import it directly.
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { git } from "./git";

export class BundleError extends Error {
  constructor(readonly code: "NOT_A_REPO" | "BUNDLE_INVALID" | "RESTORE_FAILED", message: string) { super(message); }
}

const stamp = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-").replace(/\+00-00$/, "Z");

/** Writes a verified bundle of every ref; the file name is the HEAD commit's sim-clock date, so it is reproducible. */
export async function bundleMemory(root: string, outDir: string): Promise<{ path: string; head: string; bytes: number }> {
  if (!existsSync(join(root, ".git"))) throw new BundleError("NOT_A_REPO", `No memory repo at ${root}`);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const date = new Date((await git(root, ["log", "-1", "--format=%cI", "HEAD"])).trim()).toISOString();
  mkdirSync(outDir, { recursive: true });
  const path = join(resolve(outDir), `${stamp(date)}.bundle`);
  await git(root, ["bundle", "create", "-q", path, "--all"]);
  await verifyBundle(path, root);
  return { path, head, bytes: statSync(path).size };
}

/** git bundle verify inside a repo (an empty scratch repo when none is given). Throws BUNDLE_INVALID. */
export async function verifyBundle(path: string, repo?: string): Promise<string> {
  if (!existsSync(path)) throw new BundleError("BUNDLE_INVALID", `No bundle at ${path}`);
  let at = repo;
  if (!at) {
    at = join(dirname(resolve(path)), `.verify-${basename(path)}-${process.pid}`);
    mkdirSync(at, { recursive: true });
    await git(at, ["init", "-q"]);
  }
  const scratch = !repo ? at : null;
  try {
    const out = await git(at, ["bundle", "verify", resolve(path)]);
    const head = /^([0-9a-f]{40}) refs\/heads\/main$/m.exec(out)?.[1] ?? /^([0-9a-f]{40}) HEAD$/m.exec(out)?.[1];
    if (!head) throw new BundleError("BUNDLE_INVALID", "The bundle has no main branch");
    return head;
  } catch (e) {
    if (e instanceof BundleError) throw e;
    throw new BundleError("BUNDLE_INVALID", `The bundle did not verify: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Restores `bundle` into `root`: verify, fetch every branch into a fresh repo beside it, check out main, confirm
 * HEAD matches the bundle, then swap. The replaced repo moves to <root>.replaced-<stamp> so nothing is lost.
 */
export async function restoreMemory(bundle: string, root: string, now: string = new Date().toISOString()): Promise<{ head: string; replaced: string | null }> {
  const abs = resolve(bundle);
  const fresh = `${root}.restoring-${process.pid}`;
  if (existsSync(fresh)) throw new BundleError("RESTORE_FAILED", `${fresh} exists; remove it and try again`);
  mkdirSync(fresh, { recursive: true });
  try { return await restoreInto(abs, fresh, root, now); } finally { if (existsSync(fresh)) rmSync(fresh, { recursive: true, force: true }); }
}

async function restoreInto(abs: string, fresh: string, root: string, now: string): Promise<{ head: string; replaced: string | null }> {
  await git(fresh, ["init", "-q"]);
  const head = await verifyBundle(abs, fresh);
  // `git bundle unbundle` writes the objects without any transport (protocol.allow=never stays in force), and
  // index-pack rejects a truncated or corrupt pack here.
  let refs: string;
  try { refs = await git(fresh, ["bundle", "unbundle", abs]); } catch (e) {
    throw new BundleError("BUNDLE_INVALID", `The bundle did not unpack: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  try {
    for (const line of refs.split("\n")) {
      const m = /^([0-9a-f]{40}) (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(line.trim());
      if (m) await git(fresh, ["update-ref", m[2]!, m[1]!]);
    }
    await git(fresh, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(fresh, ["reset", "-q", "--hard", "HEAD"]);
    const got = (await git(fresh, ["rev-parse", "HEAD"])).trim();
    if (got !== head) throw new BundleError("RESTORE_FAILED", `Restored HEAD ${got} does not match the bundle ${head}`);
    await git(fresh, ["fsck", "--no-progress", "--no-dangling"]);
  } catch (e) {
    throw e instanceof BundleError ? e : new BundleError("RESTORE_FAILED", e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }
  let replaced: string | null = null;
  if (existsSync(root)) {
    replaced = `${root}.replaced-${stamp(now)}`;
    renameSync(root, replaced);
  }
  renameSync(fresh, root);
  return { head, replaced };
}
