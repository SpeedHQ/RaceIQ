# Live Engineer package management UI plan

Contract: [shared API, enablement and E2E](wizard-live-engineer-package-contract.md). Backend and UI proceed independently after this contract. Parent owns real integration execution.

## Scope/tasks

Own onboarding step/ordering/footer; shared voice-package status/check/install query hooks; Settings navigation and LiveEngineerSection; reusable package card; Radio controls reuse without duplicate gate; root bottom-right update prompt and actual WS invalidation handling; locale keys. Do not implement Node installer, remote release selection or alter hardcoded compatibility.

1. Optional release-gated wizard step after Sound with Install package/Skip; ready state Continue, failure Retry/Skip. No audio preference mutation. Disable navigation while shared install mutation pending.
2. Dedicated release-gated Settings → Live Engineer: installed/minimum/latest package revision, installed/required engine/catalog/locale, Check for updates, Install/Update, progress/error/retry, existing Radio controls reused. Consume shared API, never remote metadata directly.
3. Query hooks reuse typed RPC/mutation conventions and invalidate readiness after successful install/check. Status polling/WS invalidation do not themselves run remote checks.
4. Root bottom-right prompt only when release flag and either user audio switch enabled and updateAvailable true. Dismiss offered revision until newer revision; successful install/disable removes prompt. Reuse existing migration visibility/suppression conventions; measure the full Radio dock height, including dynamic callouts, rather than guess a fixed offset.
5. Extend existing browser scenarios where appropriate; no mocked production fallback. Source locale keys follow existing conventions.

## Acceptance/edges

U1/W1/W2: install optional, Skip never requests files or changes preferences; disabled release omits wizard step. U2/W3/W4: true pending blocks navigation/duplicate action, failed install never shows success, retry/skip recover. U3/W5/W7: ready/no update disables unnecessary install; exact installed/required/latest versions displayed; incompatible updates never offered by UI. Unsupported installations consume the shared repair offer regardless of their claimed revision (S7); ready higher revisions remain untouched. U4/W8/W9: auto prompt requires both release+audio; no remote check triggered by disabled UI, manual settings available under release flag; dismissal scoped to offered revision; update errors visible, no overlap. Language selection not added.

## Verification

Parent executes shared S1–S6 through actual setup, settings and global prompt with real backend/local release mirror and actual ZIP. Observe API requests, installed files/status, disabled/busy controls, setup completion, independent preferences, settings versions, dismissal/update/disable transitions. Backend owns controlled-clock scheduling, release-validation tests and native-HTTP repair/no-downgrade S7; browser evidence must still prove real startup prompt and install integration. Record pass/fail/blockers in shared contract; no planned test counts as passing.
