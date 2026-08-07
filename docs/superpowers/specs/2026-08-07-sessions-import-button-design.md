# Sessions Import Button Design

## Goal
Make the existing MoTeC import action discoverable from Sessions for every game while avoiding any claim that unsupported game mappings are available.

## Current behavior
`SessionToolbar` renders the import action only when `motecImportSupported(gameId)` returns true. That allowlist currently contains only `ac-evo`. The modal loads server-configured MoTeC targets independently, and the server may expose no target for a given installation.

## Design
- Render `Import MoTeC` unconditionally in `SessionToolbar`.
- Keep the existing modal and upload flow unchanged for configured targets.
- When the modal receives no target, render an explicit unsupported state instead of showing blank selectors or a submit path.
- Preserve existing successful-import query invalidation for sessions and laps.
- Do not expand the server transcoder allowlist or pretend unsupported game logs are safe to import.

## User-visible behavior
- Sessions toolbar always includes `Import MoTeC`.
- With one configured target, modal behavior remains unchanged.
- With multiple configured targets, the existing game picker remains available.
- With zero configured targets, modal explains that MoTeC import is not configured for any game and provides a close action.

## Error handling
- Existing network and upload errors remain inline in the modal.
- Empty target configuration is handled before file and car/track controls are presented.
- No new fallback mapping or silent import is introduced.

## Verification
- Typecheck/build must pass.
- Exercise Sessions and confirm the button renders for a game outside the current MoTeC allowlist.
- Exercise the modal empty-target state through its target query behavior without submitting an invalid import.
