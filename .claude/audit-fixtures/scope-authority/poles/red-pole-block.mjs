// POLE: RED (block scope). Same defect, expressed as SEQUENTIAL EARLY RETURNS rather
// than one boolean expression — the `isExcluded` shape. The rescuing directory arm, if
// present, is in a DIFFERENT STATEMENT of the same function body, so this pair is what
// separates the expression window from the function-body window. Here the arm names the
// wrong tree, so no audit-fixtures/<dir>/run.mjs can reach the gate.
// Byte-for-byte identical to green-pole-block.mjs except for the directory arm below.
import { scrubFixture, scrubStrict } from "../../../bin/lib/identity-scrub.mjs";

function isExempt(rel) {
  if (/(^|\/)test-harness\//.test(rel)) return true;
  if (/\.test\.(mjs|js)$/.test(rel)) return true;
  return false;
}

export function scrubTree(files) {
  return files.map((rel) => (isExempt(rel) ? scrubFixture(rel) : scrubStrict(rel)));
}
