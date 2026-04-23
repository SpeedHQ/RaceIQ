---
name: Prefer minimal scoped changes
description: User wants tight, single-purpose changes — no bundled refactors or "while we're here" fixes
type: feedback
---

When user requests a fix or feature, do not bundle adjacent improvements (refactors, related cleanups, "while we're here" optimisations) unless explicitly asked. Land the smallest change that solves the stated problem.

**Why:** User repeatedly trims my proposals down. On the bin-cache task they said "ok for now, lets just focus on caching the parsed session/lap data nothing else, nothing fancy" after I had folded in `/api/chats` cleanup and a getLapMeta split. Smaller PRs review faster and ship more reliably.

**How to apply:**
- Plan only the change asked for. Note adjacent improvements as "future work" in passing, don't expand scope.
- When choosing between strategies, default to the cheapest one that addresses the stated problem.
- Skip nice-to-haves (hit counters, debug logging, version headers, telemetry sidecars) unless user asks.
- If you spot a related bug or perf issue while working, mention it — let user decide whether to bundle.
