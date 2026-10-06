# GREEN POLE — the same table, complete

Byte-for-byte the RED pole's structure: same prose, same citation, same table
shape, same column headers, same order. The ONLY difference is that the
`env-abort` row is present. A checker that reds here is reporting on shape — on
"a table near a citation" — rather than on whether the member set is complete,
and it would red on every correct enumeration in the corpus forever.

The omitted member in the RED pole sits in the INTERIOR of the run, which is
what makes the table read as whole: the ladder still looks correctly ordered, and
a fork re-implementing the classifier from it ships a seven-kind ladder with no
handler for the environment-abort path.

It must stay clean forever.

The classifier at `sources/classify-runner.js:16-75` emits problems of these
kinds, in this order:

| kind                     | fires when                                       |
| ------------------------ | ------------------------------------------------ |
| `runner-error`           | `spawnError`, or a killed / timed-out process    |
| `env-abort`              | the run died on its ENVIRONMENT, not its subject |
| `under-cases`            | observed cases < declared `min_cases`            |
| `opaque-failure`         | non-zero exit, zero parseable FAIL lines         |
| `under-reported-failure` | exit 0 with printed FAIL lines                   |
| `undeclared-failure`     | a FAIL case not in the `xfail` list              |
| `xfail-now-passes`       | a declared-xfail case passed                     |
| `xfail-not-found`        | a declared-xfail case did not run                |

Eight rows, no ellipsis and no hedge — presented as the whole set, and it is.
