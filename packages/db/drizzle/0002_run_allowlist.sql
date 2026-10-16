-- Harness 5.3: the per-run tool allowlist, frozen by the executor when it opens the run.
ALTER TABLE `exec_runs` ADD `allowlist_json` text;
