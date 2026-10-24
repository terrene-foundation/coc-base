const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { assertStateDirContained, writeFileHardened, readFileHardened } = require("./state-io.js");

const PROBE_TIMEOUT_MS = 1500;
// ONE absolute deadline governs a session probe: the caller's fallback fires AT it, and
// every probe child must be dead by deadline - PROBE_MARGIN_MS. A child whose own timer
// started late (pre-spawn work) is cut at the shared inner deadline, and no child spawns
// after it, so the fallback can never win while a child it does not know about is alive.
const SESSION_BUDGET_MS = 1600;
const PROBE_MARGIN_MS = 100;
const CACHE_TTL_MS = 10 * 60 * 1000;
// ROOT's Wave-1 contract: change only when kailash-rs publishes a feature flag.
const LLM_FEATURE = Object.freeze({ outcome: "undetermined", reason: "llm-feature-unobservable" });
const sessions = new Map();
// Process-group ids of probe children still running, keyed by the pgid recorded at
// spawn (detached => pgid === child.pid). killOutstanding signals ONLY these groups.
const outstanding = new Set();

// Runs inside session-start's finally, so it never throws: a group that cannot be
// signalled (ESRCH: already gone; EPERM: not ours to signal) is dropped from the
// registry, and the loop still reaches every later group.
function killOutstanding() {
  for (const pgid of [...outstanding]) {
    try { process.kill(-pgid, "SIGKILL"); }
    catch { /* Cleanup is best-effort per group; one failure must not strand the rest. */ }
    finally { outstanding.delete(pgid); }
  }
}

function budget(deadline) {
  if (deadline === undefined) return PROBE_TIMEOUT_MS;
  return Math.min(PROBE_TIMEOUT_MS, deadline - PROBE_MARGIN_MS - performance.now());
}

function command(binary, args, cwd, deadline) {
  return new Promise((resolve, reject) => {
    let child, timer, stdout = "", settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) outstanding.delete(child.pid);
      resolve(result);
    };
    const stop = (reason) => {
      if (settled) return;
      try {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
        finish({ outcome: "undetermined", reason });
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        outstanding.delete(child.pid);
        reject(error);
      }
    };
    const env = {};
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.PATH = (env.PATH || "").split(path.delimiter)
      .filter((entry) => entry && entry !== "." && path.isAbsolute(entry)).join(path.delimiter);
    if (budget(deadline) <= 0) return finish({ outcome: "undetermined", reason: "timeout" });
    try {
      child = spawn(binary, args, { cwd: os.tmpdir(), env, detached: true,
        stdio: ["ignore", "pipe", "ignore"] });
      if (child.pid !== undefined) outstanding.add(child.pid);
      // Read the budget AFTER spawn returns: a slow spawn spends the shared deadline too.
      timer = setTimeout(() => {
        stop("timeout");
      }, Math.max(0, budget(deadline)));
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 65536) {
          stop("output-limit");
        }
      });
      child.on("error", (error) => finish({ outcome: error.code === "ENOENT" ? "unavailable" : "undetermined",
        reason: error.code === "ENOENT" ? "not-installed" : "spawn-error" }));
      child.on("close", (code) => finish(code === 0
        ? { outcome: "available", reason: "ok", stdout }
        : { outcome: code === 2 || code === null ? "undetermined" : "unavailable", reason: code === null ? "crash" : `exit-${code}` }));
    } catch {
      finish({ outcome: "undetermined", reason: "spawn-error" });
    }
  });
}

function result(kind, verdict, raisedRung) {
  return { kind, outcome: verdict.outcome, reason: verdict.reason,
    rung: verdict.outcome === "available" ? raisedRung : "R0", probed_at: new Date().toISOString() };
}

async function probeBroker(cwd, deadline) {
  const verdict = await command("csq", ["api", "status", "--json"], cwd, deadline);
  if (verdict.outcome === "available") {
    try {
      const status = JSON.parse(verdict.stdout);
      if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("status-shape");
    } catch { return result("csq", { outcome: "undetermined", reason: "unparseable" }, "B1"); }
  }
  return result("csq", verdict, "B1");
}

// `ollama list` NAMEs always carry a tag; an untagged id means the registry's :latest.
// A ':' inside the last path segment is a tag, one before a '/' is a registry port.
// Linear on purpose: this runs synchronously inside the session deadline.
function ollamaTag(name) {
  return name.slice(name.lastIndexOf("/") + 1).includes(":") ? name : `${name}:latest`;
}

