# adjacency-heartbeat audit fixtures

Mechanical regression locks for `.claude/hooks/adjacency-heartbeat.js`.

| Fixture            | Scope-restriction predicate                                         | Expected                                              |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------- |
| 01-coalesced       | First heartbeat in 60s window — append + cache update               | continue:true; record appended OR cache touched       |
| 02-post-coalesce   | Second heartbeat <60s after first — SKIP append (coalesced)         | continue:true; log size unchanged                     |
| 03-stop-event      | Stop / SessionEnd event — final heartbeat with session_end_intent   | continue:true; cache reflects final-heartbeat write   |

Hook MUST NEVER block — all three cases emit `{continue: true}`.
