"use strict";
/**
 * raw-sql-shape — decide whether a quoted string literal in source text is a SQL
 * STATEMENT, by statement SHAPE rather than by its leading keyword.
 *
 * WHY THIS EXISTS. The raw-SQL advisories in `integration-hygiene.js` and
 * `validate-workflow.js::checkRustPatterns` each carried a keyword-prefix regex
 * (quote, optional whitespace, then SELECT|INSERT|UPDATE|DELETE|DROP|ALTER, then
 * whitespace). A keyword prefix cannot tell SQL from English, because every one
 * of those keywords is also an English imperative verb: the string
 * `Update __init__.py before release!` in `hooks/session-start.js` fired the
 * "raw SQL string detected" advisory, as would "Select a branch from the list"
 * or "Delete from your notes". The two hooks also held DIVERGENT copies of the
 * same idea, so a fix to one left the other live. This module is the single
 * predicate both consume.
 *
 * THE DISCRIMINATOR. SQL keywords come in mandatory PAIRS around a table
 * reference, and what follows the reference is SQL syntax — a clause keyword,
 * SQL punctuation, a bind placeholder, or the end of the string (a statement
 * prefix concatenated with a table name at run time). English puts ordinary words
 * there. Each shape below therefore anchors on keyword pair + reference + a
 * SQL-shaped tail:
 *
 *   UPDATE <ref> [alias] [JOIN ...] SET
 *   DELETE [targets] FROM <ref> <tail>
 *   INSERT [INTO] <ref> <tail>
 *   SELECT <sql-shaped list> FROM <ref> <tail>     |  SELECT <expression>
 *   CREATE|ALTER|DROP <TABLE|INDEX|VIEW|...> <ref> <tail>
 *
 * Matching is case-INSENSITIVE, as SQL is. The quote that opened the literal is
 * captured and back-referenced, so no shape reads past the end of its string.
 *
 * KNOWN RESIDUALS, named so a silent result is not read as "no SQL anywhere":
 *   - False positive: an English imperative whose object is ONE word directly
 *     before the closing quote — "Delete from history", "Select files from
 *     disk", "Insert into clipboard", "Drop table rows". Structurally that IS
 *     `DELETE FROM history`; no lexical test separates them.
 *   - False negative: a statement whose only table reference carries an alias
 *     and NOTHING after it — `SELECT id FROM users u` ending the string with no
 *     trailing space. That is the exact shape of "select a branch from the
 *     list", and a pointless alias is rarer than the English sentence.
 *   - False negative: statements not led by these verbs (`WITH ... AS (...)`
 *     CTEs, `MERGE`, `TRUNCATE`, `REPLACE INTO`) — the keyword-prefix regexes
 *     this replaces did not catch those either.
 *
 * Output discipline: a lexical signal. Consumers MUST surface it as an advisory,
 * never `block` (`rules/hook-output-discipline.md` MUST-2).
 */

const IDENT = String.raw`[A-Za-z_]\w*`;
// Bind parameters and interpolation holes that stand where a name or value goes:
// ${x} / {x} (JS template, Python f-string/format, Rust format!), #{x} (Ruby),
// %(name)s / %s (DB-API), $1 (Postgres), ? (qmark), :name, @name.
const PLACEHOLDER = String.raw`(?:\$?\{[^}\n]{0,64}\}|#\{[^}\n]{0,64}\}|%\(\w+\)s|%s|\$\d+|\?|:\w+|@\w+)`;
// Interpolation glued onto an identifier: users_{suffix}, {schema}_users.
const GLUE = String.raw`(?:\$?\{[^}\n]{0,64}\}|#\{[^}\n]{0,64}\})`;
const QUOTED_IDENT = String.raw`(?:\\?[\x60"][^\x60"\\\n]{1,64}\\?[\x60"]|\[[^\]\n]{1,64}\])`;
const ATOM = String.raw`(?:${PLACEHOLDER}|${QUOTED_IDENT}|${IDENT})(?:${GLUE}\w*)*`;
const REF = String.raw`${ATOM}(?:\.${ATOM}){0,3}`;
const REF_LIST = String.raw`${REF}(?:\s*,\s*${REF})*`;
// One character that is still inside the current string literal.
const NQ = String.raw`(?:(?!\k<q>)[^;])`;
const END = String.raw`\k<q>`;
const JOIN = String.raw`(?:(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL)\s+(?:OUTER\s+)?)?JOIN`;

