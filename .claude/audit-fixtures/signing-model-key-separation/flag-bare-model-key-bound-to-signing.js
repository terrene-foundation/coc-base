// POSITIVE fixture — the BARE `model[_-]?key` SOURCE branch (distinct from the
// provider-env-var and the `_MODEL_KEY`-suffix branches). `signingKey` (sink) +
// `modelKey` (the bare model-key token) co-occur on one line.
const modelKey = loadOrgModelKey();
const signingKey = modelKey;
