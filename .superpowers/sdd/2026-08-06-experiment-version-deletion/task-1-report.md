
## Follow-up fix

Removed the early return for an empty active graph so Trash remains available after deleting the sole root version; empty-state text now renders alongside the launcher/dialog. Targeted client validation: `bunx tsc --project client/tsconfig.json --noEmit` passed.
