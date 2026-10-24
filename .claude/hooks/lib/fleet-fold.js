"use strict";

// Pure fleet facts; hashing, Rule1/Rule4 verification and IO belong to the adapter.
// Admission/comparator: .claude/hooks/lib/coordination-log.js:1921-2110,2201-2213.
const { isLaneName } = require("./todo-durable.js");
const FLEET_RECORD_TYPES = Object.freeze([
  "fleet-offer", "fleet-accept", "fleet-release", "fleet-unregister", "fleet-state", "fleet-override",
]);
const FOLD_ANOMALY_CAP = 1024;
// ROOT 2d4cd96d: Linux 1024 worst 203.513235 ms; next 2048 worst 337.350286 ms.
// Measured 9e9f9ee7744e670df869c8910f656ec6ab866dc3 / tree d772bdf7f5921d57d5a13bc32fe08b54fdd53104.
// Supported-valid ed25519, ten within/overflow samples per power; workload-specific, excluding invalid/RSA controls.
// Producer: tests/integration/multi-operator/fleet-s1-r2-cap-measure.mjs:52-77,137-163.
// Repo-ignored evidence (not shipped): .claude/scratchpad/fleet-s1-r2-measure-cwd-ready.pn2t5z56/terminal-full-consumed.23yzs45j/TERMINAL-PACKET.json sha256=eb565a70d571fa5c98af4887655bc8abd94c7094868f3172621a17f8f538f812.
const TYPES = new Set(FLEET_RECORD_TYPES);
const HASH = /^[a-f0-9]{64}$/;
const TARGET = /^[1-9]\d*:(0|[1-9]\d*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS = Object.freeze({
  "fleet-offer": ["orchestrator", "workhorse", "lane", "last_item", "nonce", "expires_ts", "supersedes"],
  "fleet-accept": ["workhorse", "offer_hash", "orchestrator"],
  "fleet-release": ["binding_hash"], "fleet-unregister": ["binding_hash"],
  "fleet-state": ["binding_hash", "event", "queue", "last"],
  "fleet-override": ["role", "reason_sha256", "reason_excerpt"],
});
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, cap) => typeof v === "string" && v.length <= cap && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const target = v => typeof v === "string" && TARGET.test(v) && v.split(":").every(n => Number.isSafeInteger(Number(n)));
const hash = v => typeof v === "string" && HASH.test(v);
const optionalText = v => v === null || text(v, 8192);
function timestamp(record) {
  if (typeof record.ts !== "string" || !ISO.test(record.ts)) return null;
  const ms = Date.parse(record.ts);
  return Number.isFinite(ms) && new Date(ms).toISOString() === record.ts ? Math.floor(ms / 1000) : null;
}
function fleetContentError(record) {
  if (!object(record) || !TYPES.has(record.type) || !object(record.content)) return "content-shape";
  const c = record.content, fields = ["session", "host", "log_id", ...FIELDS[record.type]];
  if (Object.keys(c).some(k => !fields.includes(k))) return "unexpected-field";
  if (fields.some(k => !Object.hasOwn(c, k))) return "missing-field";
  if (!target(c.session) || !hash(c.host) || !hash(c.log_id)) return "common-shape";
  if (timestamp(record) === null) return "ts-malformed";
  if (record.type === "fleet-offer") {
    if (!target(c.orchestrator) || !target(c.workhorse) || c.session !== c.orchestrator || c.workhorse === c.orchestrator) return "offer-role";
    if (!isLaneName(c.lane) || !optionalText(c.last_item) || typeof c.nonce !== "string" || !/^[a-f0-9]{32}$/.test(c.nonce)) return "offer-shape";
    if (!Number.isSafeInteger(c.expires_ts) || c.expires_ts <= timestamp(record) || c.expires_ts > timestamp(record) + 900) return "offer-expiry";
    if (c.supersedes !== null && !hash(c.supersedes)) return "offer-supersedes";
  } else if (record.type === "fleet-accept") {
    if (!target(c.workhorse) || !target(c.orchestrator) || c.session !== c.workhorse || !hash(c.offer_hash)) return "accept-role";
  } else if (record.type === "fleet-state") {
    if (!hash(c.binding_hash) || !["busy", "idle"].includes(c.event) || !Number.isSafeInteger(c.queue) || c.queue < 0 || !optionalText(c.last)) return "state-shape";
    if (c.event === "idle" && c.queue !== 0) return "state-idle-queue";
  } else if (record.type === "fleet-override") {
    if (!text(c.role, 128) || !c.role || !hash(c.reason_sha256) || !text(c.reason_excerpt, 240)) return "override-shape";
  } else if (!hash(c.binding_hash)) return "binding-shape";
  return null;
}
function input(facts, folding = false) {
  if (!object(facts)) throw new TypeError("fleet facts must be an object");
  const allowed = ["entries", "rosteredVerifiedIds", ...(folding ? ["verification", "liveSessions", "hostHash", "nowSeconds"] : [])];
  if (Object.keys(facts).some(k => !allowed.includes(k))) throw new TypeError("unexpected fleet fact: heads and seeds are forbidden");
  if (!Array.isArray(facts.entries) || !Array.isArray(facts.rosteredVerifiedIds) || facts.rosteredVerifiedIds.some(id => typeof id !== "string" || !id)) throw new TypeError("entries and rosteredVerifiedIds required");
  let previous = -1;
  for (const e of facts.entries) {
    if (!object(e) || !Number.isSafeInteger(e.index) || e.index <= previous || !object(e.record) || !hash(e.hash)) throw new TypeError("ordered unique indexed hash facts required");
    previous = e.index;
  }
}
function structure(entries, members) {
  const nodes = new Map(), byIndex = new Map(), slots = new Map(), representatives = new Map();
  for (const e of entries) {
    byIndex.set(e.index, e);
    let n = nodes.get(e.hash);
    if (!n) { n = { hash: e.hash, record: e.record, copies: [], signatures: new Map(), component: null }; nodes.set(e.hash, n); }
    n.copies.push(e);
    const signature = typeof e.record.sig === "string" ? e.record.sig : "";
    if (!n.signatures.has(signature)) n.signatures.set(signature, e);
    representatives.set(e.index, n.signatures.get(signature).index);
    if (!members.has(e.record.verified_id)) continue;
    const key = e.record.verified_id + ":" + e.record.seq;
    let group = slots.get(key);
    if (!group) { group = new Map(); slots.set(key, group); }
    group.set(e.hash, n);
  }
  const components = [], ordered = [];
  for (const start of nodes.values()) {
    if (start.component !== null) continue;
    const path = [], active = new Set();
    let cursor = start, terminal = null;
    while (cursor && cursor.component === null && !active.has(cursor.hash)) {
      active.add(cursor.hash); path.push(cursor);
      const previous = cursor.record.prev_hash;
      if (previous === null) { terminal = "origin"; break; }
      if (!hash(previous)) { terminal = "malformed"; break; }
      const parent = nodes.get(previous);
      if (!parent) { terminal = "gap"; break; }
      cursor = parent;
    }
    let id = cursor?.component;
    if (id === null || id === undefined) { id = components.length; components.push({ id, terminal: terminal || "cycle" }); }
    for (let i = path.length - 1; i >= 0; i--) { path[i].component = id; ordered.push(path[i]); }
  }
  const gaps = [], fleet = [], roots = [], malformed = [], extra = new Set(), claims = new Set();
  for (const n of nodes.values()) {
    const r = n.record;
    if (!members.has(r.verified_id)) continue;
    if (TYPES.has(r.type)) { fleet.push(n); if (hash(r.content?.log_id)) claims.add(r.content.log_id); }
    if (r.type === "genesis-anchor") roots.push(n);
    if (["genesis-anchor", "compaction-checkpoint", "generation-rotation"].includes(r.type)) extra.add(n.hash);
    if (!Number.isSafeInteger(r.seq) || r.seq < 0) { malformed.push(n); continue; }
    if (r.seq === 0 && r.prev_hash === null) continue;
    if (!hash(r.prev_hash)) { malformed.push(n); continue; }
    const parent = nodes.get(r.prev_hash);
    if (!parent) gaps.push(n);
    else if (parent.record.verified_id !== r.verified_id || parent.record.seq + 1 !== r.seq) malformed.push(n);
  }
  for (const n of malformed) extra.add(n.hash);
  for (const group of slots.values()) if (group.size > 1) for (const n of group.values()) extra.add(n.hash);
  for (const n of [...fleet, ...gaps]) if (nodes.has(n.record.prev_hash)) extra.add(n.record.prev_hash);
  const collisionLineage = new Set(), fleetHashes = new Set(fleet.map(n => n.hash)), adjacent = new Set();
  for (const n of ordered) {
    const group = slots.get(n.record.verified_id + ":" + n.record.seq);
    if (group?.size > 1 || collisionLineage.has(n.record.prev_hash)) {
      collisionLineage.add(n.hash); extra.add(n.hash);
    }
    if (fleetHashes.has(n.record.prev_hash)) {
      extra.add(n.hash);
      if (!TYPES.has(n.record.type)) adjacent.add(n.hash);
    } else if (adjacent.has(n.record.prev_hash)) extra.add(n.hash);
  }
  const gapC = [], fleetC = [], rootC = [], extraC = [], required = new Set(), gapIndices = new Set();
  function add(n, forced, tier) {
    for (const e of n.signatures.values()) {
      if (!members.has(e.record.verified_id) || (!forced && !(typeof e.record.sig === "string" && e.record.sig))) continue;
      if (!required.has(e.index)) { required.add(e.index); tier.push(e.index); }
      if (forced === "gap") gapIndices.add(e.index);
    }
  }
  for (let i = gaps.length - 1; i >= 0; i--) add(gaps[i], "gap", gapC);
  for (let i = fleet.length - 1; i >= 0; i--) add(fleet[i], "fleet", fleetC);
  for (const n of roots) add(n, claims.has(n.hash) ? "claimed-anchor" : false, rootC);
  for (const n of nodes.values()) if (extra.has(n.hash)) add(n, claims.has(n.hash) ? "claimed-anchor" : false, extraC);
  const rootIndices = new Set(rootC);
  const orderedRoots = entries.filter(e => rootIndices.has(e.index)).map(e => e.index);
  const gapTaken = Math.min(gapC.length, FOLD_ANOMALY_CAP);
  const rootTaken = Math.min(orderedRoots.length, FOLD_ANOMALY_CAP - gapTaken);
  const fleetTaken = Math.max(0, FOLD_ANOMALY_CAP - gapTaken - rootTaken);
  const candidates = gapC.concat(fleetC.slice(0, fleetTaken), orderedRoots, fleetC.slice(fleetTaken), extraC);
  return { nodes, byIndex, slots, representatives, ordered, components, gaps, fleet, roots, malformed, candidates, gapIndices };
}
function planFor(s) {
  return { indices: s.candidates.slice(0, FOLD_ANOMALY_CAP), anomalyCandidates: s.gaps.length + s.malformed.length,
    candidateCount: s.candidates.length, overflow: s.candidates.length > FOLD_ANOMALY_CAP };
}
function fleetVerificationPlan(facts) {
  try {
    input(facts);
    return planFor(structure(facts.entries, new Set(facts.rosteredVerifiedIds)));
  } catch {
    return { ok: false, code: "fleet-plan-error", reason: "Malformed fleet facts or internal planning failure", plan: [] };
  }
}
function unknown(code, faults = [], overrideDisposition = "allowed-with-audit", detail = {}) {
  return { status: "indeterminate", code, faults, overrideDisposition, ...detail };
}
const evidence = e => ({ index: e.index, hash: e.hash, record: e.record });
function foldFleetUnchecked(facts) {
  input(facts, true);
  const { entries, rosteredVerifiedIds, verification, liveSessions, hostHash, nowSeconds } = facts;
  const members = new Set(rosteredVerifiedIds), s = structure(entries, members), plan = planFor(s);
  if (!members.size) return unknown("roster-empty");
  const ignored = [], diagnostics = [], audits = [];
  if (!s.fleet.length && !s.roots.length) return { status: "known", integrity: { observable: "clean", tail: "unattested" }, offers: [], bindings: [], ignored, diagnostics, audits };
  if (!Array.isArray(verification)) return unknown("verification-incomplete");
  const selected = new Set(plan.indices), verified = new Map();
  for (const v of verification) {
    if (!object(v) || !selected.has(v.index) || verified.has(v.index) || !["verified", "invalid", "indeterminate"].includes(v.status)) return unknown("verification-incomplete");
    verified.set(v.index, v);
  }
  const status = e => verified.get(s.representatives.get(e.index))?.status;
  const valid = e => status(e) === "verified" && members.has(e.record.verified_id);
  const validByHash = new Map(), invalidHashes = new Set();
  for (const n of s.nodes.values()) {
    const good = n.copies.find(valid);
    if (good) validByHash.set(n.hash, good);
    else if (n.copies.some(e => status(e) === "invalid") || n.copies.every(e => !e.record.sig)) invalidHashes.add(n.hash);
  }
  const presentRoots = new Map();
  for (const n of s.nodes.values()) if (n.record.type === "genesis-anchor") presentRoots.set(n.hash, n);
  const verifiedFleet = s.fleet.filter(n => validByHash.has(n.hash) && hash(n.record.content?.log_id));
  const matchedRoots = new Set();
  for (const n of verifiedFleet) if (presentRoots.has(n.record.content.log_id)) matchedRoots.add(n.record.content.log_id);
  const hard = [], unanchored = [], witnessed = [], forks = [], malformed = [];
  for (const n of s.gaps) {
    if ([...n.signatures.values()].some(e => !selected.has(e.index))) hard.push({ code: "gap-unresolved", records: [evidence(n.copies[0])] });
  }
  if (hard.length) return unknown("fleet-gap-unresolved", hard, "forbidden");
  const verifiedRoots = new Set(s.roots.filter(n => validByHash.has(n.hash)).map(n => n.hash));
  if (verifiedFleet.length && !matchedRoots.size && !verifiedRoots.size) return unknown("fleet-genesis-missing", verifiedFleet.map(n => evidence(validByHash.get(n.hash))), "forbidden");
  const rootHashes = verifiedRoots.size ? verifiedRoots : matchedRoots;
  const anchorComponents = new Set();
  for (const h of rootHashes) {
    const n = presentRoots.get(h);
    if (validByHash.has(h)) anchorComponents.add(n.component);
    else if ([...n.signatures.values()].some(e => selected.has(e.index) && status(e) !== undefined && status(e) !== "verified")) hard.push({ code: "genesis-unverified", records: [evidence(n.copies[0])] });
  }
  for (const n of verifiedFleet) if (rootHashes.has(n.record.content.log_id)) anchorComponents.add(n.component);
  const qualified = new Set();
  for (const n of s.nodes.values()) {
    const r = n.record, connected = anchorComponents.has(n.component);
    if (!members.has(r.verified_id)) { for (const e of n.copies) ignored.push({ index: e.index, code: "admission-invalid" }); continue; }
    const good = validByHash.get(n.hash), matches = rootHashes.has(r.content?.log_id);
    if (TYPES.has(r.type) ? matches : connected || matches) qualified.add(n.hash);
    else if (good && TYPES.has(r.type) && connected && hash(r.content?.log_id)) hard.push({ code: "log-id-mismatch", records: [evidence(good)] });
    else if (!rootHashes.has(n.hash)) ignored.push({ index: n.copies[0].index, code: "foreign-log-record" });
    if (invalidHashes.has(n.hash)) ignored.push({ index: n.copies[0].index, code: "admission-invalid" });
  }
  const admitted = e => valid(e) && qualified.has(e.hash);
  for (const n of s.gaps) {
    const e = validByHash.get(n.hash);
    if (!e) continue;
    const f = { code: "predecessor-gone", records: [evidence(e)] };
    if (qualified.has(n.hash)) hard.push(f); else if (!TYPES.has(n.record.type)) unanchored.push(f);
  }
  if (hard.length) return unknown("fleet-chain-integrity", hard, "forbidden");
  if (verified.size !== selected.size) return unknown("verification-incomplete");
  if (unanchored.length) return unknown("fleet-unanchored-witness", unanchored);
  if (plan.overflow) return unknown("fleet-anomaly-cap", [], "allowed-with-audit", { count: plan.candidateCount, cap: FOLD_ANOMALY_CAP });
  if (!rootHashes.size) return unknown("fleet-genesis-unavailable");
  if (rootHashes.size !== 1) return unknown("fleet-genesis-ambiguous", [...rootHashes].map(h => evidence(presentRoots.get(h).copies[0])));
  const uncertain = entries.filter(e => TYPES.has(e.record.type) && qualified.has(e.hash) && status(e) === "indeterminate");
  if (uncertain.length) return unknown("verification-indeterminate", uncertain.map(evidence));
  const compact = entries.filter(e => ["compaction-checkpoint", "generation-rotation"].includes(e.record.type) && admitted(e));
  if (compact.length) return unknown("fleet-compaction-unsupported", compact.map(evidence));
  const collisionByHash = new Map(), inert = new Map();
  for (const group of s.slots.values()) {
    if (group.size < 2) continue;
    const good = [];
    for (const n of group.values()) { const e = validByHash.get(n.hash); if (e && admitted(e)) good.push(e); }
    if (good.length > 1) forks.push({ code: "fork", records: good.map(evidence) });
    const collision = { nodes: group, validSiblings: good.length };
    for (const n of group.values()) if (!validByHash.has(n.hash)) collisionByHash.set(n.hash, collision);
  }
  for (const n of s.ordered) {
    const collision = collisionByHash.get(n.hash) || inert.get(n.record.prev_hash);
    if (collision) inert.set(n.hash, collision);
    const e = validByHash.get(n.hash);
    if (!e || !admitted(e)) continue;
    if (collision && !collisionByHash.has(n.hash)) {
      const f = { code: "invalid-predecessor-witnessed", records: [evidence(e)] };
      if (collision.validSiblings) forks.push({ ...f, code: "fork-descendant" }); else witnessed.push(f);
    }
    const parent = s.nodes.get(n.record.prev_hash);
    if (parent && invalidHashes.has(parent.hash)) witnessed.push({ code: "invalid-predecessor-witnessed", records: [evidence(parent.copies[0]), evidence(e)] });
  }
  for (const n of s.malformed) { const e = validByHash.get(n.hash); if (e && admitted(e)) malformed.push({ code: "chain-link", records: [evidence(e)] }); }
  if (forks.length) return unknown("fleet-valid-fork", forks);
  if (witnessed.length) return unknown("fleet-invalid-witnessed", witnessed);
  if (malformed.length) return unknown("fleet-chain-integrity", malformed);
  const reject = (e, code) => ignored.push({ index: e.index, code });
  if (!Array.isArray(liveSessions)) return unknown("liveness-unknown");
  if (!hash(hostHash) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new TypeError("current host hash and integer time required");
  const live = new Map();
  for (const row of liveSessions) {
    if (!object(row) || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.started_at) || row.started_at < 0 || [row.name, row.label, row.surface].some(v => v != null && typeof v !== "string")) return unknown("liveness-unknown");
    live.set(row.pid + ":" + row.started_at, row);
  }
  const offers = new Map(), history = new Map(), current = new Map(), consumed = new Set(), applied = new Map();
  for (const e of entries) {
    const r = e.record, c = r.content;
    if (!TYPES.has(r.type) || !admitted(e) || inert.has(e.hash)) continue;
    const error = fleetContentError(r);
    if (error) { reject(e, error); continue; }
    const ts = timestamp(r);
    if (ts > nowSeconds + 300) { reject(e, "ts-future"); continue; }
    if (c.host !== hostHash) { reject(e, "host-mismatch"); continue; }
    const duplicate = applied.has(e.hash);
    let offer = null, binding = null;
    if (r.type === "fleet-offer") {
      const old = c.supersedes === null ? null : history.get(c.supersedes);
      if (c.supersedes !== null && (!old || old.workhorse !== c.workhorse || live.has(old.orchestrator))) { reject(e, "supersede-not-dead"); continue; }
    } else if (r.type === "fleet-accept") {
      offer = offers.get(c.offer_hash);
      if (!offer || offer.orchestrator !== c.orchestrator || offer.workhorse !== c.workhorse || offer.index >= e.index || ts < offer.ts || ts > offer.expires_ts) { reject(e, "offer-not-acceptable"); continue; }
      if (consumed.has(c.offer_hash) && !duplicate) { reject(e, "offer-consumed"); continue; }
    } else if (r.type !== "fleet-override") {
      binding = history.get(c.binding_hash);
      if (!binding || current.get(binding.workhorse) !== binding) { reject(e, "binding-inactive"); continue; }
      const expected = r.type === "fleet-unregister" ? binding.orchestrator : binding.workhorse;
      if (c.session !== expected) { reject(e, "binding-role"); continue; }
    }
    if (duplicate) {
      const changes = r.type === "fleet-accept" ? current.get(c.workhorse)?.hash !== e.hash :
        r.type === "fleet-state" ? binding.state !== c.event || binding.queue !== c.queue || binding.last !== c.last :
        r.type === "fleet-release" || r.type === "fleet-unregister";
      if (changes) return unknown("fleet-duplicate-record", [{ code: "duplicate-position-changes-outcome", records: [evidence(s.byIndex.get(applied.get(e.hash))), evidence(e)] }], "allowed-with-audit", { audits: [{ code: "duplicate-copy", index: e.index, hash: e.hash, authoritativeIndex: applied.get(e.hash) }] });
      continue;
    }
    if (r.type === "fleet-offer") offers.set(e.hash, { ...c, hash: e.hash, index: e.index, ts });
    else if (r.type === "fleet-accept") {
      consumed.add(c.offer_hash);
      binding = { hash: e.hash, offer_hash: c.offer_hash, workhorse: c.workhorse, orchestrator: c.orchestrator,
        lane: offer.lane, last_item: offer.last_item, state: "unknown", queue: null, last: null };
      history.set(e.hash, binding); current.set(c.workhorse, binding);
    } else if (r.type === "fleet-override") audits.push({ index: e.index, hash: e.hash, ...c });
    else if (r.type === "fleet-state") Object.assign(binding, { state: c.event, queue: c.queue, last: c.last });
    else current.delete(binding.workhorse);
    applied.set(e.hash, e.index);
  }
  for (const n of s.nodes.values()) if (n.copies.length > 1) {
    const authoritativeIndex = applied.get(n.hash) ?? null;
    for (const e of n.copies) if (e.index !== authoritativeIndex) audits.push({ code: "duplicate-copy", index: e.index, hash: e.hash, authoritativeIndex });
  }
  const bindings = [...current.values()].filter(b => live.has(b.workhorse) && live.has(b.orchestrator)).map(b => {
    const row = live.get(b.workhorse);
    return { ...b, name: row.name || row.label || b.workhorse, surface: row.surface || null };
  });
  for (const i of ignored) diagnostics.push({ code: i.code, index: i.index });
  return { status: "known", integrity: { observable: "clean", tail: "unattested" }, offers: [...offers.values()], bindings, ignored, diagnostics, audits };
}
function foldFleet(facts) {
  try {
    return foldFleetUnchecked(facts);
  } catch {
    return unknown("fleet-fold-error", [], "forbidden");
  }
}

module.exports = { FLEET_RECORD_TYPES, FOLD_ANOMALY_CAP, fleetContentError, fleetVerificationPlan, foldFleet };
