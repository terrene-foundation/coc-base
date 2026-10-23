#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { isMainModule } from "./lib/entry-point.mjs";
const { resolveWorkhorseWriteTarget } = createRequire(import.meta.url)("../hooks/lib/codex-rule-context.js");

export function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 4 || args[0] !== "--installed-root" || args[2] !== "--worktree"
        || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) {
      throw Object.assign(new Error("WORKHORSE_TARGET_REFUSED: ABSOLUTE_ARGUMENTS_REQUIRED"), { code: "WORKHORSE_TARGET_REFUSED" });
    }
    console.log(JSON.stringify(resolveWorkhorseWriteTarget(args[1], args[3])));
    return 0;
  } catch (error) {
    const message = error?.code === "WORKHORSE_TARGET_REFUSED" ? error.message : "WORKHORSE_TARGET_REFUSED: PREFLIGHT_UNAVAILABLE";
    console.error(JSON.stringify({ code: "WORKHORSE_TARGET_REFUSED", message }));
    return 2;
  }
}
if (isMainModule(import.meta.url)) process.exitCode = main();
