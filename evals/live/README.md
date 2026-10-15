# Live Luna gate (opt-in, costs money)

Cases L1 to L3 (L4 if the cap allows) from SPEC 12 and harness 12. Each case gets a fresh seed and a frozen clock in
`.data/eval-live/`; the database is rebuilt per case while `.data/eval-live/spend` is kept, so the cumulative live cap
holds across reruns. Owner: t4-agent.

```sh
WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 WEFT_LLM=openai pnpm eval:live          # L1 to L3
WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 WEFT_LLM=openai pnpm eval:live L4       # one case
```

The cumulative live cap is `WEFT_LIVE_USD_CAP=0.50` (expected under $0.05 for the suite). Results go to
`evals/results/<date>-<sha>.json` (gitignored): pass or fail with reasons, model steps, tool calls, invalid-argument
errors, tokens, cache-hit ratio, USD and wall time. Automated tests never run this suite. It needs the merged world
(`createWeft({ strict: true })` refuses scaffold stubs) with the t4 wiring in compose.ts.

Last run, 2026-10-15 on a trial merge of tracks t1 to t4: L1, L2 and L3 pass on gpt-5.6-luna for $0.0051 in total
(2, 5 and 3 model steps). Numbers are in `docs/tracks/t4-agent.md`.

`smoke.ts` holds the 5 builder smoke calls of harness 11.2 (run once; results in `.scratch/t4-agent/smoke.md`).
