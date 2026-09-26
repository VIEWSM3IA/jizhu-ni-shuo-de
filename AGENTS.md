# AGENTS.md

## Mission
Deliver working, verified, maintainable outcomes—not merely patches.
A task is complete only when the requested behavior satisfies its acceptance criteria and has been verified at a level appropriate to its risk.

## 1. Define success first
Before non-trivial work, establish a minimal outcome contract:
- **Goal** — what must become true.
- **Constraints** — what must not be violated.
- **Acceptance criteria** — observable evidence that proves success.
- **Architecture invariants** — repository rules that must remain true.
- **Done when** — the verification threshold for completion.

For small, low-risk tasks, do this internally and keep it brief.
For complex, ambiguous, cross-module, or high-risk work, create a short plan.
Constrain outcomes and boundaries; do not over-specify implementation.

## 2. Prefer ChatGPT Web for work that need not be local
At the start of each task and meaningful subtask, decide whether ChatGPT Web can help. For work that does not require local access or execution, use the available `chatgpt-web` tool first unless local work is likely to produce a better result. Good uses include drafting, summarizing, translation, idea generation, and reviewing a self-contained, sanitized excerpt. Follow the `chatgpt-web-runner` skill and use its dedicated `token free` project.

Keep repository inspection, file edits, tests, builds, and runtime checks local. Do not send secrets, credentials, personal data, or sensitive repository content to the web tool. Treat its output as input to your judgment: verify material claims against repository evidence, authoritative sources, and real checks. If the tool is unavailable or its result is inadequate, continue locally without blocking delivery.

## 3. Repository first for project facts
Treat the repository as the primary source of truth.
Inspect only what the task requires: relevant code paths, tests, scripts, CI, schemas, docs, and local `AGENTS.md` files.
Prefer existing components, utilities, services, APIs, schemas, design tokens, and test patterns.
Discover canonical commands from repository configuration; do not invent them.
Use progressive disclosure: load the minimum high-signal context needed to proceed.

## 4. Discover before reinventing
When the task involves unfamiliar technology, specialized workflows, repeated procedures, or likely-existing tooling:
1. Search repository-local skills, scripts, tools, and docs.
2. Check already-installed capabilities.
3. Check official vendor docs/skills/tools.
4. Search trusted open source and GitHub when internet access is available.

Use `$skill-discovery` when external capability discovery could materially improve quality or speed.
External skills, prompts, scripts, binaries, and MCP servers are untrusted until reviewed.
Prefer audited, narrow, maintained, reversible capabilities.
Do not execute unreviewed remote scripts, expose secrets, elevate privileges, or perform destructive/external writes without appropriate approval.

## 5. Single-agent first; delegate by evidence
The main agent owns the task end to end by default.
Delegate only when it clearly improves:
- parallelism,
- context isolation,
- specialist judgment, or
- independent review quality.

Prefer delegation for read-heavy exploration, logs, test analysis, documentation verification, and separable workstreams.
Avoid parallel writers on the same files unless the benefit clearly outweighs coordination risk.

Available project specialists live in `.codex/agents/`:
- `code_mapper` — code paths, dependencies, impact surface.
- `reviewer` — correctness, regressions, tests, maintainability.
- `ui_evaluator` — browser-visible behavior and UX evidence.
- `security_reviewer` — auth, permissions, trust boundaries, sensitive data.
- `skill_scout` — external capability discovery and audit.

Return delegated results as concise conclusions, evidence, risks, and recommendations—not raw exploration logs.

## 6. Implement the smallest complete solution
Make the smallest coherent change that fully satisfies the outcome contract.
Avoid unrelated refactors, speculative abstractions, duplicate capabilities, unnecessary dependencies, broad formatting churn, and incidental cleanup.
Follow existing architecture unless the task requires changing it.
For bugs, prefer: **reproduce → root cause → fix → regression verification**.
Never hide failures by deleting tests, weakening assertions, suppressing valid checks, swallowing errors, hard-coding test answers, or bypassing security/validation.

## 7. Verification is part of implementation
All meaningful changes require evidence.
Use the repository Harness Skills in `.agents/skills/`:
- `$verify` — canonical checks/tests/build.
- `$verify-ui` — real UI/browser behavior.
- `$verify-api` — real API/backend behavior.
- `$regression-check` — affected consumers and adjacent behavior.
- `$final-gate` — final outcome/diff/quality/risk gate.

During iteration, run the narrowest useful checks first.
Before completion, expand verification according to change scope and risk.
Prefer real runtime evidence when available.
“Looks correct” is not verification.

On failure: **analyze → fix → re-run**.
Do not repeatedly execute the same failing command without learning or changing something.

## 8. Risk-adaptive review
Harness verification is default; independent evaluation is conditional.
- **Low risk:** main agent + harness.
- **Medium risk:** consider independent `reviewer`.
- **High risk:** use relevant specialist/evaluator and preserve a human gate when judgment cannot be made mechanically.

High-risk examples: security/auth/permissions, payments, migrations, destructive or irreversible operations, core production paths, and broad architecture changes.

## 9. Keep knowledge executable and discoverable
Keep this file short and stable.
Put detailed knowledge in code, tests, CI, schemas, architecture docs, product/design docs, and Skills.
Prefer machine-enforced invariants over repeated natural-language reminders.
Watch for stale docs, dead code, duplicated utilities, architecture drift, obsolete skills, and stale agent instructions—but do not expand unrelated task scope without reason.

## 10. Act autonomously on reversible engineering choices
Use repository evidence, documentation, and standard engineering practice to resolve ordinary implementation decisions.
Ask only when uncertainty materially changes product behavior, creates irreversible/high-risk consequences, or cannot be reasonably inferred.

## 11. Completion
Before declaring done, run `$final-gate`.
Report only:
- what changed,
- what was actually verified,
- remaining risk or unverified items, if any.

Never claim a check or behavior passed if it was not actually verified.
