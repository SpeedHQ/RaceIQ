
## Re-review fix

Adjusted `analysis-summary` primitive variant to use `!gap-2`, ensuring semantic row spacing wins over `app-sm` size gap composition without consumer overrides.

Verification: `cd client && bun run build` passed.
