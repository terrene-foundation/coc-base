"use strict";

const path = require("node:path");
const { tokenize, stripShellComments, readOnlyWrapperCommands, rejoinTokens, tokenSource } = require("./git-command-parse.js");
const { splitShellSegments, hasActiveExecutingConstruct, maskQuotedSpans } = require("./violation-patterns.js");

const result = (state, reason = null) => ({ state, reason });
const words = text => new Set(text.split(" ").filter(Boolean));

// Option arity is part of admission: an operand which looks like an option is still data.
const OPTIONS = {
  ls: ["1aAbBcCdDfFgGhHiIklLmMnNopPqQrRsStTuUvVwWxXZ@", "all almost-all author escape directory dired classify file-type human-readable si inode literal numeric-uid-gid no-group hide-control-chars show-control-chars quote-name reverse recursive size color", "block-size color format hide ignore indicator-style quoting-style sort time time-style width tabsize"],
  cat: ["AbEenstTuv", "show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting", ""],
  head: ["0123456789cqnvz", "quiet silent verbose zero-terminated", "bytes lines", "cn"],
  tail: ["0123456789cfFnqrvz", "follow retry quiet silent verbose zero-terminated", "bytes lines sleep-interval pid max-unchanged-stats follow", "cns"],
  grep: ["EFGHPaabcdDeFfhiILlmnoqRrsSUuvVwxyzZ", "extended-regexp fixed-strings basic-regexp perl-regexp text count ignore-case files-without-match files-with-matches line-number only-matching quiet silent recursive dereference-recursive no-messages invert-match version word-regexp line-regexp null-data null", "regexp file max-count after-context before-context context binary-files devices directories exclude exclude-from exclude-dir include label group-separator color colour", "e f m A B C d D"],
  wc: ["cLlmw", "bytes chars lines max-line-length words", "files0-from"],
  which: ["as", "all skip-alias skip-functions skip-dot skip-tilde show-dot show-tilde", ""],
  pwd: ["LP", "logical physical", ""],
  sort: ["bcdfghiMmnRrsuVz", "ignore-leading-blanks dictionary-order ignore-case general-numeric-sort ignore-nonprinting month-sort human-numeric-sort numeric-sort random-sort reverse stable unique version-sort zero-terminated check merge", "key field-separator buffer-size parallel batch-size sort", "k t S"],
};
const FIND_ZERO = words("-H -L -P -E -X -s -x -O0 -O1 -O2 -O3 -depth -xdev -mount -ignore_readdir_race -noignore_readdir_race -daystart -follow -noleaf -print -print0 -ls -true -false -empty -readable -writable -executable -nouser -nogroup -prune -quit -a -and -o -or -not ! ( )");
const FIND_VALUE = words("-name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -maxdepth -mindepth -mtime -mmin -atime -amin -ctime -cmin -newer -anewer -cnewer -size -user -group -uid -gid -perm -links -inum -samefile -lname -ilname -printf -D");
const GIT_OPTIONS = {
  status: ["bszvu", "short branch porcelain long verbose ignored no-ignored untracked-files ignore-submodules show-stash ahead-behind no-ahead-behind", "column no-column renames find-renames porcelain untracked-files ignored ignore-submodules"],
  diff: ["0123456789abBcCDGilmMpRsStTuUwWz", "patch no-patch raw patch-with-raw patch-with-stat numstat shortstat dirstat cumulative check summary name-only name-status stat compact-summary binary full-index color no-color relative text reverse exit-code quiet no-ext-diff no-textconv ignore-submodules submodule no-renames minimal patience histogram no-index cached staged ignore-space-change ignore-all-space ignore-space-at-eol ignore-cr-at-eol ignore-blank-lines", "stat-width stat-name-width stat-count diff-algorithm word-diff word-diff-regex color-moved color-moved-ws inter-hunk-context src-prefix dst-prefix line-prefix diff-filter find-renames find-copies order-file", "U S G O"],
  log: ["0123456789abBcCDGilmMpRsStTuUwWz", "oneline all branches tags remotes decorate no-decorate graph reverse date-order author-date-order topo-order first-parent no-merges merges follow full-history simplify-merges ancestry-path boundary left-right cherry cherry-pick cherry-mark no-walk walk-reflogs pretty format abbrev-commit no-abbrev-commit patch no-patch raw numstat shortstat stat summary name-only name-status relative color no-color no-ext-diff no-textconv regexp-ignore-case extended-regexp fixed-strings perl-regexp all-match invert-grep", "max-count skip since after until before author committer grep date pretty format encoding abbrev decorate exclude glob branches tags remotes", "n S G U"],
  show: ["0123456789abBcCDGilmMpRsStTuUwWz", "oneline pretty format patch no-patch raw numstat shortstat stat summary name-only name-status binary full-index color no-color relative text no-ext-diff no-textconv", "pretty format encoding abbrev diff-algorithm word-diff word-diff-regex", "U S G"],
  blame: ["abceflLnspwMtC", "root show-stats progress incremental line-porcelain porcelain contents reverse first-parent ignore-rev ignore-revs-file color-lines color-by-age", "date abbrev contents ignore-rev ignore-revs-file", "L"],
  "merge-base": ["a", "all octopus independent is-ancestor fork-point", ""],
  "ls-files": ["cdikmostuvxz", "cached deleted modified others ignored stage unmerged killed directory no-empty-directory eol full-name error-unmatch debug deduplicate recurse-submodules", "exclude exclude-from exclude-per-directory with-tree format", "x X"],
  "rev-parse": ["q", "verify quiet short sq sq-quote not no-revs revs-only flags no-flags default show-toplevel show-prefix show-cdup show-object-format show-ref-format show-superproject-working-tree git-dir git-common-dir absolute-git-dir is-inside-git-dir is-inside-work-tree is-bare-repository is-shallow-repository local-env-vars shared-index-path all branches tags remotes symbolic symbolic-full-name abbrev-ref disambiguate", "path-format git-path resolve-git-dir prefix default since after until before disambiguate", ""],
};

