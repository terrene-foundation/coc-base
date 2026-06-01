# Non-own / 3rd-party org STILL flagged fixture (MUST flag, exit 1)

Proves the Option-1 own-org allowlist did NOT neuter genuine detection.
A non-own, non-Foundation org slug must STILL produce a finding even
though `esperie-enterprise/loom` (own host) on the same surface does not.

Non-own 3rd-party mirror: see https://github.com/acme-corp/loom here.
Synthetic enterprise org: acme-enterprise is still a finding.
A different operator home: /Users/notesperie/repos/loom is still a finding.

Own-coordinates appearing alongside MUST NOT mask the above:
esperie-enterprise/loom is the own host (does not flag);
/Users/esperie/repos/loom is the own dev path (does not flag).
The non-own tokens above must still flag despite these.
