---
name: regression-check
description: Determine and verify the regression surface of a non-trivial or cross-module change using the final diff, call graph, contracts, shared state, and existing tests.
---

# Regression Check

1. Inspect the final diff.
2. Identify changed shared/public surfaces:
   - exported APIs/functions/types
   - schemas and persisted data
   - events
   - component props
   - configuration
   - shared utilities/state
3. Find direct callers/consumers and adjacent paths.
4. Find existing tests that cover them.
5. Run focused regression checks first.
6. Expand only where shared surface or risk justifies it.
7. Check unintended changes in behavior, state, errors, compatibility, and material performance characteristics.

Do not turn this into a repository-wide audit unless the change truly has repository-wide impact.

Return:
- regression surface
- consumers checked
- tests/flows executed
- regressions found/fixed
- residual risks
