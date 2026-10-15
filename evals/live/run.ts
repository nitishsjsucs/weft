// Live Luna gate runner (SPEC 12). Owner: t4-agent. Refuses to run unless explicitly opted in.
if (process.env.WEFT_LIVE_OPENAI !== "1" || process.env.WEFT_LLM !== "openai") {
  console.error("eval:live is opt-in: set WEFT_LIVE_OPENAI=1 and WEFT_LLM=openai (see evals/live/README.md)");
  process.exit(2);
}
console.error("eval:live: runner not implemented yet (t4-agent)");
process.exit(1);