const DENY_OPTIONS = {
  grep: ["", "pre pre-glob"], sort: ["o", "output compress-program"],
  git: ["", "output ext-diff textconv"],
  branch: ["dDmMcCftu", "delete move copy force track set-upstream-to unset-upstream edit-description create-reflog"],
  gh: ["w", "web"],
};
function options(argv, spec, positional = true, deny = ["", ""]) {
  const [shorts, bare, valued, shortValues = ""] = spec;
  const noValue = words(bare), takesValue = words(valued), shortValue = words(shortValues.replace(/ /g, "").split("").join(" "));
  const nextOptional = words("contains no-contains merged no-merged points-at");
  let ended = false, state = "read-only", listMode = false;
  const operands = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (ended || arg === "-" || !arg.startsWith("-")) {
      if (!positional) operands.push(arg);
      continue;
    }
    if (arg === "--") { ended = true; continue; }
    if (arg.startsWith("--")) {
      const at = arg.indexOf("="), key = arg.slice(2, at < 0 ? undefined : at);
      if (words(deny[1]).has(key)) return result("dangerous", "option --" + key + " executes or mutates");
      if (!positional && arg === "--list") listMode = true;
      if (arg === "--help" || arg === "--version") continue;
      if (takesValue.has(key)) {
        if (at < 0 && (!noValue.has(key) || nextOptional.has(key))) {
          if (noValue.has(key) && (!argv[i + 1] || argv[i + 1].startsWith("-"))) continue;
          if (++i >= argv.length) state = "unknown";
        }
      } else if (!noValue.has(key) || at >= 0) state = "unknown";
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (!positional && flag === "l") listMode = true;
      if (deny[0].includes(flag)) return result("dangerous", "option -" + flag + " executes or mutates");
      if (shortValue.has(flag)) { if (j + 1 === arg.length && ++i >= argv.length) state = "unknown"; break; }
      if (!shorts.includes(flag)) state = "unknown";
    }
  }
  if (!positional && operands.length && !listMode) return result("dangerous", "bare branch operand creates or changes a branch");
  return result(state);
}
function findReadOnly(argv) {
  let predicates = false, state = "read-only";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!predicates && ["-H", "-L", "-P", "-E", "-X", "-s", "-x"].includes(arg)) continue;
    if (!predicates && !arg.startsWith("-") && !["!", "("].includes(arg)) continue;
    predicates = true;
    if (/^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg)) return result("dangerous", "find action is outside the read-only predicate allowlist");
    if (FIND_ZERO.has(arg)) continue;
    if (!FIND_VALUE.has(arg)) state = "unknown";
    else if (++i >= argv.length) state = "unknown";
  }
  return result(state);
}
function stripGitGlobals(argv) {
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === "--") { i++; break; }
    if (/^(?:-c|-p).*|^--(?:paginate|exec-path|config-env)(?:=|$)/.test(flag)) return { argv: [], state: "dangerous", reason: "git execution/configuration global option" };
    if (["-P", "--no-pager", "--no-optional-locks", "--literal-pathspecs"].includes(flag)) { i++; continue; }
    if (["-C", "--git-dir", "--work-tree"].includes(flag)) {
      if (i + 1 >= argv.length) return { argv: [], state: "unknown" };
      i += 2; continue;
    }
    if (/^-C.+$|^--(?:git-dir|work-tree)=.+$/.test(flag)) { i++; continue; }
    if (flag.startsWith("-")) return { argv: [], state: "dangerous", reason: "unrecognized git global option" };
    break;
  }
  return { argv: argv.slice(i), state: "read-only" };
}
function gitReadOnly(argv) {
  const globals = stripGitGlobals(argv);
  if (globals.state !== "read-only") return result(globals.state, globals.reason);
  const [verb, ...args] = globals.argv;
  if (verb === "branch") {
    const spec = ["alrv", "all remotes verbose list show-current contains no-contains merged no-merged color", "contains no-contains merged no-merged points-at format sort color", ""];
    return options(args, spec, false, DENY_OPTIONS.branch);
  }
  if (verb === "reflog") {
    if (["expire", "delete", "drop", "write"].includes(args[0])) return result("dangerous", "reflog mutation subcommand");
    return options(args[0] === "show" ? args.slice(1) : args, GIT_OPTIONS.log, true, DENY_OPTIONS.git);
  }
  return GIT_OPTIONS[verb] ? options(args, GIT_OPTIONS[verb], true, DENY_OPTIONS.git) : result("unknown");
}
function jqReadOnly(argv) {
  const bare = words("--null-input --raw-input --slurp --compact-output --raw-output --raw-output0 --join-output --ascii-output --sort-keys --color-output --monochrome-output --tab --stream --stream-errors --seq --unbuffered --exit-status --version --help --args --jsonargs");
  let state = "read-only";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "-i" || a === "--in-place") return result("dangerous", "jq in-place option");
    if (a === "--arg" || a === "--argjson" || a === "--slurpfile" || a === "--rawfile") { if ((i += 2) >= argv.length) state = "unknown"; }
    else if (["-f", "--from-file", "-L", "--indent"].includes(a)) { if (++i >= argv.length) state = "unknown"; }
    else if (a.startsWith("-") && a !== "-" && !bare.has(a) && !/^-[nRscrajCMSUetz]+$/.test(a)) state = "unknown";
  }
  return result(state);
}
function simpleReadOnly(argv) {
  const [verb, ...args] = argv;
  if (OPTIONS[verb]) return options(args, OPTIONS[verb], true, DENY_OPTIONS[verb]);
  if (verb === "echo") return result("read-only");
  if (verb === "find") return findReadOnly(args);
  if (verb === "git") {
    const globals = stripGitGlobals(args);
    if (globals.state !== "read-only") return result(globals.state, globals.reason);
    const sub = globals.argv[0];
    return GIT_OPTIONS[sub] || ["branch", "reflog"].includes(sub) ? gitReadOnly(args) : result("unknown");
  }
  if (verb === "jq") return jqReadOnly(args);
  if (verb === "gh" && ["pr", "issue", "release", "run"].includes(args[0]) && ["view", "list", "status"].includes(args[1])) {
    const spec = ["acLqRs", "comments json log log-failed exit-status verbose checks required watch compact", "repo hostname json jq template limit state author assignee base head label search milestone app branch commit created event job status user workflow", "L q R t s a" ];
    return options(args.slice(2), spec, true, DENY_OPTIONS.gh);
  }
  if (["node", "python", "python3"].includes(verb)) {
    if (args.length === 1 && args[0] === "--version") return result("read-only");
    if (args.some(a => /^(?:--(?:eval|print|require|import|inspect)(?:=|$)|-[eprc])/.test(a))) return result("dangerous", verb + " execution option");
  }
  return result("unknown");
}
function redirectVerdict(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].redirect) continue;
    const match = tokens[i].value.match(/^(?:\d+|&)?(>>|>&|>\||<<-|<<<|<<|<&|<>|>|<)(.*)$/);
    if (!match) return result("dangerous", "unresolved redirection");
    const operator = match[1], target = match[2] || tokens[++i]?.value;
    if (!target) return result("dangerous", "redirection target is missing");
    if ([">&", "<&"].includes(operator) && /^(?:\d+|-)$/.test(target)) continue;
    if (target === "/dev/null") continue;
    if (operator === "<" && /^\/dev\/(?:tcp|udp)(?:\/|$)/.test(target)) return result("dangerous", "input redirection opens a network device");
    if (operator === "<") continue;
    return result("dangerous", "output redirection writes a file or executes an unresolved body");
  }
  return result("read-only");
}
function braceWords(token, source) {
  if (!token.unexpandable) return [token.value];
  const active = maskQuotedSpans(tokenSource(token, source)).replace(/\\[\s\S]/g, "xx");
  const group = active.match(/\{([^{}]*)\}/);
  const expands = group && /,|\.\./.test(group[1]);
  if (!expands && /^[^{}$`*?\\]*(?:\^\{[^{}$`*?\\]*\}|@\{[^{}$`*?\\]+\})[^{}$`*?\\]*$/.test(token.value)) return [token.value];
  const match = token.value.match(/^([^{}$`*?\\]*)\{([A-Za-z0-9_./+,-]+)\}([^{}$`*?\\]*)$/);
  if (!match) return null;
  let parts = match[2].split(",");
  if (parts.length === 1) {
    const range = match[2].match(/^(-?\d+)\.\.(-?\d+)$|^([A-Za-z])\.\.([A-Za-z])$/);
    if (!range) return null;
    const number = !!range[1], from = number ? Number(range[1]) : range[3].charCodeAt(0), to = number ? Number(range[2]) : range[4].charCodeAt(0);
    if (Math.abs(to - from) >= 32) return null;
    parts = Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => number ? String(from + i * Math.sign(to - from || 1)) : String.fromCharCode(from + i * Math.sign(to - from || 1)));
  }
  return parts.map(p => match[1] + p + match[3]);
}

