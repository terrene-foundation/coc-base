// SYNTHETIC fixture — `*.test.mjs` source-only-skip destination-mode proof.
// Invented home path; NO real operator coordinates.
//
// A loom bin unit test legitimately embeds a synthetic operator-home-path to
// exercise the disclosure scrubber. At LOOM-SOURCE the scanner skips *.test.mjs
// (REPO_ROOT_ACTIVE === REPO_ROOT) so this synthetic fixture does not trip the
// Gate-2 preflight. But when such a file LEAKS to a consumer and a destination
// scan runs (--root <consumer>), the skip MUST flip OFF and flag it — its
// presence at a sync destination IS the disclosure event.
import { test } from "node:test";
import assert from "node:assert";

test("scrubber strips an operator-home path", () => {
  const planted = "see /Users/fakeuser/fake-repos/secret/x.md";
  assert.ok(planted.includes("/Users/"));
});
