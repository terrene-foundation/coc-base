// POLE: RED. A synthetic scrub-surface instrument whose fixture-class gate decides
// which files get the shape-preserving scrubber. Its second arm names the fixture
// class by NAMING CONVENTION only, so no audit-fixtures/<dir>/run.mjs can reach it.
// Byte-for-byte identical to green-pole.mjs except for the directory arm below.
import { scrubFixture, scrubStrict } from "../../../bin/lib/identity-scrub.mjs";

function isFixtureFile(rel) {
  return /(^|\/)test-harness\//.test(rel) || /\.test\.(mjs|js)$/.test(rel);
}

export function scrubTree(files) {
  return files.map((rel) => (isFixtureFile(rel) ? scrubFixture(rel) : scrubStrict(rel)));
}
