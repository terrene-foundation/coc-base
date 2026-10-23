import fs from "node:fs";
import path from "node:path";

export function resolveGhBinary(env = process.env, { currentUid = process.getuid?.() } = {}) {
  const override = env.COC_GH_BIN;
  const candidates = override
    ? [override]
    : (env.PATH || "").split(path.delimiter).filter((dir) => path.isAbsolute(dir))
      .map((dir) => path.join(dir, process.platform === "win32" ? "gh.exe" : "gh"));
  for (const candidate of candidates) {
    try {
      if (!Number.isInteger(currentUid) || !path.isAbsolute(candidate) ||
          !["gh", "gh.exe"].includes(path.basename(candidate))) continue;
      const binary = path.normalize(fs.realpathSync(candidate));
      if (!["gh", "gh.exe"].includes(path.basename(binary))) continue;
      const stat = fs.statSync(binary);
      if (!stat.isFile() || ![0, currentUid].includes(stat.uid) || (stat.mode & 0o022)) continue;
      fs.accessSync(binary, fs.constants.X_OK);
      let directory = path.dirname(binary);
      let trusted = true;
      while (true) {
        directory = path.normalize(fs.realpathSync(directory));
        const parentStat = fs.statSync(directory);
        if (!parentStat.isDirectory() || ![0, currentUid].includes(parentStat.uid) ||
            ((parentStat.mode & 0o022) && !(parentStat.mode & 0o1000))) {
          trusted = false;
          break;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      if (trusted) return binary;
    } catch {
      continue;
    }
  }
  return null;
}