const UPDATE = String.raw`UPDATE\s+(?:(?:ONLY|LOW_PRIORITY|IGNORE|OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE))\s+)*${REF}(?:\s+(?:AS\s+)?${IDENT})?(?:\s+${JOIN}\s${NQ}{1,200}?)?\s+SET(?=\s|${END})`;

const DEL_CLAUSE = String.raw`(?:WHERE|USING|RETURNING|ORDER\s+BY|LIMIT|OUTPUT|${JOIN})\b`;
const DEL_TAIL = String.raw`(?:\s*(?:${END}|;)|\s+${DEL_CLAUSE}|\s+(?:AS\s+)?${IDENT}(?:\s*;|\s+${END}|\s+${DEL_CLAUSE}))`;
const DELETE = String.raw`DELETE\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE|TOP\s*\(\s*\d+\s*\))\s+)*(?:${REF_LIST}\s+)?FROM(?:\s*${END}|\s+${REF_LIST}${DEL_TAIL})`;

const INS_PAREN = String.raw`\s*\((?:\s*${END}|${NQ.replace("[^;]", "[^;)]")}{0,400}\)\s*(?:${END}|;|(?:VALUES?|SELECT|OVERRIDING|DEFAULT|ON|RETURNING|WITH)\b))`;
const INS_TAIL = String.raw`(?:\s*(?:${END}|;)|${INS_PAREN}|\s+(?:VALUES?|SELECT|DEFAULT\s+VALUES|SET|AS|OVERRIDING|ON|RETURNING|WITH|PARTITION)\b)`;
const INSERT = String.raw`INSERT\s+(?:(?:OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)|IGNORE|LOW_PRIORITY|DELAYED|HIGH_PRIORITY)\s+)*(?:INTO(?:\s*${END}|\s+${REF}${INS_TAIL})|${REF}(?:\s*\(${NQ.replace("[^;]", "[^;)]")}{0,400}\))?\s+VALUES?\b)`;

const SEL_MODS = String.raw`(?:(?:DISTINCT(?:\s+ON\s*\([^)]*\))?|ALL|TOP\s*\(?\s*\d+\s*\)?(?:\s+PERCENT)?|SQL_\w+|STRAIGHT_JOIN|HIGH_PRIORITY)\s+)*`;
// A select list is SQL-shaped when it is one item (`*`, a number, `t.col`, `t.*`)
// or carries SQL punctuation / AS / a qualified name / a placeholder before FROM.
// "a branch" is neither, which is what keeps "select a branch from the list" quiet.
const SEL_ITEM = String.raw`(?:\*|\d+|${REF}(?:\.\*)?)`;
const SEL_SQLISH = String.raw`(?:(?!${END}|\bFROM\b)[^;]){0,400}?(?:[,(*]|\bAS\b|\.\w|${PLACEHOLDER})${NQ}{0,400}?`;
const SEL_CLAUSE = String.raw`(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|FETCH|FOR\s+(?:UPDATE|SHARE|NO\s+KEY)|WINDOW|TABLESAMPLE|${JOIN})\b`;
const SEL_TAIL = String.raw`(?:\s*(?:${END}|;|\))|\s+${SEL_CLAUSE}|\s+(?:AS\s+)?${IDENT}(?:\s*(?:;|\)|,)|\s+${END}|\s+${SEL_CLAUSE}))`;
const SELECT_FROM = String.raw`SELECT\s+${SEL_MODS}(?:${SEL_ITEM}|${SEL_SQLISH})\s+FROM(?:\s*${END}|\s*\(|\s+${REF_LIST}${SEL_TAIL})`;
const SELECT_EXPR = String.raw`SELECT\s+(?:\d+(?:\.\d+)?|${PLACEHOLDER}|'[^'\n]{0,64}'|${IDENT}\s*\(${NQ}{0,200}?\))(?:\s*::\s*\w+)?(?:\s+AS\s+${IDENT})?(?:\s*(?:${END}|;)|\s*,\s*(?:\d|${IDENT}\s*\())`;

