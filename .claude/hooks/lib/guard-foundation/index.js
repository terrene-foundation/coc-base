/**
 * guard-foundation — L1 provider layer: FACTS about an operation, before it
 * runs. Every provider returns `{ verdict, facts|effects, reason }` where
 * verdict is "determined" | "undetermined"; a missing fact is undetermined,
 * NEVER false/allow (contract.js). NO POLICY LIVES HERE — L3 owns the chain
 * deny > undetermined-on-protected > halt > advisory > allow.
 *
 * PROVIDERS
 *   effectsForShellCommand(rawCommand)      shell-effects.js
 *   effectsForToolCall(toolName, toolInput) tool-effects.js   (Bash delegates
 *                                           to shell-effects: ONE effect model)
 *   targetIdentity(path, ctx)               target-identity.js (canonical
 *                                           target vs registered alias)
 *   repoIdentity(ctx) / consumerTree(ctx)   repo-facts.js  (+ THE one gitEnv)
 *   operatorIdentity(ctx) /                 identity.js
 *   operatorRepoBinding(ctx)
 *
 * SHARED
 *   contract.js  verdict constructors + isProviderResult shape guard
 *   effects.js   the ordered effect model (read-bytes / write-bytes /
 *                load-and-execute / delete; both endpoints per move)
 */

"use strict";

const contract = require("./contract.js");
const effects = require("./effects.js");
const shellEffects = require("./shell-effects.js");
const toolEffects = require("./tool-effects.js");
const targetIdentity = require("./target-identity.js");
const repoFacts = require("./repo-facts.js");
const identity = require("./identity.js");

module.exports = {
  contract,
  effects,
  shellEffects,
  toolEffects,
  targetIdentity,
  repoFacts,
  identity,
};
