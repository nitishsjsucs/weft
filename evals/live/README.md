# Live Luna gate (opt-in, costs money)

Cases L1 to L3 (L4 if the cap allows) from SPEC 12 and harness 12, run against a fresh seed with a frozen clock.
Owner: t4-agent (runner); scenario owners write the cases.

```sh
WEFT_SECRETS_FILE=~/Developer/projects/.weft.secrets.env WEFT_LIVE_OPENAI=1 WEFT_LLM=openai pnpm eval:live
```

The cumulative live cap is `WEFT_LIVE_USD_CAP=0.50` (expected under $0.05 for the suite). Results go to
`evals/results/<date>-<sha>.json` (gitignored): pass or fail, steps, tool calls, invalid-argument errors, tokens,
cache-hit ratio, USD and wall time. Automated tests never run this suite.
