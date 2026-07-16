// POSITIVE fixture — the shared org-level model-key CONSTANT used as the signing
// key (a different token shape than the env-var case). `signing_key` (sink) +
// `SHARED_MODEL_KEY` (the `_MODEL_KEY` suffix family) co-occur on one line.
const SHARED_MODEL_KEY = loadOrgModelKey();
const signing_key = SHARED_MODEL_KEY;
