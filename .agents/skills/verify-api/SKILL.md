---
name: verify-api
description: Verify backend/API changes against a real or representative running service, including status, schema, persistence, side effects, failure paths, authorization, and compatibility.
---

# Verify API

1. Discover the canonical service start/test workflow.
2. Identify changed endpoint/service boundaries, schemas, persistence, side effects, and callers.
3. Start or connect to the closest safe representative environment.
4. Exercise the primary success path with representative input.
5. Verify status/result, response semantics, schema/validation, persistence/side effects, and authorization/idempotency when relevant.
6. Exercise important failure/boundary paths.
7. Run affected integration/contract tests.
8. Check existing consumers when a shared contract changed.

Never destructively use production data for verification.
Never weaken auth, validation, or error handling to make checks pass.

Return:
- path exercised
- safe summary of input/result
- tests/commands executed
- persistence/side-effect checks
- compatibility concerns
- pass/fail and residual risk
