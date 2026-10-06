# planted

A synthetic PEM block, invented for this fixture. It is not a key, and — since this
file SHIPS — its body is deliberately not base64 either.

WHY THE BODY IS NOT BASE64. This fixture pins the Gate-2 `private-key-material` shape,
which matches the BEGIN MARKER LINE (scanning is line-based; the marker line holds no
key bytes). The body is therefore never what the assertion reads — `expectFindingCount: 1`
exists precisely to prove the body and END marker do NOT match. But this path is carried
VERBATIM into the community, client-template and private-template projections (loom#1318
preserves loom's own disclosure-detector fixtures so they still fire downstream), where
`publish-to-public.mjs::runIdentityTokenGate` classifies a BEGIN marker followed by 40+
base64/whitespace characters as PRIVATE KEY MATERIAL and — correctly — refuses to publish.
An all-`A` base64 body satisfied that predicate, so the fixture shipped bytes matching the
repo's own definition of key material and brick-walled every publish lane. The body below
breaks the base64 run at its 10th character, so no gate can read it as key material, while
the marker line the shape actually matches is unchanged.

WHY THE MARKER IS A TOKEN. The PEM_BEGIN token below (double-underscore wrapped) is replaced by the BEGIN marker line in a
temporary copy at scan time (the runner's `materialize`). This corpus is scanned
identity-only at loom, with `private-key-material` active, so a committed marker here would
be indistinguishable from a real key pasted into a fixture.

Widening the publish gate to tolerate this directory was REJECTED as the fix: a path-scoped
carve-out for key material would be a switch for disabling the one leak class that has no
ecosystem-relative ambiguity, and it is strictly weaker than the loom#1318 home-path
precedent, which is scoped by VALUE (a known synthetic-user set) and not by path alone.

__PEM_BEGIN__
SYNTHETIC-FIXTURE-BODY-NOT-KEY-MATERIAL-DO-NOT-TREAT-AS-A-KEY
SYNTHETIC-FIXTURE-BODY-NOT-KEY-MATERIAL-DO-NOT-TREAT-AS-A-KEY
-----END RSA PRIVATE KEY-----
