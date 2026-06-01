# R2 org-slug form-coverage fixture (MUST flag, exit 1)

Every token below is SYNTHETIC and invented for this fixture. None is a
real operator hostname, org slug, runner label, home path, or service
label. This fixture locks must-fix #1 (issue #263 Round-2): the
nonfoundation-org-slug shape MUST detect a non-own, non-Foundation org
in ALL of these forms — the prior shape only matched a
`github.com/ | gh api repos/ | --repo ` prefix with a 2nd segment in
{kailash,loom,coc}, missing every form below.

1. SSH-clone form:
   git clone git@github.com:acme-corp/loom.git

2. `gh api orgs/` form (one of the original 12 real forms):
   gh api orgs/globex/members --paginate

3. Bare `<org>/<repo>` in prose:
   The mirror lives at acme-corp/loom for posterity.

4. Issue-ref `<org>/<repo>#N` form (also one of the original 12):
   Tracked upstream as acme-corp/loom#21 last quarter.

5. `<org>/kailash-*` family:
   See globex/kailash-py for the third-party fork.

6. `<org>/coc-*` family:
   The vendor pushed initech/coc-sync without review.

Foundation + own coordinates appearing alongside MUST NOT flag and
MUST NOT mask the above:
terrene-foundation/loom, gh api orgs/terrene-foundation,
git@github.com:esperie-enterprise/loom.git,
esperie-enterprise/loom#9, /Users/esperie/repos/loom.
