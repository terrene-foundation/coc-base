// Turns a measure.sh log into the Codex measurement receipt the adapter reads
// (adapters/codex-measured.json). The receipt is DERIVED from what the sandbox
// printed — no path is hand-listed — so it cannot drift from what was measured.
// usage: receipt.mjs <measure.log> <harness dir> <out dir>   -> receipt JSON on stdout
// Exit 2, writing nothing, when a required mode is missing or a scratch/home path would leak.
import fs from "node:fs";
import os from "node:os";

const [logFile, here, out] = process.argv.slice(2);
if (!logFile || !here || !out) { process.stderr.write("usage: receipt.mjs <measure.log> <harness dir> <out dir>\n"); process.exit(2); }
const text = fs.readFileSync(logFile, "utf8");
const refuse = (msg) => { process.stderr.write(`receipt: REFUSED — ${msg}\n`); process.exit(2); };

const modes = {};
let cur = null;
for (const line of text.split("\n")) {
  let m;
  if ((m = line.match(/^== MODE (\S+)/))) { cur = modes[m[1]] = { results: new Map(), exit: null }; continue; }
  if (line.startsWith("== ")) { cur = null; continue; }
  if (!cur) continue;
  if ((m = line.match(/^(ALLOWED|REFUSED) (\S+)(?: :: (.*))?$/))) cur.results.set(m[2], { verdict: m[1], quote: (m[3] || "").trim() });
  else if ((m = line.match(/^\s+sandbox-exit=(\d+)/))) cur.exit = Number(m[1]);
}
const REQUIRED = ["M0-no-sandbox", "M2-user-layer", "M3-project-layer", "M5-no-git-reopen", "M6-no-read-entries", "M7-no-tmp-write", "M8-no-extends"];
for (const r of REQUIRED) if (!modes[r]) refuse(`mode ${r} absent from the log`);
const [m0, m2, m3, m6, m8] = ["M0-no-sandbox", "M2-user-layer", "M3-project-layer", "M6-no-read-entries", "M8-no-extends"].map((k) => modes[k]);
if (m0.results.size === 0) refuse("the unsandboxed control printed nothing");

const version = (text.match(/^codex-cli \S+$/m) || [])[0] || refuse("codex --version line absent");
const policySha = (text.match(/sha256 ([0-9a-f]{64})/) || [])[1] || refuse("policy sha256 absent from the generated profile");
const redact = (s) => s.split(here).join("<harness>").split(out).join("<out>");
const v = (mode, label) => mode.results.get(label)?.verdict ?? "ABSENT";
const DENIED = /Operation not permitted/;

const read = [];
const notVerified = [];
for (const label of m0.results.keys()) {
  if (!label.startsWith("protected:")) continue;
  const p = label.slice("protected:".length);
  const quote = m2.results.get(label)?.quote ?? "";
  const ok = v(m0, label) === "ALLOWED" && v(m2, label) === "REFUSED" && v(m3, label) === "REFUSED" && v(m6, label) === "ALLOWED" && DENIED.test(quote);
  if (ok) read.push({ path: p, refused: redact(quote), control: "ALLOWED", without_read_entries: "ALLOWED", layers: ["user", "project"] });
  else notVerified.push({ path: p, observed: `control=${v(m0, label)} user=${v(m2, label)} project=${v(m3, label)} without-read-entries=${v(m6, label)}` });
}

const OUT_LABEL = "outside:sibling-dir";
const outsideQuote = m2.results.get(OUT_LABEL)?.quote ?? "";
const extendsOk = v(m0, OUT_LABEL) === "ALLOWED" && v(m2, OUT_LABEL) === "REFUSED" && v(m3, OUT_LABEL) === "REFUSED" && DENIED.test(outsideQuote) && m8.exit !== 0 && m8.exit !== null && m8.results.size === 0;

const receipt = {
  codex_version: version,
  measured_on: new Date().toISOString().slice(0, 10),
  harness: "tests/codex-measure/measure.sh (codex sandbox -P loom-guard; user layer + trusted project .codex/config.toml)",
  policy_sha256: policySha,
  extends: extendsOk ? { refused: redact(outsideQuote), without_extends: `codex sandbox exit ${m8.exit}; the probe never ran` } : null,
  read,
  not_verified: notVerified,
  measured_redundant: {
    git_write: `commit ${v(modes["M5-no-git-reopen"], "benign:git-commit")} with the ".git" write entry removed`,
    tmp_write: `mktemp ${v(modes["M7-no-tmp-write"], "benign:mktemp")} with the absolute write entries removed`,
  },
  default_permissions: "UNDETERMINED — codex sandbox requires -P, so selection without it is not observable",
};
const json = `${JSON.stringify(receipt, null, 2)}\n`;
if (json.includes(os.homedir()) || /\/(Users|home|private|var\/folders|tmp)\//.test(json)) refuse("an absolute host path survived redaction");
process.stdout.write(json);
