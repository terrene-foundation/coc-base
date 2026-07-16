// CLEAN fixture — both tokens appear ONLY inside comments; the line-preserving
// comment strip must remove them so the co-occurrence predicate does not fire on
// documentation (the comment-strip scope-restriction predicate).
// Example of what NOT to do: signingKey = process.env.ANTHROPIC_API_KEY
/* Another note: never bind signing_key to a model_key / MODEL_KEY. */
const signingKey = deriveFromGpg();
