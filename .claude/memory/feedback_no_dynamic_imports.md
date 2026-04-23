---
name: never use dynamic imports
description: acoop: no `await import()` except for platform-specific switches (e.g. win32-only modules) — static top-of-file imports always
type: feedback
originSessionId: d4edd7cd-63ff-4855-a3cd-166999020138
---
Never use dynamic `await import()`. Static imports at top of file only.

**Why:** acoop wants all imports visible at the top of every file — no scattered `await` boilerplate, no per-call-site module loads that defer load cost into hot paths (in tests this showed up as a 234s `isNewer` case because the dynamic import pulled in ws/pipeline/db chains).

**How to apply:**
- Add new deps to the import block at the top of the module. Do not copy existing dynamic-import patterns in the same file — break the pattern and use static imports.
- **Only exception**: a literal platform-specific switch where the import target doesn't exist on the other platform (e.g. a Windows-only native module guarded by `if (process.platform === "win32")`). Document the reason inline when using this exception.
- "Lazy load to avoid startup cost" and "break a circular dep" are NOT valid reasons — fix the architecture instead.