const DDL_OBJECT = String.raw`(?:TABLE|INDEX|VIEW|SCHEMA|DATABASE|SEQUENCE|TRIGGER|EXTENSION|FUNCTION|PROCEDURE)`;
const DDL_TAIL = String.raw`(?:\s*(?:${END}|;|\()|\s+(?:ON|AS|ADD|DROP|ALTER|RENAME|MODIFY|CHANGE|SET|RESET|OWNER|ATTACH|DETACH|ENABLE|DISABLE|VALIDATE|CASCADE|RESTRICT|PURGE|USING|LIKE|PARTITION|INHERITS|WITH|RETURNS|BEFORE|AFTER|INSTEAD|ENGINE|COMMENT)\b)`;
const DDL = String.raw`(?:CREATE(?:\s+OR\s+REPLACE)?(?:\s+(?:GLOBAL|LOCAL))?(?:\s+(?:TEMP|TEMPORARY|UNLOGGED|UNIQUE|MATERIALIZED|VIRTUAL))?|ALTER|DROP)\s+${DDL_OBJECT}(?:\s+CONCURRENTLY)?(?:\s+IF(?:\s+NOT)?\s+EXISTS)?(?:\s+ONLY)?(?:\s+${END}|\s+${REF_LIST}${DDL_TAIL})`;

const SHAPES = [
  ["update", UPDATE],
  ["delete", DELETE],
  ["insert", INSERT],
  ["select_from", SELECT_FROM],
  ["select_expr", SELECT_EXPR],
  ["ddl", DDL],
];

const SHAPE_LABELS = {
  update: "UPDATE...SET",
  delete: "DELETE...FROM",
  insert: "INSERT INTO",
  select_from: "SELECT...FROM",
  select_expr: "SELECT <expression>",
};

const cache = new Map();

function buildPattern(quoteChars, prefix) {
  const key = `${quoteChars}\u0000${prefix}`;
  if (cache.has(key)) return cache.get(key);
  const cls = `[${quoteChars.replace(/[\\\]^-]/g, "\\$&")}]`;
  const body = SHAPES.map(([name, src]) => `(?<${name}>${src})`).join("|");
  const re = new RegExp(`${prefix}(?<q>${cls})\\s*(?:${body})`, "i");
  cache.set(key, re);
  return re;
}

/**
 * Find the first quoted string literal in `content` that has SQL statement shape.
 *
 * @param {string} content  source text
 * @param {object} [opts]
 * @param {string} [opts.quoteChars] characters that open a string literal
 *   (default `"'` plus backtick; Rust callers pass `"` only)
 * @param {string} [opts.prefix] regex source that must immediately precede the
 *   opening quote (e.g. `format!\s*\(\s*r?#*` to restrict to format! calls)
 * @returns {{shape: string, kind: string, excerpt: string, index: number, line: number} | null}
 *   `kind` is the internal shape id; `shape` is the human label naming which
 *   statement form matched; `excerpt` is the matched statement text (≤80 chars);
 *   `line` is the 1-based line of the opening quote. Hook messages carry `shape`
 *   and `line` only — never `excerpt`, which may hold a literal credential.
 */
function findRawSqlStatement(content, opts = {}) {
  if (typeof content !== "string" || content.length === 0) return null;
  const quoteChars = opts.quoteChars || "\"'`";
  const prefix = opts.prefix || "";
  const m = buildPattern(quoteChars, prefix).exec(content);
  if (!m) return null;
  const kind = SHAPES.find(([name]) => m.groups[name] !== undefined)[0];
  const statement = m.groups[kind];
  let shape = SHAPE_LABELS[kind];
  if (kind === "ddl") {
    const d = /^(CREATE|ALTER|DROP)\b[\s\S]*?\b(TABLE|INDEX|VIEW|SCHEMA|DATABASE|SEQUENCE|TRIGGER|EXTENSION|FUNCTION|PROCEDURE)\b/i.exec(
      statement,
    );
    shape = `${d[1]} ${d[2]}`.toUpperCase();
  }
  const excerpt = statement.replace(/\s+/g, " ").trim().slice(0, 80);
  const line = content.slice(0, m.index).split("\n").length;
  return { shape, kind, excerpt, index: m.index, line };
}

module.exports = { findRawSqlStatement };
