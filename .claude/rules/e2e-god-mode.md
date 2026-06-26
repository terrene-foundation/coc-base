---
priority: 10
scope: path-scoped
paths:
  - "tests/e2e/**"
  - "**/*e2e*"
  - "**/*playwright*"
---

# E2E God-Mode Testing Rules


<!-- slot:neutral-body -->

### 1. Create ALL Missing Records

When a required record is missing (404, 403, empty response): create it immediately via API or direct DB. MUST NOT skip, document as "gap", or report as "expected behavior."

**Why:** Skipping missing records produces hollow test runs that pass on paper but never exercise the actual feature paths, hiding real bugs.

### 2. Adapt to Data Changes

Test data changes between runs. Query the API to discover actual records before testing. MUST NOT hardcode user emails, IDs, or other test data.

**Why:** Hardcoded test data causes intermittent failures whenever the database is reset or seeded differently, making tests appear flaky when they are actually brittle.

### 3. Implement Missing Endpoints

If an API endpoint doesn't exist and testing needs it: implement it immediately. MUST NOT document as "limitation."

**Why:** Documenting a missing endpoint as a "limitation" halts all dependent test coverage and defers the gap to a future session that may never come.

### 4. Follow Up on Failures

When an operation fails gracefully (error displayed, no crash): investigate root cause and fix. MUST NOT report "graceful failure" and move on.

**Why:** "Graceful failure" often masks real bugs behind error-handling code -- the user sees a polished error message while the underlying feature remains broken.

### 5. Assume Correct Role

During multi-persona testing, log in as the role needed for each operation (admin for admin actions, restricted user for restricted views).

**Why:** Testing admin-only features as a superuser misses permission-denied paths, leaving authorization bugs undetected until a real restricted user hits them.

## Pre-E2E Checklist

- Backend and frontend running
- .env loaded and verified
- Required users, resources, and access records exist (query API, create if missing)

<!-- /slot:neutral-body -->
