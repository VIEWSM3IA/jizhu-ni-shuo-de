---
name: final-gate
description: Mandatory final engineering gate before declaring a task complete: outcome contract, diff scope, quality, verification evidence, capability reuse, residual risk, and review escalation.
---

# Final Gate

Do not declare completion until this gate passes or a real blocker is reported.

## Outcome
Confirm:
- Goal is satisfied.
- Acceptance criteria are satisfied.
- Constraints and architecture invariants remain true.

## Diff
Inspect the final diff/status.
Confirm:
- only necessary changes are present,
- unrelated user changes were preserved,
- no debug code, temporary files, accidental artifacts, placeholders, or secrets remain.

## Quality
Confirm:
- repository conventions are followed,
- no duplicate capability was introduced without reason,
- complexity is proportionate,
- public/shared contracts changed deliberately,
- docs changed when setup/behavior/public interfaces materially changed.

## Verification
Collect actual evidence from `$verify` and applicable runtime skills such as `$verify-ui` / `$verify-api`.
For non-trivial shared changes, consider `$regression-check`.
Never convert "not checked" into "passed".

## Capability
Ask whether a mature repository/official/external capability was obviously available and ignored.
Do not delay completion for speculative browsing when discovery would not materially help.

## Risk
Classify residual risk.
Escalate to `reviewer`, `security_reviewer`, `ui_evaluator`, or a human gate when warranted by:
- security/auth/permission,
- migration/data loss/irreversible side effects,
- large architecture or shared-contract changes,
- high uncertainty,
- important subjective product/UI judgment not settled by tools.

If a defect is found: return to implementation → fix → rerun relevant verification → run this gate again.

## Completion report
Return only:
- implemented,
- verified,
- remaining risk/unverified items, if any.
