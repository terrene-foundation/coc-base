This case deliberately has NO `.github/workflows/coc-artifact-eval.yml`.

The file you are reading exists only so git carries the directory. Git does not
track empty directories, so without it this case is present on the author's disk
and ABSENT from every clone — the fixture passes locally and the eval harness
reports it MISSING in CI:

    [ERROR] ci-parity (tool) — expected fixture(s) missing under
      .claude/audit-fixtures/ci-parity: violation-workflow-absent
      (a missing fixture is a coverage gap, NEVER a silent pass)

That message is the correct behaviour and is why this file exists. The identical
hazard was recognised for `verdict`'s `violation-cmd-absent` case and fixed there
in the same change that left this one broken — the instance was fixed, the class
was not.
