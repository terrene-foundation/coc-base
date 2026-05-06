#!/usr/bin/env node
/**
 * Hook: session-start
 * Event: SessionStart
 * Purpose: Discover env config, validate model-key pairings, create .env if
 *          missing, inject session notes into Claude context, output model
 *          configuration prominently.
 *
 * Framework-agnostic — works with any Kailash project.
 *
 * Exit Codes:
 *   0 = success (continue)
 *   2 = blocking error (stop tool execution)
 *   other = non-blocking error (warn and continue)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  parseEnvFile,
  discoverModelsAndKeys,
  ensureEnvFile,
  buildCompactSummary,
} = require("./lib/env-utils");
const {
  resolveLearningDir,
  ensureLearningDir,
  logObservation: logLearningObservation,
} = require("./lib/learning-utils");
const {
  detectActiveWorkspace,
  derivePhase,
  getTodoProgress,
  findAllSessionNotes,
} = require("./lib/workspace-utils");
const { checkVersion } = require("./lib/version-utils");

// Timeout fallback — prevents hanging the Claude Code session
const TIMEOUT_MS = 10000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
const { readPosture } = require("./lib/state-io");

process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const result = initializeSession(data);

    // Trust-posture gate (mitigates red-team H4 / Phase 1 of trust-posture rollout)
    let trustGate = "";
    try {
      const posture = readPosture(data.cwd);
      const lines = [];
      lines.push(
        `\n## Trust Posture: ${posture.posture}` +
          (posture._fail_closed
            ? " (FAIL-CLOSED — state was missing/corrupt)"
            : "") +
          (posture._fresh ? " (fresh repo)" : ""),
      );
      lines.push(`since: ${posture.since}`);
      const pv = (posture.pending_verification || []).filter(
        (e) => e && e.rule_id,
      );
      if (pv.length) {
        lines.push("\n⚠️ TRUST GATE — Verification Pending:");
        for (const e of pv) {
          const days = Math.floor(
            (Date.now() - new Date(e.since).getTime()) / 86400000,
          );
          lines.push(
            `  - ${e.rule_id} (day ${days + 1} of ${e.grace_period_days}). ` +
              `Violation within grace = EMERGENCY DOWNGRADE. ` +
              `Include \`[ack: ${e.rule_id}]\` in your first response.`,
          );
        }
      }
      trustGate = lines.join("\n");
    } catch {
      // If readPosture itself fails, surface a quiet warning — don't block session
      trustGate =
        "\n## Trust Posture: UNREADABLE — manual /posture init required";
    }

    const output = { continue: true };
    const ctxParts = [];
    if (result.sessionNotesContext) ctxParts.push(result.sessionNotesContext);
    if (trustGate) ctxParts.push(trustGate);
    if (ctxParts.length) {
      output.hookSpecificOutput = {
        hookEventName: "SessionStart",
        additionalContext: ctxParts.join("\n\n"),
      };
    }
    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (error) {
    console.error(`[HOOK ERROR] ${error.message}`);
    console.log(JSON.stringify({ continue: true }));
    process.exit(1);
  }
});

function initializeSession(data) {
  const result = { sessionNotesContext: null };
  const session_id = (data.session_id || "unknown").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  const cwd = data.cwd || process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const sessionDir = path.join(homeDir, ".claude", "sessions");
  const learningDir = resolveLearningDir(cwd);

  // Ensure directories exist
  [sessionDir].forEach((dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  });
  ensureLearningDir(cwd);

  // ── .env provision ────────────────────────────────────────────────────
  const envResult = ensureEnvFile(cwd);
  if (envResult.created) {
    console.error(
      `[ENV] Created .env from ${envResult.source}. Please fill in your API keys.`,
    );
  }

  // ── Python virtual environment check ───────────────────────────────────
  const hasPyproject = fs.existsSync(path.join(cwd, "pyproject.toml"));
  if (hasPyproject) {
    const venvPython = path.join(cwd, ".venv", "bin", "python");
    const hasVenv = fs.existsSync(venvPython);
    if (!hasVenv) {
      console.error(
        "[VENV] ⚠ WARNING: No .venv found in project root. Using global Python is BLOCKED.",
      );
      console.error(
        "[VENV]   Fix: run `uv venv && uv sync` before any Python work.",
      );
      console.error(
        "[VENV]   See rules/python-environment.md for the full policy.",
      );
    } else {
      // Check if venv is stale (pyproject.toml newer than .venv)
      try {
        const pyprojectMtime = fs.statSync(
          path.join(cwd, "pyproject.toml"),
        ).mtimeMs;
        const venvMtime = fs.statSync(venvPython).mtimeMs;
        if (pyprojectMtime > venvMtime) {
          console.error(
            "[VENV] pyproject.toml changed since last uv sync. Run `uv sync` to update.",
          );
        }
      } catch {}
    }
  }

  // ── Parse .env ────────────────────────────────────────────────────────
  const envPath = path.join(cwd, ".env");
  const envExists = fs.existsSync(envPath);
  let env = {};
  let discovery = { models: {}, keys: {}, validations: [] };

  if (envExists) {
    env = parseEnvFile(envPath);
    discovery = discoverModelsAndKeys(env);
  }

  // ── Detect framework ──────────────────────────────────────────────────
  const framework = detectFramework(cwd);

  // ── Detect DataFlow pool config ─────────────────────────────────────
  const poolInfo = detectPoolConfig(cwd);
  if (poolInfo.isPostgresql) {
    if (poolInfo.hasPoolOverride) {
      console.error(
        "[DataFlow] Pool size override detected (DATAFLOW_POOL_SIZE). Auto-scaling disabled.",
      );
    } else {
      console.error(
        "[DataFlow] Pool auto-scaling active. Override with DATAFLOW_POOL_SIZE=N if needed.",
      );
    }
  }

  // ── Log observation ───────────────────────────────────────────────────
  try {
    const observationsFile = path.join(learningDir, "observations.jsonl");
    fs.appendFileSync(
      observationsFile,
      JSON.stringify({
        type: "session_start",
        session_id,
        cwd,
        timestamp: new Date().toISOString(),
        envExists,
        framework,
        models: discovery.models,
        keyCount: Object.keys(discovery.keys).length,
        validationFailures: discovery.validations
          .filter((v) => v.status === "MISSING_KEY")
          .map((v) => v.message),
      }) + "\n",
    );
  } catch {}

  // ── Version check (human-facing, stderr only) ─────────────────────────
  try {
    const versionResult = checkVersion(cwd);
    for (const msg of versionResult.messages) {
      console.error(msg);
    }
  } catch {}

  // ── Output workspace status (human-facing, stderr only) ──────────────
  try {
    const ws = detectActiveWorkspace(cwd);
    if (ws) {
      const phase = derivePhase(ws.path, cwd);
      const todos = getTodoProgress(ws.path);
      console.error(
        `[WORKSPACE] ${ws.name} | Phase: ${phase} | Todos: ${todos.active} active / ${todos.completed} done`,
      );
    }
  } catch {}

  // ── Session notes (inject into Claude context + human-facing stderr) ─
  try {
    const allNotes = findAllSessionNotes(cwd);
    if (allNotes.length > 0) {
      for (const note of allNotes) {
        const staleTag = note.stale ? " (STALE)" : "";
        const label = note.workspace ? ` [${note.workspace}]` : " [root]";
        console.error(
          `[SESSION-NOTES]${label} ${note.relativePath}${staleTag} — updated ${note.age}`,
        );
      }

      // Build pointer-only context for Claude (full notes loaded on demand).
      // Prior behavior injected full note content, ballooning to 10KB+ per session.
      const pointerParts = [];
      for (const note of allNotes) {
        const label = note.workspace ? `[${note.workspace}]` : "[root]";
        const staleMark = note.stale ? " STALE" : "";
        pointerParts.push(
          `- ${label} ${note.relativePath} (updated ${note.age}${staleMark})`,
        );
      }
      if (pointerParts.length > 0) {
        result.sessionNotesContext =
          "# Previous Session Notes\n\nRead these files if continuing prior work:\n\n" +
          pointerParts.join("\n");
      }
    }
  } catch {}

  // ── Package freshness & version consistency check ───────────────────
  try {
    checkPythonPackageFreshness(cwd);
  } catch (e) {
    console.error(`[FRESHNESS] Check failed: ${e.message}`);
  }

  // ── Release drift check (unreleased packages) ────────────────────────
  try {
    checkReleaseDrift(cwd);
  } catch (e) {
    console.error(`[RELEASE-DRIFT] Check failed: ${e.message}`);
  }

  // ── Output model/key summary ──────────────────────────────────────────
  if (envExists) {
    const summary = buildCompactSummary(env, discovery);
    console.error(`[ENV] ${summary}`);

    // Detail each model-key validation
    for (const v of discovery.validations) {
      const icon = v.status === "ok" ? "✓" : "✗";
      console.error(`[ENV]   ${icon} ${v.message}`);
    }

    // Prominent warnings for missing keys
    const failures = discovery.validations.filter(
      (v) => v.status === "MISSING_KEY",
    );
    if (failures.length > 0) {
      console.error(
        `[ENV] WARNING: ${failures.length} model(s) configured without API keys!`,
      );
      console.error(
        "[ENV] LLM operations WILL FAIL. Add missing keys to .env.",
      );
    }
  } else {
    console.error(
      "[ENV] No .env file found. API keys and models not configured.",
    );
  }

  return result;
}

/**
 * Check version consistency across pyproject.toml and __init__.py for all packages.
 * Also check COC sync freshness for USE repos.
 */
