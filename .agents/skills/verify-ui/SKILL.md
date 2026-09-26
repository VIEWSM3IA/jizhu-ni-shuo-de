---
name: verify-ui
description: Verify frontend/UI changes through the closest practical real user flow, including interaction, responsive states, console/network errors, and accessibility. Use when browser-visible behavior changes.
---

# Verify UI

When runtime browser tooling is available, source inspection alone is insufficient.

1. Discover the canonical way to run the relevant app and any E2E/browser tooling.
2. Start the closest safe representative environment.
3. Navigate to the affected route/state.
4. Execute the acceptance-critical user flow.
5. Check relevant states: default, loading, empty, error, success, disabled, focus, overflow/long content.
6. Check representative viewport sizes when layout is affected.
7. Check keyboard/focus behavior and obvious accessibility semantics when interaction is affected.
8. Inspect console errors and failed network requests.
9. Use screenshots/visual comparison when materially useful and available.

A page rendering is not proof that an interaction works.
If runtime browser tooling is unavailable, state that visual/runtime verification was not performed.

Return:
- flow exercised
- states checked
- console/network findings
- concrete visual/interaction failures
- pass/fail against acceptance criteria
- unverified items
