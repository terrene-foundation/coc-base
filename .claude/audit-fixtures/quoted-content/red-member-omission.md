# RED POLE — undeclared-member-omission (THE SEVEN-VS-EIGHT REGRESSION)

This is the second shipped defect reconstructed, and it is the reason the
enumeration pass exists. The corpus's `04-verification.md` § 14.3.6 enumerated
**seven** verdict kinds in a prose table where the classifier defines **eight**
— `env-abort`, which additionally reserves exit 78. Every checker in this gate
was blind to it, because the enumeration was neither a fence nor a blockquote.
Nobody would have been told.

The omitted member sits in the INTERIOR of the run, which is what makes the
table read as whole: the ladder still looks correctly ordered, and a fork
re-implementing the classifier from it ships a seven-kind ladder with no handler
for the environment-abort path.

It must red as `undeclared-member-omission` forever.

The classifier at `sources/classify-runner.js:16-75` emits problems of these
kinds, in this order:

| kind                     | fires when                                    |
| ------------------------ | --------------------------------------------- |
| `runner-error`           | `spawnError`, or a killed / timed-out process |
| `under-cases`            | observed cases < declared `min_cases`         |
| `opaque-failure`         | non-zero exit, zero parseable FAIL lines      |
| `under-reported-failure` | exit 0 with printed FAIL lines                |
| `undeclared-failure`     | a FAIL case not in the `xfail` list           |
| `xfail-now-passes`       | a declared-xfail case passed                  |
| `xfail-not-found`        | a declared-xfail case did not run             |

Seven rows, no ellipsis and no hedge — presented as the whole set.