function checkPythonPackageFreshness(cwd) {
  // Check all packages for version consistency
  const packageDirs = [
    {
      name: "kailash",
      pyproject: "pyproject.toml",
      init: "src/kailash/__init__.py",
    },
  ];

  // Also check packages/ subdirectories
  const packagesDir = path.join(cwd, "packages");
  if (fs.existsSync(packagesDir)) {
    try {
      const subDirs = fs.readdirSync(packagesDir);
      for (const sub of subDirs) {
        const subPath = path.join(packagesDir, sub);
        const pyproject = path.join(subPath, "pyproject.toml");
        if (fs.existsSync(pyproject)) {
          // Find the __init__.py
          const srcDir = path.join(subPath, "src");
          if (fs.existsSync(srcDir)) {
            try {
              const srcSubs = fs.readdirSync(srcDir);
              for (const s of srcSubs) {
                const initPath = path.join(srcDir, s, "__init__.py");
                if (fs.existsSync(initPath)) {
                  packageDirs.push({
                    name: sub,
                    pyproject: path.join("packages", sub, "pyproject.toml"),
                    init: path.join("packages", sub, "src", s, "__init__.py"),
                  });
                }
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  let mismatches = 0;
  for (const pkg of packageDirs) {
    try {
      const pyprojectPath = path.join(cwd, pkg.pyproject);
      const initPath = path.join(cwd, pkg.init);

      if (!fs.existsSync(pyprojectPath) || !fs.existsSync(initPath)) continue;

      const pyproject = fs.readFileSync(pyprojectPath, "utf8");
      const init = fs.readFileSync(initPath, "utf8");

      const pyVersionMatch = pyproject.match(/version\s*=\s*"([^"]+)"/);
      const initVersionMatch = init.match(/__version__\s*=\s*"([^"]+)"/);

      if (pyVersionMatch && initVersionMatch) {
        if (pyVersionMatch[1] !== initVersionMatch[1]) {
          console.error(
            `[FRESHNESS] VERSION MISMATCH in ${pkg.name}: ` +
              `pyproject.toml=${pyVersionMatch[1]}, __init__.py=${initVersionMatch[1]}. ` +
              `Update __init__.py before release!`,
          );
          mismatches++;
        }
      } else if (pyVersionMatch && !initVersionMatch) {
        console.error(
          `[FRESHNESS] ${pkg.name}: __init__.py missing __version__. ` +
            `Add __version__ = "${pyVersionMatch[1]}" to ${pkg.init}`,
        );
        mismatches++;
      }
    } catch {}
  }

  if (mismatches === 0) {
    console.error(`[FRESHNESS] All package versions consistent`);
  } else {
    console.error(
      `[FRESHNESS] ${mismatches} version mismatch(es) found — FIX BEFORE RELEASE`,
    );
  }

  // Check SDK dependency pin freshness (for repos that depend on kailash packages)
  checkSdkPinFreshness(cwd);

  // Check COC sync freshness (for USE repos that have a sync marker)
  const markerPath = path.join(cwd, ".claude", ".coc-sync-marker");
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8").trim());
      if (marker.synced_at) {
        const daysSince =
          (Date.now() - new Date(marker.synced_at).getTime()) /
          (1000 * 60 * 60 * 24);
        if (!isFinite(daysSince)) {
          console.error(
            `[COC-SYNC] WARNING: Invalid sync timestamp in marker file`,
          );
        } else if (daysSince > 7) {
          console.error(
            `[COC-SYNC] WARNING: COC sync is ${Math.floor(daysSince)} days old. ` +
              `Run COC sync to get latest agents, skills, and rules.`,
          );
        } else {
          console.error(`[COC-SYNC] Last synced: ${marker.synced_at}`);
        }
      }
    } catch {}
  }
}

/**
 * Check if kailash SDK dependency pins in pyproject.toml are installed in .venv.
 * Warns if pins exist but .venv packages are missing or at a different version.
 * Also enforces uv sync (not pip install) for dependency management.
 */
function checkSdkPinFreshness(cwd) {
  const pyprojectPath = path.join(cwd, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) return;

  try {
    const content = fs.readFileSync(pyprojectPath, "utf8");

    // Extract kailash-* dependency pins from pyproject.toml
    // Matches: kailash>=1.2.3, kailash-dataflow>=1.0.0, etc.
    const pinRegex = /(?:^|\n)\s*"?(kailash(?:-[\w]+)?)"?\s*>=\s*([\d.]+)/g;
    const pins = [];
    let match;
    while ((match = pinRegex.exec(content)) !== null) {
      pins.push({ name: match[1], version: match[2] });
    }

    if (pins.length === 0) return; // Not a kailash downstream repo

    // Check pins against BUILD repo's actual versions
    checkPinsAgainstBuild(cwd, pins);

    // Check if .venv exists
    const venvPython = path.join(cwd, ".venv", "bin", "python");
    if (!fs.existsSync(venvPython)) {
      console.error(
        `[SDK-PINS] ${pins.length} kailash packages pinned but no .venv found. Run: uv venv && uv sync`,
      );
      return;
    }

    // Check installed versions via pip list (fast, no import needed)
    let stale = 0;
    try {
      const installed = execFileSync(
        venvPython,
        ["-m", "pip", "list", "--format=json"],
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      );
      const packages = JSON.parse(installed);
      const pkgMap = {};
      for (const p of packages) {
        pkgMap[p.name.toLowerCase().replace(/-/g, "_")] = p.version;
      }

      for (const pin of pins) {
        const normalized = pin.name.toLowerCase().replace(/-/g, "_");
        const installed_ver = pkgMap[normalized];
        if (!installed_ver) {
          console.error(
            `[SDK-PINS] ${pin.name}>=${pin.version} pinned but NOT installed. Run: uv sync`,
          );
          stale++;
        } else if (
          installed_ver !== pin.version &&
          isOlderThan(installed_ver, pin.version)
        ) {
          console.error(
            `[SDK-PINS] ${pin.name}: installed ${installed_ver} < pinned ${pin.version}. Run: uv sync`,
          );
          stale++;
        }
      }
    } catch {
      // pip list failed — .venv might be broken
      console.error(
        `[SDK-PINS] Could not read installed packages. Recreate: uv venv && uv sync`,
      );
      return;
    }

    if (stale === 0 && pins.length > 0) {
      console.error(`[SDK-PINS] ${pins.length} kailash packages up to date`);
    } else if (stale > 0) {
      console.error(
        `[SDK-PINS] ${stale} stale pin(s). MUST run: uv sync (not pip install)`,
      );
    }
  } catch {}
}

/**
 * Compare pyproject.toml pins against sdk_packages from the repo's own .claude/VERSION.
 *
 * /sync writes sdk_packages into the target repo's VERSION (Gate 2 step 8).
 * This function reads it locally — no cross-repo dependency, works on any machine.
 * A mismatch means /sync updated VERSION but skipped the pyproject.toml pin bump.
 */
function checkPinsAgainstBuild(cwd, pins) {
  const versionPath = path.join(cwd, ".claude", "VERSION");
  if (!fs.existsSync(versionPath)) return;

  let sdkPackages;
  try {
    const version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
    sdkPackages = (version.upstream || {}).sdk_packages;
  } catch {
    return;
  }

  if (!sdkPackages || Object.keys(sdkPackages).length === 0) return;

  const sdkVersions = {};
  for (const [name, ver] of Object.entries(sdkPackages)) {
    sdkVersions[name.toLowerCase().replace(/-/g, "_")] = ver;
  }

  let staleCount = 0;
  const staleList = [];

  for (const pin of pins) {
    const baseName = pin.name.replace(/\[.*\]/, "");
    const normalized = baseName.toLowerCase().replace(/-/g, "_");
    const sdkVer = sdkVersions[normalized];

    if (!sdkVer) continue;

    if (isOlderThan(pin.version, sdkVer)) {
      staleList.push(
        `${baseName}: pinned >=${pin.version}, current SDK is ${sdkVer}`,
      );
      staleCount++;
    }
  }

  if (staleCount > 0) {
    console.error(
      `[SDK-PINS] ⚠ ${staleCount} STALE pin(s) — pyproject.toml is behind the SDK version in .claude/VERSION:`,
    );
    for (const msg of staleList) {
      console.error(`[SDK-PINS]   ${msg}`);
    }
    console.error(
      `[SDK-PINS]   Fix: update pyproject.toml pins to match current SDK, then run \`uv sync\``,
    );
  }
}

/**
 * Simple version comparison: is a older than b?
 */
function isOlderThan(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

/**
 * Check for packages with commits since their last release tag.
 * Silent when no packages / no matching tags / all released.
 * See .claude/hooks/lib/release-drift.js for detection logic.
 */
function checkReleaseDrift(cwd) {
  const { detectUnreleasedPackages } = require("./lib/release-drift");
  const unreleased = detectUnreleasedPackages(cwd);
  if (unreleased.length === 0) return;

  console.error(
    `[RELEASE-DRIFT] ⚠ ${unreleased.length} package(s) have commits since last release:`,
  );
  for (const pkg of unreleased) {
    console.error(
      `[RELEASE-DRIFT]   ${pkg.name} (${pkg.path}): ${pkg.commits_since_tag} commit(s) since ${pkg.last_tag} — pyproject at v${pkg.current_version}`,
    );
  }
  console.error(`[RELEASE-DRIFT]   Run /release when ready to publish.`);
}

function detectFramework(cwd) {
  try {
    const files = fs.readdirSync(cwd);
    for (const file of files.filter((f) => f.endsWith(".py")).slice(0, 10)) {
      try {
        const content = fs.readFileSync(path.join(cwd, file), "utf8");
        if (/@db\.model/.test(content) || /from dataflow/.test(content))
          return "dataflow";
        if (/from nexus/.test(content) || /Nexus\(/.test(content))
          return "nexus";
        if (/from kaizen/.test(content) || /BaseAgent/.test(content))
          return "kaizen";
      } catch {}
    }
    return "core-sdk";
  } catch {
    return "unknown";
  }
}

function detectPoolConfig(cwd) {
  const result = { isPostgresql: false, hasPoolOverride: false };
  try {
    const envPath = path.join(cwd, ".env");
    if (!fs.existsSync(envPath)) return result;
    const content = fs.readFileSync(envPath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed
        .slice(eqIndex + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (
        (key === "DATABASE_URL" || key === "DATAFLOW_DATABASE_URL") &&
        (/postgresql/i.test(value) || /postgres/i.test(value))
      ) {
        result.isPostgresql = true;
      }
      if (key === "DATAFLOW_POOL_SIZE" && value.length > 0) {
        result.hasPoolOverride = true;
      }
    }
  } catch {}
  return result;
}
