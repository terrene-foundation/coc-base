// POSITIVE fixture — a provider model / LLM key env var bound to a signing sink.
// The co-occurrence of `signingKey` (sink) + `ANTHROPIC_API_KEY` (model source)
// on ONE line is the exact GAP-5 regression: a model key signing a record.
const signingKey = process.env.ANTHROPIC_API_KEY;
sign(record, signingKey);
