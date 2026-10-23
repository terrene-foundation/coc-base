"use strict";
const { getProviderForRoster, getProviderForRecordContent } = require("./vcs-provider.js");
const { loginsEqual } = require("./github-login.js");

// Consumes the effective verified fold witness, not an independently selected
// anchor: coordination-log.js:2827-2843; fold-genesis-anchor.js:395-435.
function resolveSignedPeerBinding(roster, accepted, trustRoot) {
  const refuse = (reason) => ({ ok: false, reason: "signed peer binding: " + reason });
  if (!trustRoot || !Array.isArray(accepted)) return refuse("verified trust-root witness missing");
  const witnesses = accepted.filter((record) => record &&
    ["genesis-anchor", "genesis-migration"].includes(record.type) &&
    record.verified_id === trustRoot.verified_id && record.person_id === trustRoot.person_id &&
    record.seq === trustRoot.seq && record.ts === trustRoot.ts);
  if (witnesses.length !== 1) return refuse("effective witness missing or ambiguous");
  const record = witnesses[0], content = record.content;
  if (!content || typeof content !== "object" || !record.sig) return refuse("signed witness content missing");
  const provider = getProviderForRoster(roster), witnessProvider = getProviderForRecordContent(content);
  if (!provider.ok || !witnessProvider.ok || provider.providerId !== witnessProvider.providerId) {
    return refuse("provider mismatch or unsupported provider");
  }
  const ownersEqual = provider.providerId === "github"
    ? loginsEqual : provider.provider.principalsEqual;
  const genesis = roster && roster.genesis, facts = trustRoot.pinnedFacts;
  if (!genesis || !facts || !ownersEqual(facts.repo_owner, genesis.repo_owner) ||
      facts.repo_owner_kind !== genesis.repo_owner_kind || facts.root_commit !== genesis.root_commit) {
    return refuse("effective pinned facts mismatch");
  }
  const fields = provider.providerId === "github"
    ? ["gh_api_owner_capture", "gh_api_repo_owner_capture"] : ["ado_api_owner_capture"];
  const captures = fields.filter((field) => Object.prototype.hasOwnProperty.call(content, field));
  if (captures.length !== 1) return refuse("owner capture missing or conflicting");
  const capture = content[captures[0]];
  if (!capture || !capture.owner || typeof capture.owner.login !== "string" ||
      typeof capture.name !== "string" || typeof capture.full_name !== "string") {
    return refuse("signed repository identity missing");
  }
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  if (!ownersEqual(capture.owner.login, genesis.repo_owner)) return refuse("signed owner mismatch");
  const parts = capture.full_name.split("/");
  let identity, url;
  if (provider.providerId === "github") {
    if (parts.length !== 2 || !ownersEqual(parts[0], capture.owner.login) || !same(parts[1], capture.name)) {
      return refuse("signed GitHub identity conflict");
    }
    identity = { owner: parts[0], name: parts[1] };
    if (!provider.provider.validateRepoRef(identity).valid) return refuse("invalid GitHub identity");
    url = `https://github.com/${identity.owner}/${identity.name}.git`;
  } else {
    if (parts.length !== 3 || !ownersEqual(parts[0], capture.owner.login) || !same(parts[2], capture.name) ||
        !same(parts[1], genesis.ado_project)) return refuse("signed Azure project identity unresolved");
    identity = { org: parts[0], project: parts[1], repo: parts[2] };
    if (!provider.provider.validateRepoRef(identity).valid) return refuse("invalid Azure identity");
    url = `https://dev.azure.com/${encodeURIComponent(identity.org)}/${encodeURIComponent(identity.project)}/_git/${encodeURIComponent(identity.repo)}`;
  }
  return { ok: true, url, provider: provider.providerId, identity };
}

function canonicalPeerUrl(value) {
  if (typeof value !== "string") return null;
  let url = value.trim();
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(url);
  if (scp) url = `https://github.com/${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/.exec(url);
  if (ssh) url = `https://github.com/${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
    if (parsed.hostname !== "github.com" && parsed.hostname !== "dev.azure.com") return null;
    return (parsed.origin + parsed.pathname.replace(/\/$/, "").replace(/\.git$/, "")).toLowerCase();
  } catch { return null; }
}
module.exports = { resolveSignedPeerBinding, canonicalPeerUrl };
