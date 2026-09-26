---
name: outcome-contract
description: Define the smallest useful success contract for a non-trivial, ambiguous, cross-module, or high-risk engineering task before implementation. Skip for obvious low-risk edits.
---

# Outcome Contract

Produce the minimum contract needed to keep implementation and verification aligned.

Capture:
- **Goal** — one outcome statement.
- **Constraints** — only material boundaries.
- **Acceptance criteria** — observable, testable behavior.
- **Architecture invariants** — only existing rules relevant to the task.
- **Done when** — exact evidence required before completion.

Rules:
- Do not turn this into a long product spec.
- Prefer observable behavior over implementation details.
- Do not pre-decide libraries, patterns, or architecture unless required by constraints.
- If acceptance criteria cannot be objectively verified, identify the judgment that requires a reviewer or human gate.
- For a bug, include the failing behavior that must be reproduced or otherwise established before the fix when feasible.

Output a compact contract suitable for guiding implementation and `$final-gate`.
