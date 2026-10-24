import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../bin/lib/entry-point.mjs";
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function runFleetFoldCases(ctx) {
  const { check, HOOKS } = ctx;
  const core = require(process.env.FLEET_FOLD_MODULE || path.join(HOOKS, "lib/fleet-fold.js"));
  const substrate = require(process.env.FLEET_COORD_MODULE || path.join(HOOKS, "lib/coordination-log.js"));
  const sign = require(path.join(HOOKS, "lib/coc-sign.js"));
  const H = "a".repeat(64), O = "10:100", W = "20:200", N = "30:300", S = "40:400", V = "admitted-fixture-key";
  const now = 1792000000, iso = t => new Date(t * 1000).toISOString();
  const sessions = [
    { pid: 10, started_at: 100, name: "orchestrator" },
    { pid: 20, started_at: 200, label: "actual-csq-label", surface: "codex" },
    { pid: 30, started_at: 300, name: "new-orchestrator" },
    { pid: 40, started_at: 400, label: "squatter" },
  ];
  const hash = r => substrate.computeOwnChainHead({ accepted: [r] }, r.verified_id).lastContentHash;
  const genesisRecord = { type: "genesis-anchor", verified_id: V, person_id: "fixture-person", seq: 0, prev_hash: null,
    ts: iso(now), content: { genesis: { repo_owner: "fixture-person", repo_owner_kind: "user", root_commit: "d".repeat(40), genesis_generation: 0 } }, sig: "explicitly-admitted-semantic-genesis" };
  const GENESIS = { index: 0, record: genesisRecord, hash: hash(genesisRecord) };
  function entry(type, content, index, prior = null, ts = now, vid = prior ? prior.record.verified_id : V, seq, anchor = GENESIS) {
    const sameSigner = vid === anchor.record.verified_id;
    const record = { type, verified_id: vid, person_id: "fixture-person", seq: seq ?? (prior ? prior.record.seq + 1 : sameSigner ? 1 : 0),
      prev_hash: prior ? prior.hash : sameSigner ? anchor.hash : null, ts: iso(ts),
      content: literals.includes(type) ? { log_id: anchor.hash, ...content } : content, sig: "explicitly-admitted-semantic-fixture" };
    return { index: index + 1, record, hash: hash(record) };
  }
  const common = session => ({ session, host: H });
  const offerContent = (o = O, supersedes = null) => ({ ...common(o), orchestrator: o, workhorse: W,
    lane: "fix/fleet", last_item: null, nonce: "b".repeat(32), expires_ts: now + 900, supersedes });
  function pair(o = O) {
    const offer = entry("fleet-offer", offerContent(o), 0);
    const accept = entry("fleet-accept", { ...common(W), workhorse: W, orchestrator: o, offer_hash: offer.hash }, 1, offer);
    return [offer, accept];
  }
  function append(rows, type, content, ts = now) {
    const e = entry(type, content, rows.length, rows.at(-1), ts); rows.push(e); return e;
  }
  function facts(entries, extra = {}) {
    entries = [GENESIS, ...entries];
    const ids = extra.rosteredVerifiedIds || [V], plan = core.fleetVerificationPlan({ entries, rosteredVerifiedIds: ids });
    return { entries, rosteredVerifiedIds: ids, verification: plan.indices.map(index => ({ index, status: "verified" })),
      liveSessions: sessions, hostHash: H, nowSeconds: now, ...extra };
  }
  const fold = (rows, extra) => core.foldFleet(facts(rows, extra));
  const bound = result => result.status === "known" && result.bindings.length === 1;
  const noBinding = result => result.status === "known" && result.bindings.length === 0;
  const code = (result, expected) => result.ignored?.some(row => row.code === expected);
  const assert = (name, ok, detail) => check("fleet-fold." + name, Boolean(ok), detail);

  const literals = ["fleet-offer", "fleet-accept", "fleet-release", "fleet-unregister", "fleet-state", "fleet-override"];
  assert("registration.six", JSON.stringify(core.FLEET_RECORD_TYPES) === JSON.stringify(literals) && Object.isFrozen(core.FLEET_RECORD_TYPES));
  for (const type of literals) {
    const m = substrate.predicateMetadataFor(type);
    assert("registration." + type, m?.checkpoint_exempt === true && m.authoritative_for_record === false && m.authoritative_for_aggregate === false);
  }
  assert("registration.no-seventh", substrate.predicateMetadataFor("fleet-roster-seen") === null);
  const p = pair();
  assert("P4.bilateral-control", bound(fold(p)));
  assert("P4.offer-only", noBinding(fold([p[0]])));
  const acceptOnly = entry("fleet-accept", p[1].record.content, 0);
  assert("P4.accept-only", noBinding(fold([acceptOnly])));
  for (const [name, change] of [["orchestrator", { orchestrator: S }], ["workhorse", { workhorse: N, session: N }]]) {
    const bad = entry("fleet-accept", { ...p[1].record.content, ...change }, 1, p[0]);
    assert("P8.accept-match-" + name, noBinding(fold([p[0], bad])) && code(fold([p[0], bad]), "offer-not-acceptable"));
  }
  {
    const rows = [p[0]], c = p[1].record.content;
    append(rows, "fleet-accept", c, now + 901);
    assert("P4.expired", noBinding(fold(rows, { nowSeconds: now + 901 })));
    assert("P4.persist", bound(fold(p, { nowSeconds: now + 3600 })));
    const early = entry("fleet-accept", c, 1, p[0], now - 1);
    assert("P4.order-time", noBinding(fold([p[0], early])));
    const lateOffer = entry("fleet-offer", offerContent(), 1);
    const reverse = entry("fleet-accept", { ...c, offer_hash: lateOffer.hash }, 0, null, now, "other-admitted-key");
    assert("P4.order-index", noBinding(fold([reverse, lateOffer], { rosteredVerifiedIds: [V, "other-admitted-key"] })));
  }
  {
    const rows = pair(); append(rows, "fleet-release", { ...common(W), binding_hash: rows[1].hash });
    append(rows, "fleet-accept", p[1].record.content);
    const result = fold(rows);
    assert("P4.replay", noBinding(result) && code(result, "offer-consumed"));
  }
  for (const [name, change, expected] of [
    ["timestamp", r => { r.ts = "2026-02-30T00:00:00.000Z"; }, "ts-malformed"],
    ["future", r => { r.ts = iso(now + 301); r.content.expires_ts = now + 900; }, "ts-future"],
    ["content-ts", r => { r.content.ts = now; }, "unexpected-field"],
    ["offer-role", r => { r.content.session = S; }, "offer-role"],
    ["offer-expiry", r => { r.content.expires_ts = now + 901; }, "offer-expiry"],
    ["nonce", r => { r.content.nonce = "bad"; }, "offer-shape"],
  ]) {
    const e = entry("fleet-offer", offerContent(), 0); change(e.record); e.hash = hash(e.record);
    const result = fold([e]); assert("P4." + name, noBinding(result) && code(result, expected));
  }
  {
    const rows = [entry("fleet-offer", offerContent(S), 0)];
    const real = append(rows, "fleet-offer", offerContent());
    append(rows, "fleet-accept", { ...common(W), workhorse: W, orchestrator: O, offer_hash: real.hash });
    assert("P5.squat", bound(fold(rows)) && fold(rows).bindings[0].orchestrator === O);
  }
  {
    const rows = pair(), old = rows[1].hash;
    const replacement = append(rows, "fleet-offer", offerContent(N, old));
    append(rows, "fleet-accept", { ...common(W), workhorse: W, orchestrator: N, offer_hash: replacement.hash });
    const dead = sessions.filter(s => s.pid !== 10), result = fold(rows, { liveSessions: dead });
    assert("P6.dead", bound(result) && result.bindings[0].orchestrator === N);
    const live = fold(rows);
    assert("P6.live", bound(live) && live.bindings[0].orchestrator === O && code(live, "supersede-not-dead"));
    assert("P6.unknown", fold(rows, { liveSessions: null }).code === "liveness-unknown");
    assert("P6.nonarray", fold(rows, { liveSessions: {} }).code === "liveness-unknown");
    const missing = [entry("fleet-offer", offerContent(N, "c".repeat(64)), 0)];
    assert("P6.reference", code(fold(missing), "supersede-not-dead"));
  }
  {
    const result = fold(p);
    assert("P7.labels", bound(result) && result.bindings[0].name === "actual-csq-label" && result.bindings[0].surface === "codex");
    const rows = pair(); append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "idle", queue: 0, last: "done" });
    append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "busy", queue: 2, last: "next" });
    assert("P8.state", fold(rows).bindings[0]?.state === "busy" && fold(rows).bindings[0]?.queue === 2);
    assert("P8.unknown-local", result.bindings[0]?.state === "unknown" && result.bindings[0]?.queue === null);
    append(rows, "fleet-state", { ...common(S), binding_hash: rows[1].hash, event: "idle", queue: 0, last: null });
    assert("P8.state-session", fold(rows).bindings[0]?.state === "busy" && code(fold(rows), "binding-role"));
    const bad = pair(); bad[1] = entry("fleet-accept", { ...bad[1].record.content, session: S }, 1, bad[0]);
    assert("P8.accept-session", noBinding(fold(bad)) && code(fold(bad), "accept-role"));
  }
  for (const [type, own, foreign] of [["fleet-release", W, O], ["fleet-unregister", O, W]]) {
    const rows = pair(); append(rows, type, { ...common(foreign), binding_hash: rows[1].hash });
    assert("P8." + type + "-foreign", bound(fold(rows)) && code(fold(rows), "binding-role"));
    append(rows, type, { ...common(own), binding_hash: rows[1].hash });
    assert("P8." + type + "-own", noBinding(fold(rows)));
  }
  {
    const rows = pair(), old = rows[1].hash, offer = append(rows, "fleet-offer", offerContent(N));
    const accepted = append(rows, "fleet-accept", { ...common(W), workhorse: W, orchestrator: N, offer_hash: offer.hash });
    append(rows, "fleet-release", { ...common(W), binding_hash: old });
    assert("P8.replacement", bound(fold(rows)) && fold(rows).bindings[0].hash === accepted.hash);
    append(rows, "fleet-release", { ...common(W), binding_hash: accepted.hash });
    assert("P8.no-resurrection", noBinding(fold(rows)));
    const audit = entry("fleet-override", { ...common(O), role: "security-review", reason_sha256: H, reason_excerpt: "bounded reason" }, 0);
    const result = fold([audit]); assert("P8.override-audit", noBinding(result) && result.audits.length === 1);
  }
  assert("projection.host", noBinding(fold(p, { hostHash: "c".repeat(64) })));
  assert("projection.dead", noBinding(fold(p, { liveSessions: sessions.filter(s => s.pid !== 20) })));
  assert("projection.empty", noBinding(fold(p, { liveSessions: [] })));
  {
    const fake = entry("fleet-offer", { ...offerContent(), name: "forged-display-name" }, 0);
    assert("P7.record-name-rejected", code(fold([fake]), "unexpected-field"));
    const named = sessions.map(s => s.pid === 20 ? { ...s, name: "actual-csq-name" } : s);
    assert("P7.name-priority", fold(p, { liveSessions: named }).bindings[0]?.name === "actual-csq-name");
    const plain = sessions.map(s => s.pid === 20 ? { pid: s.pid, started_at: s.started_at } : s);
    assert("P7.target-fallback", fold(p, { liveSessions: plain }).bindings[0]?.name === W);
    const rows = pair(), second = append(rows, "fleet-offer", { ...offerContent(), workhorse: N });
    append(rows, "fleet-accept", { ...common(N), workhorse: N, orchestrator: O, offer_hash: second.hash });
    append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "idle", queue: 0, last: null });
    const result = fold(rows);
    assert("P8.unknown-is-local", result.bindings.find(b => b.workhorse === W)?.state === "idle" && result.bindings.find(b => b.workhorse === N)?.state === "unknown");
  }
  {
    const rows = pair(), middle = append(rows, "non-fleet", {}); append(rows, "non-fleet", { log_id: GENESIS.hash });
    const result = fold(rows.filter(e => e !== middle));
    assert("P10.middle", result.code === "fleet-chain-integrity" && result.overrideDisposition === "forbidden" && result.faults[0]?.records[0]?.index === 4);
    const all = [entry("non-fleet", {}, 0)], removed = append(all, "fleet-override", { ...common(O), role: "x", reason_sha256: H, reason_excerpt: "x" });
    append(all, "non-fleet", { log_id: GENESIS.hash });
    assert("P10.allemit", fold(all.filter(e => e !== removed)).code === "fleet-chain-integrity");
    const tail = fold(rows.slice(0, 2));
    assert("P10.tail", bound(tail) && tail.integrity?.observable === "clean" && tail.integrity?.tail === "unattested");
  }
  {
    const rows = pair(), sibling = entry("non-fleet", { fork: true }, 2, rows[0], now);
    rows.push(sibling);
    const fork = fold(rows);
    assert("P10.fork", fork.code === "fleet-valid-fork" && fork.overrideDisposition === "allowed-with-audit" && fork.faults[0]?.records.length === 2 && fork.faults[0].records.every(e => e.hash && e.record));
    const f = facts(rows); f.verification.find(v => v.index === 3).status = "invalid";
    assert("P10.one-valid", bound(core.foldFleet(f)));
    const junk = [...p, sibling, entry("non-fleet", { log_id: GENESIS.hash }, 3, null, now, V, 90)];
    const jf = facts(junk); jf.verification.filter(v => v.index >= 3).forEach(v => { v.status = "invalid"; });
    const result = core.foldFleet(jf);
    assert("P10.junk", bound(result) && result.ignored.filter(e => e.code === "admission-invalid").length === 2);
    const malformed = entry("non-fleet", { malformed: "valid-seq-jump" }, 0, null, now, V, 90);
    const malformedResult = fold([malformed]);
    assert("P10.malformed-nonfleet-valid-chain-link", malformedResult.code === "fleet-chain-integrity" && malformedResult.overrideDisposition === "allowed-with-audit");
    const successor = entry("non-fleet", {}, 3, sibling); rows.push(successor);
    const unplanned = facts(rows); unplanned.verification.find(v => v.index === 3).status = "invalid";
    const exposed = core.foldFleet(unplanned);
    assert("P10.newly-exposed", exposed.code === "fleet-valid-fork" && exposed.overrideDisposition === "allowed-with-audit");
  }
  for (const [name, change] of [
    ["missing", f => f.verification.pop()], ["extra", f => f.verification.push({ index: 999, status: "verified" })],
    ["duplicate", f => f.verification.push(f.verification[0])],
  ]) { const f = facts(p); change(f); assert("P10.plan-" + name, core.foldFleet(f).code === "verification-incomplete" && core.foldFleet(f).overrideDisposition === "allowed-with-audit"); }
  {
    const f = facts(p), acceptFacts = f.verification.filter(v => v.index === p[1].index);
    assert("P3.verifier-unknown-subject-identity", acceptFacts.length === 1 && literals.includes(f.entries.find(e => e.index === acceptFacts[0].index)?.record.type));
    acceptFacts[0].status = "indeterminate";
    assert("P3.verifier-unknown", core.foldFleet(f).code === "verification-indeterminate" && core.foldFleet(f).overrideDisposition === "allowed-with-audit");
    const genesisUnknown = facts(p);
    genesisUnknown.verification.find(v => v.index === GENESIS.index).status = "indeterminate";
    const genesisResult = core.foldFleet(genesisUnknown);
    assert("P3.genesis-verifier-unknown-forbidden", genesisResult.code === "fleet-chain-integrity" && genesisResult.overrideDisposition === "forbidden" && genesisResult.faults.some(f => f.code === "genesis-unverified"));
    const unknown = entry("non-fleet", {}, 2, null, now, "not-rostered", 99);
    assert("P10.unrostered-structure-inert", bound(fold([...p, unknown])));
  }
  for (const [name, seq, prev] of [["genesis-seq", 3, null], ["genesis-prev", 0, H]]) {
    const e = entry("fleet-offer", offerContent(), 0, null, now, V, seq); e.record.prev_hash = prev; e.hash = hash(e.record);
    const result = fold([e]);
    assert("P10." + name, result.code === "fleet-chain-integrity");
    assert("R2f7." + name + "-disposition", result.overrideDisposition === (name === "genesis-seq" ? "allowed-with-audit" : "forbidden"));
  }
  for (const type of ["compaction-checkpoint", "generation-rotation"]) assert("P10." + type, fold([entry(type, {}, 0)]).code === "fleet-compaction-unsupported");
  for (const key of ["expectedHead", "highWater", "seed", "perEmitterStateSeed", "chain", "heads"]) {
    let result, threw = false; try { result = core.foldFleet({ ...facts(p), [key]: {} }); } catch { threw = true; }
    assert("P10.seedkey." + key, !threw && result?.code === "fleet-fold-error" && result.overrideDisposition === "forbidden");
  }
  const SIGNATURE_CAP = 1024;
  {
    function capped(n) {
      const rows = [];
      for (let i = 0; i < n; i++) append(rows, "fleet-override", { ...common(O), role: "cap", reason_sha256: H, reason_excerpt: "cap" });
      const f = facts(rows);
      f.verification.filter(v => v.index !== 0).forEach(v => { v.status = "invalid"; });
      const plan = core.fleetVerificationPlan({ entries: f.entries, rosteredVerifiedIds: [V] });
      return { plan, result: core.foldFleet(f) };
    }
    const at = capped(SIGNATURE_CAP - 1), over = capped(SIGNATURE_CAP);
    assert("R1.total-plan-bounded", over.plan.indices.length <= SIGNATURE_CAP);
    const include = Array.prototype.includes;
    let numericLookups = 0, controlLookups = 0;
    try {
      Array.prototype.includes = function(value, ...rest) {
        if (this.length >= SIGNATURE_CAP && typeof this[0] === "number") numericLookups++;
        return include.call(this, value, ...rest);
      };
      Array.from({ length: SIGNATURE_CAP }, (_, i) => i).includes(SIGNATURE_CAP - 1);
      controlLookups = numericLookups;
      numericLookups = 0;
      capped(SIGNATURE_CAP - 1);
      assert("R1.plan-membership-linear-index", controlLookups === 1 && numericLookups === 0);
    } finally { Array.prototype.includes = include; }
    assert("P10.signature-cap-at-measured", core.FOLD_ANOMALY_CAP === SIGNATURE_CAP && at.plan.indices.length === SIGNATURE_CAP && at.plan.candidateCount === SIGNATURE_CAP && at.plan.overflow === false && noBinding(at.result));
    assert("P10.signature-cap-over-measured", over.plan.indices.length === SIGNATURE_CAP && over.plan.candidateCount === SIGNATURE_CAP + 1 && over.plan.overflow === true && over.result.code === "fleet-anomaly-cap" && over.result.overrideDisposition === "allowed-with-audit" && over.result.count === SIGNATURE_CAP + 1 && over.result.cap === SIGNATURE_CAP);
    const rows = [];
    for (let i = 0; i < 300; i++) append(rows, "fleet-override", { ...common(O), role: "x", reason_sha256: H, reason_excerpt: "x" });
    const f = facts(rows);
    f.verification.filter(v => v.index !== 0).forEach(v => { v.status = "invalid"; });
    const plan = core.fleetVerificationPlan({ entries: f.entries, rosteredVerifiedIds: [V] });
    const inert = core.foldFleet(f);
    assert("P10.junk-300", plan.anomalyCandidates === 0 && plan.candidateCount === 301 && plan.overflow === false && noBinding(inert));
  }
  {
    const rows = [];
    for (let i = 0; i < SIGNATURE_CAP; i++) append(rows, "fleet-override", { ...common(O), role: "priority", reason_sha256: H, reason_excerpt: "priority" });
    const gap = entry("non-fleet", { gap: "priority" }, rows.length, null, now, V, SIGNATURE_CAP + 50);
    gap.record.prev_hash = H;
    gap.hash = hash(gap.record);
    const plan = core.fleetVerificationPlan({ entries: [GENESIS, ...rows, gap], rosteredVerifiedIds: [V] });
    assert("R2.gap-priority-before-fleet", plan.indices.length === SIGNATURE_CAP && plan.indices[0] === gap.index);
  }
  {
    const rows = [];
    for (let i = 0; i <= SIGNATURE_CAP; i++) {
      const gap = entry("non-fleet", { unsignedGap: i }, i, null, now, V, i + 1);
      gap.record.prev_hash = H;
      gap.record.sig = "";
      gap.hash = hash(gap.record);
      rows.push(gap);
    }
    const f = facts(rows);
    f.verification.filter(v => v.index !== 0).forEach(v => { v.status = "invalid"; });
    const result = core.foldFleet(f);
    assert("R2.signature-gap-cap-exhaustion-forbidden", f.verification.length === SIGNATURE_CAP && result.code === "fleet-gap-unresolved" && result.overrideDisposition === "forbidden");
  }
  {
    const rows = [];
    for (let i = 0; i <= SIGNATURE_CAP; i++) append(rows, "fleet-override", { ...common(O), role: "newest", reason_sha256: H, reason_excerpt: "newest" });
    const plan = core.fleetVerificationPlan({ entries: [GENESIS, ...rows], rosteredVerifiedIds: [V] });
    assert("R2.newest-fleet-first-within-budget", plan.indices.length === SIGNATURE_CAP && plan.indices[0] === rows.at(-1).index && !plan.indices.includes(rows[0].index));
    assert("R2.root-reserved-after-fleet-slice", plan.indices.length === SIGNATURE_CAP && plan.indices[0] === rows.at(-1).index && plan.indices.some(index => index === GENESIS.index) && !plan.indices.some(index => index === rows[0].index));
  }


  // ROOT24a5: invalid or unrostered bytes never establish a non-overridable fault.
  for (const type of ["compaction-checkpoint", "generation-rotation"]) {
    const rows = pair(), checkpoint = append(rows, type, {}), f = facts(rows);
    assert("R1.compaction-planned." + type, f.verification.some(v => v.index === checkpoint.index));
    f.verification.find(v => v.index === checkpoint.index).status = "invalid";
    assert("R1.compaction-invalid-inert." + type, bound(core.foldFleet(f)));
    const outsider = entry(type, {}, 2, null, now, "not-rostered", 91), of = facts([...pair(), outsider]);
    assert("R1.compaction-unrostered-inert." + type, !of.verification.some(v => v.index === 3) && bound(core.foldFleet(of)));
    const valid = fold(rows);
    assert("R1.compaction-verified-overridable." + type, valid.code === "fleet-compaction-unsupported" && valid.overrideDisposition === "allowed-with-audit");
    const sibling = entry("non-fleet", { fork: type }, 3, rows[0]);
    assert("R1.compaction-before-fork." + type, fold([...rows, sibling]).code === "fleet-compaction-unsupported");
  }
  {
    const rows = pair(), sibling = entry("non-fleet", { sibling: true }, 2, rows[0]); rows.push(sibling);
    for (let i = 0; i < 3; i++) append(rows, "non-fleet", { descendant: i });
    const f = facts(rows);
    assert("R1.descendants-all-planned", [3, 4, 5, 6].every(index => f.verification.some(v => v.index === index)));
    f.verification.filter(v => v.index >= 3).forEach(v => { v.status = "invalid"; });
    assert("R1.descendants-invalid-transitive-inert", bound(core.foldFleet(f)));
    f.verification.find(v => v.index === 6).status = "verified";
    const witnessed = core.foldFleet(f);
    assert("R1.descendants-valid-overridable", witnessed.code === "fleet-valid-fork" && witnessed.overrideDisposition === "allowed-with-audit");
  }
  {
    const rows = pair(), note = append(rows, "non-fleet", { witness: "accept" }), f = facts(rows);
    f.verification.find(v => v.index === 2).status = "invalid";
    const result = core.foldFleet(f);
    assert("R1.invalid-fleet-successor-planned", f.verification.some(v => v.index === note.index));
    assert("R1.invalid-fleet-witnessed-overridable", result.code === "fleet-invalid-witnessed" && result.overrideDisposition === "allowed-with-audit" && result.integrity?.observable !== "clean");
    const base = facts(rows); base.verification.find(v => v.index === note.index).status = "invalid";
    assert("R1.invalid-nonfleet-witness-inert", bound(core.foldFleet(base)));
  }
  {
    const junk = Array.from({ length: 2000 }, (_, i) => entry("fleet-override", { ...common(O), role: "junk", reason_sha256: H, reason_excerpt: "junk" }, i + 2, null, now, "not-rostered-" + i, i));
    const entries = [...pair(), ...junk], plan = core.fleetVerificationPlan({ entries: [GENESIS, ...entries], rosteredVerifiedIds: [V] });
    assert("R1.nonrostered-never-planned", plan.indices.every(index => index < 3));
    assert("R1.nonrostered-fleet-junk-inert", bound(fold(entries)));
    const invalidAccept = entry("fleet-accept", p[1].record.content, 1, p[0], now, "not-rostered");
    const outsiderGenesis = { index: 3, record: { ...genesisRecord, verified_id: "not-rostered", seq: 0, prev_hash: null } };
    outsiderGenesis.hash = hash(outsiderGenesis.record);
    assert("R1.membership-half-pole", noBinding(fold([p[0], invalidAccept])) && bound(fold([...p, outsiderGenesis])));
  }
  {
    const rows = pair(), removed = append(rows, "non-fleet", { middle: true }); append(rows, "non-fleet", { witness: true, log_id: GENESIS.hash });
    for (let i = 0; i <= SIGNATURE_CAP; i++) append(rows, "fleet-override", { ...common(O), role: "junk", reason_sha256: H, reason_excerpt: "junk" });
    const f = facts(rows.filter(e => e !== removed));
    const actualPlan = core.fleetVerificationPlan({ entries: f.entries, rosteredVerifiedIds: [V] });
    f.verification.filter(v => v.index > 4).forEach(v => { v.status = "invalid"; });
    const result = core.foldFleet(f);
    assert("R1.valid-deletion-before-total-cap", actualPlan.overflow === true && result.code === "fleet-chain-integrity" && result.overrideDisposition === "forbidden" && result.faults.some(f => f.records?.some(e => e.index === 4)));
  }
  {
    const f = facts(p); f.verification = null;
    assert("R1.no-verification-overridable", core.foldFleet(f).code === "verification-incomplete" && core.foldFleet(f).overrideDisposition === "allowed-with-audit");
    assert("R1.liveness-overridable", fold(p, { liveSessions: null }).code === "liveness-unknown" && fold(p, { liveSessions: null }).overrideDisposition === "allowed-with-audit");
    const empty = fold([], { rosteredVerifiedIds: [] });
    assert("R1.empty-roster-refused", empty.status === "indeterminate" && empty.code === "roster-empty" && empty.overrideDisposition === "allowed-with-audit");
    for (const session of ["20:0200", "020:200", "20:9007199254740992", "9007199254740992:200"]) {
      const record = entry("fleet-release", { ...common(session), binding_hash: H }, 0).record;
      assert("R1.noncanonical-session." + session, core.fleetContentError(record) !== null);
    }
    assert("R1.canonical-zero-start", core.fleetContentError(entry("fleet-release", { ...common("20:0"), binding_hash: H }, 0).record) === null);
  }


  {
    const noGenesis = facts(p); noGenesis.verification.find(v => v.index === 0).status = "invalid";
    const absent = core.foldFleet(noGenesis);
    assert("R1.genesis-must-be-verified", absent.status === "indeterminate" && absent.overrideDisposition === "forbidden");
    for (const mode of ["missing", "different"]) {
      const rows = pair();
      if (mode === "missing") delete rows[1].record.content.log_id; else rows[1].record.content.log_id = "f".repeat(64);
      rows[1].hash = hash(rows[1].record);
      const result = fold(rows);
      assert("R1.fleet-id-foreign." + mode, mode === "different" ? result.status === "indeterminate" && result.overrideDisposition === "forbidden" : noBinding(result) && code(result, "foreign-log-record"));
    }
    const malformedId = pair();
    malformedId[1].record.content.log_id = "not-a-hash";
    malformedId[1].hash = hash(malformedId[1].record);
    const malformedResult = fold(malformedId);
    assert("R2.malformed-log-id-inert", noBinding(malformedResult) && code(malformedResult, "foreign-log-record"));
    const rows = pair(), middle = append(rows, "non-fleet", { middle: true }), disconnected = append(rows, "non-fleet", {});
    const foreign = fold(rows.filter(e => e !== middle));
    assert("R1.fieldless-disconnected-nonfleet-foreign", foreign.code === "fleet-unanchored-witness" && foreign.overrideDisposition === "allowed-with-audit" && foreign.integrity?.observable !== "clean");
    disconnected.record.content.log_id = GENESIS.hash; disconnected.hash = hash(disconnected.record);
    const scoped = fold(rows.filter(e => e !== middle));
    assert("R1.scoped-disconnected-valid-witness-hard", scoped.code === "fleet-chain-integrity" && scoped.overrideDisposition === "forbidden");
    const linked = pair(); append(linked, "non-fleet", {});
    assert("R1.fieldless-linked-nonfleet-control", bound(fold(linked)) && !code(fold(linked), "foreign-log-record"));
    const payloads = {
      "fleet-offer": offerContent(), "fleet-accept": { ...common(W), workhorse: W, orchestrator: O, offer_hash: H },
      "fleet-release": { ...common(W), binding_hash: H }, "fleet-unregister": { ...common(O), binding_hash: H },
      "fleet-state": { ...common(W), binding_hash: H, event: "busy", queue: 1, last: null },
      "fleet-override": { ...common(O), role: "x", reason_sha256: H, reason_excerpt: "x" },
    };
    for (const type of literals) {
      const row = entry(type, payloads[type], 0);
      assert("R1.scoped-content-control." + type, core.fleetContentError(row.record) === null);
      delete row.record.content.log_id; row.hash = hash(row.record);
      assert("R1.scoped-content-required." + type, core.fleetContentError(row.record) === "missing-field");
      row.record.content.log_id = "f".repeat(64); row.hash = hash(row.record);
      const mismatch = fold([row]); assert("R1.scoped-content-mismatch-foreign." + type, mismatch.status === "indeterminate" && mismatch.overrideDisposition === "forbidden");
    }
    const second = { index: 9, record: { ...genesisRecord, verified_id: "another-genesis-owner", content: { genesis: { ...genesisRecord.content.genesis, root_commit: "e".repeat(40) } } } };
    second.hash = hash(second.record);
    const ambiguous = fold([...pair(), second], { rosteredVerifiedIds: [V, "another-genesis-owner"] });
    assert("R1.distinct-genesis-ambiguous", ambiguous.code === "fleet-genesis-ambiguous" && ambiguous.overrideDisposition === "allowed-with-audit");
    const duplicate = { ...GENESIS, index: 9 };
    assert("R1.exact-genesis-replay-dedup", bound(fold([...pair(), duplicate])));
  }


  {
    const rows = pair(), middle = append(rows, "non-fleet", { root2f7: "N" });
    const successor = append(rows, "non-fleet", { root2f7: "W", log_id: GENESIS.hash });
    const clean = fold(rows);
    assert("R2f7.verified-hash-matched-predecessor-clean", bound(clean) && clean.integrity?.observable === "clean");
    for (const mode of ["unsigned", "wrong-signer"]) {
      const planted = { ...middle, record: { ...middle.record, content: { junk: mode, log_id: GENESIS.hash }, sig: "" } };
      if (mode === "wrong-signer") planted.record.verified_id = "not-rostered";
      planted.hash = hash(planted.record);
      assert("R2f7.planted-hash-differs." + mode, planted.hash !== middle.hash && successor.record.prev_hash === middle.hash);
      const f = facts([rows[0], rows[1], planted, successor]); const marked = f.verification.find(v => v.index === planted.index); if (marked) marked.status = "invalid";
      const result = core.foldFleet(f);
      assert("R2f7.delete-plus-nonmatching-junk-forbidden." + mode, result.code === "fleet-chain-integrity" && result.overrideDisposition === "forbidden" && result.faults.some(f => f.records?.some(e => e.hash === successor.hash)));
      const onlyJunk = facts([planted, successor]); onlyJunk.verification.filter(v => v.index !== 0).forEach(v => { v.status = "invalid"; });
      const inert = core.foldFleet(onlyJunk);
      assert("R2f7.junk-only-never-forbidden." + mode, noBinding(inert) && inert.overrideDisposition !== "forbidden");
      onlyJunk.verification.forEach(v => { v.status = "invalid"; });
      const unverified = core.foldFleet(onlyJunk);
      assert("R2f7.no-unverified-authority." + mode, unverified.code === "fleet-genesis-unavailable" && unverified.overrideDisposition === "allowed-with-audit");
    }
    const present = facts(rows); present.verification.find(v => v.index === middle.index).status = "invalid";
    const invalid = core.foldFleet(present);
    assert("R2f7.present-invalid-nonfleet-witnessed", invalid.code === "fleet-invalid-witnessed" && invalid.overrideDisposition === "allowed-with-audit" && invalid.integrity?.observable !== "clean");
  }

  const r2Hard = r => r?.status === "indeterminate" && r.overrideDisposition === "forbidden";
  const r2Audit = r => r?.status === "indeterminate" && r.overrideDisposition === "allowed-with-audit" && r.integrity?.observable !== "clean";
  const r2Mentions = (r, e) => r.faults?.some(f => f.records?.some(w => w.hash === e.hash));
  function r2Facts(entries, invalid = new Set(), ids = [V]) {
    const plan = core.fleetVerificationPlan({ entries, rosteredVerifiedIds: ids });
    return { entries, rosteredVerifiedIds: ids, verification: plan.indices.map(index => ({ index, status: invalid.has(index) ? "invalid" : "verified" })), liveSessions: sessions, hostHash: H, nowSeconds: now };
  }
  function r2Honest(n) {
    const rows = [];
    for (let i = 0; i < n; i++) append(rows, "non-fleet", { honest: i });
    const offer = append(rows, "fleet-offer", offerContent());
    const accept = append(rows, "fleet-accept", { ...common(W), workhorse: W, orchestrator: O, offer_hash: offer.hash });
    return { rows, accept };
  }
  for (const n of [300, 1000]) {
    const { rows } = r2Honest(n), plan = core.fleetVerificationPlan({ entries: [GENESIS, ...rows], rosteredVerifiedIds: [V] });
    assert("R2.honest-prefix-known." + n, bound(fold(rows)));
    assert("R2.crypto-plan-not-full-history." + n, plan.candidateCount <= 1 + 3 * 2);
  }
  {
    const { rows, accept } = r2Honest(1000);
    const release = append(rows, "fleet-release", { ...common(W), binding_hash: accept.hash });
    const note = append(rows, "non-fleet", { ordinary: true });
    append(rows, "fleet-state", { ...common(W), binding_hash: accept.hash, event: "busy", queue: 1, last: "after-note" });
    assert("R2.long-chain-release-control", noBinding(fold(rows)));
    const deletion = fold(rows.filter(e => e !== release));
    assert("R2.deletion-beyond-256-forbidden", r2Hard(deletion) && r2Mentions(deletion, note));
  }
  {
    const rows = pair(), middle = append(rows, "non-fleet", { middle: true });
    const witness = append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "busy", queue: 1, last: null });
    const kept = rows.filter(e => e !== middle), junk = [];
    for (let i = 0; i < 300; i++) {
      const e = entry("non-fleet", { unsigned: i }, i, null, now, V, i + 5000);
      e.record.prev_hash = "f".repeat(64); e.record.sig = ""; e.hash = hash(e.record); junk.push(e);
    }
    const shifted = kept.map(e => ({ ...e, index: e.index + 300 }));
    const f = r2Facts([GENESIS, ...junk, ...shifted], new Set(junk.map(e => e.index)));
    const result = core.foldFleet(f);
    assert("R2.unsigned-before-witness-forbidden", r2Hard(result));
    assert("R2.gaps-before-ordinary-plan-priority", f.verification.some(v => v.index === witness.index + 300) || result.code === "fleet-gap-unresolved");
  }
  {
    const rows = pair(), middle = append(rows, "non-fleet", { middle: true });
    const witness = append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "busy", queue: 1, last: null });
    const kept = rows.filter(e => e !== middle);
    const invalidGenesis = core.foldFleet(r2Facts([GENESIS, ...kept], new Set([0])));
    assert("R2.invalid-genesis-does-not-preempt-gap", r2Hard(invalidGenesis) && r2Mentions(invalidGenesis, witness));
    const absentGenesis = core.foldFleet(r2Facts(kept));
    assert("R2.deleted-genesis-does-not-preempt-gap", r2Hard(absentGenesis) && absentGenesis.code === "fleet-genesis-missing");
    const onlyGenesisGone = core.foldFleet(r2Facts(rows));
    assert("R2.deleted-genesis-linked-fleet-forbidden", r2Hard(onlyGenesisGone) && onlyGenesisGone.code === "fleet-genesis-missing");
  }
  for (const victimType of ["fleet-accept", "fleet-release"]) {
    const rows = pair();
    const victim = victimType === "fleet-accept" ? rows[1] : append(rows, "fleet-release", { ...common(W), binding_hash: rows[1].hash });
    const ordinary = append(rows, "non-fleet", { ordinary: victimType });
    const detached = rows.filter(e => e !== victim), unanchored = fold(detached);
    assert("R2.fieldless-gap-unanchored." + victimType, unanchored.code === "fleet-unanchored-witness" && r2Audit(unanchored));
    append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "busy", queue: 1, last: "attesting-descendant" });
    const anchored = fold(rows.filter(e => e !== victim));
    assert("R2.fieldless-gap-descendant-anchored." + victimType, r2Hard(anchored) && r2Mentions(anchored, ordinary));
  }
  {
    const rows = pair(), a = append(rows, "non-fleet", { sibling: "a" });
    const b = entry("non-fleet", { sibling: "b" }, 3, rows[1]); rows.push(b);
    append(rows, "non-fleet", { log_id: GENESIS.hash }, now);
    const f = facts(rows); f.verification.filter(v => v.index === a.index || v.index === b.index).forEach(v => { v.status = "invalid"; });
    const result = core.foldFleet(f);
    assert("R2.N3.invalid-siblings-verified-child", result.code === "fleet-invalid-witnessed" && r2Audit(result));
  }
  {
    const offer = entry("fleet-offer", offerContent(), 0), before = entry("non-fleet", {}, 1, offer);
    const accept = entry("fleet-accept", { ...common(W), workhorse: W, orchestrator: O, offer_hash: offer.hash }, 2, null, now, "second-rostered-key", 0);
    const unregister = entry("fleet-unregister", { ...common(O), binding_hash: accept.hash }, 3, before);
    const ids = [V, "second-rostered-key"], base = core.foldFleet(r2Facts([GENESIS, offer, before, accept, unregister], new Set(), ids));
    assert("R2.duplicate-unregister-control", noBinding(base));
    const early = { ...unregister, index: 3 }, laterAccept = { ...accept, index: 4 }, genuine = { ...unregister, index: 5 };
    const attack = core.foldFleet(r2Facts([GENESIS, offer, before, early, laterAccept, genuine], new Set(), ids));
    assert("R2.early-duplicate-unregister-no-resurrection", noBinding(attack) || (attack.code === "fleet-duplicate-record" && r2Audit(attack)));
    const benign = core.foldFleet(r2Facts([GENESIS, offer, before, accept, unregister, { ...unregister, index: 5 }], new Set(), ids));
    assert("R2.benign-duplicate-known-audited", noBinding(benign) && benign.audits?.some(a => a.code === "duplicate-copy"));
    const states = pair(), busy = append(states, "fleet-state", { ...common(W), binding_hash: states[1].hash, event: "busy", queue: 1, last: "busy" });
    append(states, "fleet-state", { ...common(W), binding_hash: states[1].hash, event: "idle", queue: 0, last: "idle" });
    states.push({ ...busy, index: states.length + 1 });
    const ambiguous = fold(states);
    assert("R2.duplicate-state-outcome-change-audited", ambiguous.code === "fleet-duplicate-record" && r2Audit(ambiguous));
  }
  for (const [name, value] of [["null", null], ["array", []], ["missing", {}], ["bad-entries", { entries: null, rosteredVerifiedIds: [] }], ["getter", new Proxy({}, { get() { throw new Error("controlled input getter"); } })]]) {
    let decision, failure = null; try { decision = core.foldFleet(value); } catch (e) { failure = String(e); }
    assert("R2.fold-never-throws." + name, !failure && decision?.code === "fleet-fold-error" && r2Hard(decision));
    let plan, planFailure = null; try { plan = core.fleetVerificationPlan(value); } catch (e) { planFailure = String(e); }
    assert("R2.plan-never-throws." + name, !planFailure && plan?.ok === false && plan.code === "fleet-plan-error" && typeof plan.reason === "string" && plan.reason.length <= 200 && Array.isArray(plan.plan) && plan.plan.length === 0 && Object.keys(plan).sort().join(",") === "code,ok,plan,reason");
  }
  {
    const n = 16000, parent = entry("fleet-override", { ...common(O), role: "unsigned", reason_sha256: H, reason_excerpt: "unsigned" }, 0);
    parent.record.sig = ""; parent.hash = hash(parent.record);
    const rows = Array.from({ length: n }, (_, i) => ({ ...parent, index: i + 1 }));
    for (let i = 0; i < n; i++) { const e = entry("non-fleet", { child: i }, i + n, parent); e.record.sig = ""; e.hash = hash(e.record); rows.push(e); }
    const push = Array.prototype.push; let work = 0, limit = 64 * 256, opposite = false, result, failure = null;
    try {
      Array.prototype.push = function(...items) { work += items.length; if (work > limit) throw new Error("fixture edge work bound reached"); return push.apply(this, items); };
      try { for (let i = 0; i < 256; i++) { const q = []; for (let j = 0; j < 256; j++) q.push(j); } } catch (e) { opposite = e.message === "fixture edge work bound reached"; }
      limit = 64 * 32001; work = 0;
      try { const f = r2Facts([GENESIS, ...rows], new Set(rows.map(e => e.index))); result = core.foldFleet(f); } catch (e) { failure = String(e); }
    } finally { Array.prototype.push = push; }
    assert("R2.duplicate-parent-32001-linear", opposite && !failure && result?.code !== "fleet-fold-error" && work <= 64 * 32001);
  }
  {
    const empty = core.foldFleet(r2Facts([]));
    assert("R2.no-fleet-no-genesis-known-empty", noBinding(empty));
    const rows = pair();
    const blankOnly = core.foldFleet(r2Facts([GENESIS, ...rows], new Set([0])));
    assert("R2.only-genesis-unverified-forbidden", r2Hard(blankOnly));
    const foreign = entry("fleet-offer", { ...offerContent(), log_id: "e".repeat(64) }, 0);
    foreign.record.prev_hash = "f".repeat(64); foreign.hash = hash(foreign.record);
    const inert = fold([foreign]);
    assert("R2.disconnected-foreign-fleet-inert", noBinding(inert) && code(inert, "foreign-log-record"));
    const ordinary = entry("non-fleet", { log_id: "e".repeat(64) }, 0, null, now, V, 1);
    ordinary.record.prev_hash = "f".repeat(64); ordinary.hash = hash(ordinary.record);
    const ordinaryResult = fold([ordinary]);
    assert("R2.nonfleet-foreign-log-id-gap-unanchored", ordinaryResult.code === "fleet-unanchored-witness" && ordinaryResult.overrideDisposition === "allowed-with-audit" && ordinaryResult.integrity?.observable !== "clean");
  }
  {
    const rows = pair(), middle = append(rows, "non-fleet", { omitted: true });
    const witness = append(rows, "non-fleet", { log_id: GENESIS.hash });
    append(rows, "fleet-state", { ...common(W), binding_hash: rows[1].hash, event: "busy", queue: 1, last: "anchor" });
    const unrelated = append(rows, "fleet-override", { ...common(O), role: "unrelated", reason_sha256: H, reason_excerpt: "unrelated" });
    const full = facts(rows), partial = facts(rows.filter(e => e !== middle));
    full.verification = full.verification.filter(v => v.index !== unrelated.index);
    partial.verification = partial.verification.filter(v => v.index !== unrelated.index);
    const ordinary = core.foldFleet(full), hard = core.foldFleet(partial);
    assert("R2.partial-verification-no-gap-control", ordinary.code === "verification-incomplete" && r2Audit(ordinary));
    assert("R2.hard-gap-before-unrelated-missing-verification", r2Hard(hard) && r2Mentions(hard, witness));
  }

  // Real SSH admission, unlike the explicitly admitted semantic facts above.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-fold-keys-"));
  try {
  const keys = [];
  for (const name of ["enrolled", "other"]) {
    const file = path.join(dir, name), generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { encoding: "utf8", timeout: 10000 });
    if (generated.status !== 0) throw new Error("real key generation failed: " + generated.stderr);
    const pub = fs.readFileSync(file + ".pub", "utf8").trim();
    const fingerprint = spawnSync("ssh-keygen", ["-lf", file + ".pub"], { encoding: "utf8", timeout: 10000 });
    const fp = fingerprint.stdout?.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0];
    if (fingerprint.status !== 0 || !fp) throw new Error("real fingerprint derivation failed");
    keys.push({ file, pub, fp });
  }
  const roster = { genesis: { repo_owner: "fixture-person", repo_owner_kind: "user", root_commit: "d".repeat(40), genesis_generation: 0 },
    persons: { "fixture-person": { display_id: "fixture-person", role: "owner", github_login: "fixture-person", host_role: "human",
      keys: [{ type: "ssh", fingerprint: keys[0].fp, pubkey: keys[0].pub }] } } };
  function signed(e, key = keys[0]) {
    const { sig, ...record } = e.record, result = sign.sign(sign.canonicalSerialize(record), { keyType: "ssh", keyPath: key.file });
    if (!result.ok) throw new Error("actual signing failed: " + result.error);
    return { ...e, record: { ...record, sig: result.sig }, hash: hash(record) };
  }
  const realGenesis = signed({ index: 0, record: { ...genesisRecord, verified_id: keys[0].fp }, hash: GENESIS.hash });
  const genesisFold = substrate.createEngine().foldLog([realGenesis.record], roster, {});
  assert("R1.real-genesis-owner-bound", genesisFold.accepted.length === 1 && Boolean(genesisFold.foldState.trustRoot));
  function realEntry(type, content, index, prior = null, ts = now, vid = prior ? prior.record.verified_id : keys[0].fp, seq) {
    return entry(type, content, index, prior, ts, vid, seq, realGenesis);
  }
  function realFacts(entries, anchor = realGenesis, admissionRoster = roster) {
    entries = [...(anchor ? [anchor] : []), ...entries].map(e => ({ ...e, hash: hash(e.record) }));
    const ids = [keys[0].fp], plan = core.fleetVerificationPlan({ entries, rosteredVerifiedIds: ids });
    const verification = plan.indices.map(index => {
      const e = entries.find(e => e.index === index), r1 = substrate._internal._verifyRule1(e.record, admissionRoster, {});
      const r4 = r1.ok ? substrate._internal._checkRule4(e.record, r1.resolvedPerson) : null;
      let ownerBound = true;
      if (e.record.type === "genesis-anchor") {
        const admission = substrate.createEngine().foldLog([e.record], admissionRoster, {}), root = admission.foldState?.trustRoot;
        ownerBound = admission.accepted.some(record => hash(record) === e.hash) && Boolean(root) &&
          root.verified_id === e.record.verified_id && root.person_id === e.record.person_id && root.seq === e.record.seq;
      }
      return { index, status: r1.indeterminate ? "indeterminate" : r1.ok && r4.ok && ownerBound ? "verified" : "invalid" };
    });
    return { entries, rosteredVerifiedIds: ids, verification, liveSessions: sessions, hostHash: H, nowSeconds: now };
  }
  const realFold = (entries, extra = {}) => core.foldFleet({ ...realFacts(entries), ...extra });
  for (const mode of ["nonowner", "wrong-genesis"]) {
    const admissionRoster = structuredClone(roster);
    let anchor = realGenesis;
    if (mode === "nonowner") admissionRoster.persons["fixture-person"].role = "contributor";
    else anchor = signed({ ...realGenesis, record: { ...realGenesis.record, content: { genesis: { ...realGenesis.record.content.genesis, root_commit: "e".repeat(40) } } } });
    const signature = substrate._internal._verifyRule1(anchor.record, admissionRoster, {}), person = signature.ok ? substrate._internal._checkRule4(anchor.record, signature.resolvedPerson) : null;
    assert("R1.genesis-signature-only-positive." + mode, signature.ok && person?.ok);
    const f = realFacts([], anchor, admissionRoster), result = core.foldFleet(f);
    assert("R1.genesis-ownerbind-invalid-status." + mode, f.verification.find(v => v.index === 0)?.status === "invalid");
    assert("R1.genesis-ownerbind-no-authority." + mode, result.code === "fleet-genesis-unavailable" && result.overrideDisposition === "allowed-with-audit");
  }
  const realOffer = signed(realEntry("fleet-offer", offerContent(), 0, null, now, keys[0].fp));
  const realAccept = signed(realEntry("fleet-accept", { ...common(W), workhorse: W, orchestrator: O, offer_hash: realOffer.hash }, 1, realOffer));
  assert("P3.signed-control", bound(realFold([realOffer, realAccept])));
  {
    const claimed = { ...realAccept, hash: "f".repeat(64) }, facts = realFacts([realOffer, claimed]);
    const observed = facts.entries.find(e => e.index === realAccept.index);
    assert("R1.real-adapter-rehashes-copied-entry", observed.hash === hash(realAccept.record) && observed.hash !== claimed.hash && bound(core.foldFleet(facts)));
  }
  for (const type of literals) {
    const registered = signed(realEntry(type, {}, 0, null, now, keys[0].fp));
    const engine = substrate.createEngine(), before = engine.foldLog([realGenesis.record], roster, {}), after = engine.foldLog([realGenesis.record, registered.record], roster, {});
    assert("registration.noop." + type, after.accepted.length === before.accepted.length + 1 && after.rejected.length === 0 && JSON.stringify(after.foldState) === JSON.stringify(before.foldState));
  }
  for (const name of ["unsigned", "wrong-key", "unrostered", "person-mismatch"]) {
    let bad = { ...realAccept, record: { ...realAccept.record } };
    if (name === "unsigned") bad.record.sig = "";
    if (name === "wrong-key") bad = signed(bad, keys[1]);
    if (name === "unrostered") { bad.record.verified_id = keys[1].fp; bad = signed(bad, keys[1]); }
    if (name === "person-mismatch") { bad.record.person_id = "somebody-else"; bad = signed(bad); }
    bad.hash = hash(bad.record);
    const result = realFold([realOffer, bad]);
    assert("P3." + name, noBinding(result) && code(result, "admission-invalid"));
  }
  for (const type of ["fleet-accept", "fleet-release"]) {
    const rows = [realOffer, realAccept];
    const victim = type === "fleet-accept" ? realAccept : signed(realEntry("fleet-release", { ...common(W), binding_hash: realAccept.hash }, 2, realAccept));
    if (type === "fleet-release") rows.push(victim);
    const witness = signed(realEntry("non-fleet", { witness: type, log_id: realGenesis.hash }, rows.length, rows.at(-1))); rows.push(witness);
    assert("R1.signed-witness-control." + type, type === "fleet-release" ? noBinding(realFold(rows)) : bound(realFold(rows)));
    const invalid = { ...victim, record: { ...victim.record, sig: "" } }; invalid.hash = hash(invalid.record);
    assert("R1.sig-corruption-keeps-chain-hash." + type, invalid.hash === victim.hash);
    const corrupted = rows.map(e => e === victim ? invalid : e), result = realFold(corrupted);
    assert("R1.signed-invalid-witnessed." + type, result.code === "fleet-invalid-witnessed" && result.overrideDisposition === "allowed-with-audit" && result.integrity?.observable !== "clean");
    const deletion = realFold(rows.filter(e => e !== victim));
    assert("R1.signed-deletion-control." + type, deletion.code === "fleet-chain-integrity" && deletion.overrideDisposition === "forbidden");
  }

  for (const mode of ["missing", "different"]) {
    const record = { ...realAccept.record, content: { ...realAccept.record.content } };
    if (mode === "missing") delete record.content.log_id; else record.content.log_id = "f".repeat(64);
    const foreign = signed({ ...realAccept, record });
    const result = realFold([realOffer, foreign]);
    assert("R1.signed-foreign-fleet." + mode, mode === "different" ? result.status === "indeterminate" && result.overrideDisposition === "forbidden" : noBinding(result) && code(result, "foreign-log-record"));
  }
  {
    const malformed = signed({ ...realAccept, record: { ...realAccept.record, content: { ...realAccept.record.content, log_id: "not-a-hash" } } });
    const result = realFold([realOffer, malformed]);
    assert("R2.signed-malformed-log-id-inert", noBinding(result) && code(result, "foreign-log-record"));
  }
  {
    const release = signed(realEntry("fleet-release", { ...common(W), binding_hash: realAccept.hash }, 2, realAccept));
    const detached = signed(realEntry("non-fleet", {}, 3, release));
    const foreign = realFold([realOffer, realAccept, detached]);
    assert("R1.signed-fieldless-foreign-control", foreign.code === "fleet-unanchored-witness" && foreign.overrideDisposition === "allowed-with-audit" && foreign.integrity?.observable !== "clean");
    const scoped = signed({ ...detached, record: { ...detached.record, content: { log_id: realGenesis.hash } } });
    const hard = realFold([realOffer, realAccept, scoped]);
    assert("R1.signed-scoped-deletion-control", hard.code === "fleet-chain-integrity" && hard.overrideDisposition === "forbidden");
  }


  {
    const middle = signed(realEntry("non-fleet", { root2f7: "N" }, 2, realAccept));
    const successor = signed(realEntry("non-fleet", { root2f7: "W", log_id: realGenesis.hash }, 3, middle));
    assert("R2f7.signed-matched-predecessor-clean", bound(realFold([realOffer, realAccept, middle, successor])));
    const invalid = { ...middle, record: { ...middle.record, sig: "" } }; invalid.hash = hash(invalid.record);
    assert("R2f7.signed-invalid-nonfleet-hash-present", invalid.hash === middle.hash);
    const witnessed = realFold([realOffer, realAccept, invalid, successor]);
    assert("R2f7.signed-present-invalid-nonfleet-witnessed", witnessed.code === "fleet-invalid-witnessed" && witnessed.overrideDisposition === "allowed-with-audit");
    const junk = { ...invalid, record: { ...invalid.record, content: { junk: "unsigned", log_id: realGenesis.hash } } }; junk.hash = hash(junk.record);
    const gone = realFold([realOffer, realAccept, junk, successor]);
    assert("R2f7.signed-delete-plus-nonmatching-junk-forbidden", gone.code === "fleet-chain-integrity" && gone.overrideDisposition === "forbidden");
    const falsePresence = { ...junk, hash: middle.hash };
    const actual = realFold([realOffer, realAccept, falsePresence, successor]);
    assert("R2f7.claimed-hash-cannot-fake-presence", actual.code === "fleet-chain-integrity" && actual.overrideDisposition === "forbidden");
  }

  {
    const rows = [realOffer, realAccept], middle = signed(realEntry("non-fleet", { ordinary: "middle" }, 2, realAccept)); rows.push(middle);
    const witness = signed(realEntry("fleet-state", { ...common(W), binding_hash: realAccept.hash, event: "busy", queue: 1, last: "after" }, 3, middle)); rows.push(witness);
    assert("R2.signed-gap-control", bound(realFold(rows)));
    const removed = rows.filter(e => e !== middle), blank = { ...realGenesis, record: { ...realGenesis.record, sig: "" } };
    assert("R2.signed-blank-genesis-keeps-hash", hash(blank.record) === realGenesis.hash);
    const blankResult = core.foldFleet(realFacts(removed, blank));
    assert("R2.signed-blank-genesis-gap-forbidden", r2Hard(blankResult) && r2Mentions(blankResult, witness));
    const missing = core.foldFleet(realFacts(removed, null));
    assert("R2.signed-deleted-genesis-gap-forbidden", r2Hard(missing) && missing.code === "fleet-genesis-missing");
  }
  for (const victimType of ["fleet-accept", "fleet-release"]) {
    const rows = [realOffer, realAccept];
    const victim = victimType === "fleet-accept" ? realAccept : signed(realEntry("fleet-release", { ...common(W), binding_hash: realAccept.hash }, 2, realAccept));
    if (victimType === "fleet-release") rows.push(victim);
    const note = signed(realEntry("non-fleet", { ordinary: victimType }, rows.length, rows.at(-1))); rows.push(note);
    const detached = rows.filter(e => e !== victim), unanchored = realFold(detached);
    assert("R2.signed-fieldless-unanchored." + victimType, unanchored.code === "fleet-unanchored-witness" && r2Audit(unanchored));
    rows.push(signed(realEntry("fleet-state", { ...common(W), binding_hash: realAccept.hash, event: "busy", queue: 1, last: "descendant" }, rows.length, rows.at(-1))));
    const anchored = realFold(rows.filter(e => e !== victim));
    assert("R2.signed-fieldless-descendant-forbidden." + victimType, r2Hard(anchored) && r2Mentions(anchored, note));
  }

  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert("R1.private-key-dir-removed", !fs.existsSync(dir));
}

if (isMainModule(import.meta.url)) {
  let failures = 0, total = 0;
  await runFleetFoldCases({ HOOKS: path.resolve(HERE, "../../hooks"), check(name, ok, detail) {
    total++; if (!ok) failures++; console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " " + detail : ""));
  } });
  console.log(`fleet-fold: ${total} cases, ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
}
