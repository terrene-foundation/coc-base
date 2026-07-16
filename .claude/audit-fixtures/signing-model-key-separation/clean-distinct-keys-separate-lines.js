// CLEAN fixture — a signing key and a model key both present in the file, but
// never on ONE line (the #411 separation held). The per-line co-occurrence
// predicate must NOT flag: this is the distinct-keys happy path.
const signingKey = git.config("user.signingkey");
const modelKey = process.env.OPENAI_API_KEY;
sign(record, signingKey);
callModel(modelKey);
