

## Reviewer fix round 3

Status remains: DONE_WITH_CONCERNS.

Removed all staging links/copies. Runner now creates only an empty disposable cwd, generates a temporary config rooted there, invokes Bun with absolute manifest paths, and uses an absolute repository preload path for integration. Focused unit (`parse-lap-time`) passed 5/5. Focused integration (`runtime-options`) passed 4/4 with migrations/preload. The prior `database-path` focused check depends on process-cwd-relative child paths and is not suitable for empty-cwd verification; no production changes made.