function literalCommandArgs(cmd) {
  if (typeof cmd !== "string" || /[\x00-\x1f$`\\;|&<>(){}*?!#~]/.test(cmd)) return null;
  const word = `(?:[A-Za-z0-9_./:-]+|"[^"]*"|'[^']*')`;
  if (!new RegExp(`^${word}(?: +${word})*$`).test(cmd)) return null;
  const tokens = tokenize(cmd);
  return tokens.length && !tokens.some(t => t.unexpandable || t.redirect) ? tokens.map(t => t.value) : null;
}

function classifyReadOnlyBash(command, trustedScript = () => false, depth = 0) {
  if (typeof command !== "string") return result("unknown");
  if (command.length > 65536 || /\x00/.test(command)) return result("dangerous", "command is too large or contains NUL");
  if (depth > 8) return result("dangerous", "wrapper recursion limit reached");
  const source = stripShellComments(command);
  if (hasActiveExecutingConstruct(source)) return result("dangerous", "command substitution or ambiguous executable quoting");
  const structure = maskQuotedSpans(source).replace(/\\[\s\S]/g, "xx");
  if (/[()]/.test(structure) || /(?:^|\s)[{}](?=\s|$)/.test(structure)) return result("dangerous", "shell group or process substitution");
  const segments = splitShellSegments(source, { newlineSeparates: true, backgroundSeparates: true }).map(s => s.trim()).filter(Boolean);
  const outcomes = segments.map(segment => {
    let tokens = tokenize(segment, { shellContinuations: true });
    const redirects = redirectVerdict(tokens);
    if (redirects.state === "dangerous") return redirects;
    tokens = tokens.filter(t => !t.redirect);
    if (!tokens.length) return result("unknown");
    if (path.isAbsolute(tokens[0].value)) {
      const argv = [{ ...tokens[0], value: path.basename(tokens[0].value) }, ...tokens.slice(1)];
      const absolute = classifyReadOnlyBash(rejoinTokens(argv), trustedScript, depth + 1);
      return absolute.state === "dangerous" ? absolute : result("unknown");
    }
    let at = tokens[0].value === "env" ? 1 : 0, hasEnvironment = at > 0;
    if (hasEnvironment && tokens[at]?.value.startsWith("-")) return result("dangerous", "unsupported environment wrapper option");
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at]?.value || "")) {
      hasEnvironment = true;
      const name = tokens[at++].value.split("=", 1)[0];
      if (/^(?:LD_.*|DYLD_.*|NODE_OPTIONS|PYTHON.*|GIT_.*|.*PAGER|EDITOR|VISUAL|BASH_ENV|ENV|PATH|IFS|PS4|PROMPT_COMMAND)$/.test(name)) return result("dangerous", "execution environment prefix " + name);
    }
    if (hasEnvironment) {
      if (!tokens[at]) return result("unknown");
      const inner = classifyReadOnlyBash(rejoinTokens(tokens.slice(at)), trustedScript, depth + 1);
      return inner.state === "dangerous" ? inner : result("unknown");
    }
    const wrapper = readOnlyWrapperCommands(segment);
    if (wrapper) {
      if (wrapper.unresolvable) return result("dangerous", "wrapper body cannot be resolved");
      if (wrapper.queryOnly) return result("read-only");
      if (!wrapper.commands.length) return result("unknown");
      const nested = wrapper.commands.map(body => classifyReadOnlyBash(body, trustedScript, depth + 1));
      const danger = nested.find(r => r.state === "dangerous");
      if (danger) return danger;
      return result(wrapper.argumentInput || nested.some(r => r.state === "unknown") ? "unknown" : "read-only");
    }
    const argv = [];
    for (const token of tokens) {
      const values = braceWords(token, segment);
      if (!values) return result("unknown");
      argv.push(...values);
    }
    if (trustedScript(segment)) return result("read-only");
    return simpleReadOnly(argv);
  });
  const dangerous = outcomes.find(r => r.state === "dangerous");
  if (dangerous) return dangerous;
  if (!outcomes.length || outcomes.some(r => r.state === "unknown")) return segments.length > 1
    ? result("dangerous", "compound or pipeline contains an unknown command") : result("unknown");
  return result("read-only");
}

module.exports = { classifyReadOnlyBash, literalCommandArgs, stripGitGlobals };
