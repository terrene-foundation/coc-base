# Non-own / 3rd-party org STILL flagged fixture (MUST flag, exit 1)

Proves the Foundation + placeholder allowlist does NOT neuter genuine
detection. A non-Foundation org slug must STILL produce a finding even
though `terrene-foundation/loom` (Foundation host) on the same surface does not.

Non-own 3rd-party mirror: see https://github.com/acme-corp/loom here.
Synthetic enterprise org: acme-enterprise is still a finding.
A different operator home: /Users/otheroperator/repos/loom is still a finding.

Allowlisted coordinates appearing alongside MUST NOT mask the above:
terrene-foundation/loom is the Foundation host (does not flag);
/Users/me/repos/loom is the placeholder home (does not flag).
The non-own tokens above must still flag despite these.
