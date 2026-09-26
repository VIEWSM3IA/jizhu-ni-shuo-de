---
name: verify
description: Discover and execute the repository's canonical static checks, tests, and build after code changes. Use for implementation verification; never invent commands the repository does not define.
---

# Verify

## Discover
Inspect the relevant package/project configuration, scripts, Makefile/justfile, test config, and CI.
Identify canonical commands and the smallest affected scope.

## Iterate narrowly
During implementation, prefer focused checks:
- affected test(s)
- affected package/module tests
- targeted lint/static analysis
- targeted typecheck
- local build/check

## Complete proportionally
Before completion, expand according to scope and risk using applicable repository-defined checks:
- format check
- lint/static analysis
- typecheck
- unit tests
- integration/contract tests
- build
- E2E

Do not introduce a test framework just to satisfy this skill for a trivial change.
Do not suppress legitimate failures.

## Failure loop
For each failure:
1. Read the actual failure.
2. Determine whether it is change-related.
3. Fix change-related failures.
4. Re-run the smallest failed check.
5. Expand again after focused checks pass.

If a failure is unrelated, gather enough evidence to support that conclusion and report it.

## Return
- commands actually executed
- pass/fail result
- failures fixed
- checks not run and why
- residual verification risk
