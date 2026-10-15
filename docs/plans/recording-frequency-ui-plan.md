# Recording frequency UI implementation

Follow [shared contract](recording-frequency-contract.md) and [approved detailed plan](recording-frequency.md), steps4/9 and browser verification. Integration coordinator owns shared contracts; UI owns client components/hooks/messages/defaults only. Backend may proceed independently after contract agreement; fixtures must conform and never become production fallbacks.

## Tasks and acceptance
- U1/C1: StorageStep six server-backed buttons, immediate separate live-frequency save; loading/pending disables choices, failure retains saved choice plus alert.
- U2/C2: StorageSection adjacent automatic retention controls use one local five-field draft and explicit Save; incompatible ages disabled, invalid toggle shows validation, no silent age correction; failure preserves draft.
- U3/C3: SessionDownsampleDialog uses existing preview-confirm patterns, both scopes/default30/50, truthful counts/source bytes, favorite/MoTeC skip summaries and explicit irreversible confirmation. Zero candidates disables start.
- U4/C3/C5: feature-owned RPC/query hooks and inline Storage status restore on navigation, poll only while running, invalidate affected queries on terminal transitions; disable duplicate/conflicting actions, Retry partial/error.
- U5: localized messages and existing design tokens/primitives; responsive wrapping, keyboard access, aria-pressed/alerts.

## End-to-end verification
Use existing isolated app and Playwright fresh-install harness, not Storybook. Onboarding default100 ->50 ->navigate/reload ->GET numeric50; failed PUT retains50 and visible error (U1). Storage defaults false/30/50, save30/90/reload, reject equal/reversed enabled policies without intermediate writes; disabled policies allow equal ages (U2). Preview all/older-than with favorite/MoTeC fixtures; no file mutation until explicit Downsample; observe real202, inline progress, navigation return, terminal invalidation, partial retry skips completed files (U3/U4). Batch desktop/mobile, keyboard/focus and visual inspection (U5). C4/C6 integration uses backend real fixtures/API, not UI mocks. Record actual outcomes and unavailable checks; typecheck and i18n key gate supplement, never replace browser integration.