async function probeOllama(cwd, tiers, deadline) {
  const models = tiers.filter((tier) => tier.provider === "local").map((tier) => tier.model_id);
  if (!models.length) return result("ollama", { outcome: "unavailable", reason: "slot-empty" }, "E1");
  const verdict = await command("ollama", ["list"], cwd, deadline);
  if (verdict.outcome !== "available") return result("ollama", verdict, "E1");
  const rows = verdict.stdout.trim().split(/\r?\n/);
  if (!/^NAME\s+ID\s+SIZE\s+MODIFIED\s*$/.test(rows[0])) {
    return result("ollama", { outcome: "undetermined", reason: "unparseable" }, "E1");
  }
  const installed = rows.slice(1).map((line) => ollamaTag(line.trim().split(/\s+/)[0]));
  const available = models.some((model) => installed.includes(ollamaTag(model)));
  return result("ollama", { outcome: available ? "available" : "unavailable",
    reason: available ? "model-installed" : "model-not-installed" }, "E1");
}

async function probeEngine(cwd, locator, deadline) {
  if (!locator) return result("engine", { outcome: "unavailable", reason: "no-locator" }, "R2");
  const imported = await command("python3", ["-I", "-c", "import kailash.distill as d; d.GovernedDistiller"], cwd, deadline);
  if (imported.outcome !== "available") {
    return result("engine", imported.reason === "timeout" ? imported
      : { outcome: "unavailable", reason: "engine-not-installed" }, "R2");
  }
  return result("engine", LLM_FEATURE, "R2");
}

async function probeAll({ cwd, sessionId, deadline }) {
  const root = fs.realpathSync(cwd);
  const key = `${root}:${sessionId || "unknown"}`;
  const previous = sessions.get(key);
  if (previous && Date.now() - previous.started < CACHE_TTL_MS) return previous.promise;
  const dir = path.join(root, ".claude", "learning", "accel");
  const file = path.join(dir, crypto.createHash("sha256").update(key).digest("hex") + ".jsonl");
  if (assertStateDirContained(path.dirname(dir)).ok && assertStateDirContained(dir).ok) {
    const cached = readFileHardened(file, { maxBytes: 65536 });
    if (cached.ok) {
      try {
        const records = JSON.parse(cached.value.toString()).probes;
        if (Array.isArray(records) && records.length === 3 && records.every((record, index) =>
          record.kind === ["engine", "ollama", "csq"][index] &&
          ["available", "unavailable", "undetermined"].includes(record.outcome) &&
          typeof record.reason === "string" && Date.now() - Date.parse(record.probed_at) >= 0 &&
          Date.now() - Date.parse(record.probed_at) < CACHE_TTL_MS)) return records;
      } catch { /* Invalid advisory cache is re-probed; no verdict is accepted. */ }
    }
  }
  const promise = (async () => {
    const config = await import(pathToFileURL(path.resolve(__dirname, "../../bin/lib/ecosystem-config.mjs")));
    let locator, tiers;
    try { locator = config.getRagReservoirLocator(); tiers = config.getRagEmbedding(); }
    catch { return ["engine", "ollama", "csq"].map((kind) => result(kind,
      { outcome: "unavailable", reason: "config-error:rag" }, "R0")); }
    const records = await Promise.all([probeEngine(root, locator, deadline), probeOllama(root, tiers, deadline),
      probeBroker(root, deadline)]);
    try {
      if (fs.realpathSync(path.join(root, ".claude")) !== path.join(root, ".claude")) throw new Error("state-containment");
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      if (!assertStateDirContained(path.dirname(dir)).ok) throw new Error("state-containment");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!assertStateDirContained(dir).ok) throw new Error("state-containment");
      if (!fs.existsSync(file) && !writeFileHardened(file, JSON.stringify({ probes: records }) + "\n").ok) {
        throw new Error("record-write");
      }
    } catch { records.push(result("telemetry", { outcome: "undetermined", reason: "record-not-written" }, "R0")); }
    return records;
  })();
  sessions.set(key, { started: Date.now(), promise });
  return promise;
}

module.exports = { probeAll, probeBroker, probeOllama, probeEngine, killOutstanding, PROBE_TIMEOUT_MS,
  SESSION_BUDGET_MS, PROBE_MARGIN_MS, CACHE_TTL_MS, LLM_FEATURE };
