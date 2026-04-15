---
name: Use bunx over npx
description: Always use bunx instead of npx for running CLI tools in this project
type: feedback
originSessionId: 4e00fe23-a834-4643-80c0-efe052a4ee0c
---
Always use `bunx` instead of `npx` to run CLI tools.

**Why:** User prefers bunx as the project uses Bun as its runtime/package manager.

**How to apply:** Any time you'd reach for `npx <tool>`, use `bunx <tool>` instead. E.g. `bunx playwright install`, `bunx shadcn@latest add`, etc.
