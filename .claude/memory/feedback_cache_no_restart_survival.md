---
name: Cache designs need not survive restart
description: User does not value restart-survival as a benefit when weighing caching strategies for RaceIQ
type: feedback
---

When proposing caching strategies (lap bin parsing, AI results, anything else), do not weight "survives server restart" as a benefit. User considers the tray app restart-tolerant — re-warming after restart is fine.

**Why:** User said directly "i dont care for cache surviving restarts" when reviewing 3 caching strategies for the raw bin load+parse path. Persistent on-disk caches lose their headline benefit for this project.

**How to apply:** Prefer in-process caches (Map / LRU / per-session memory) over sidecar files or sqlite-backed caches. If a strategy's main pitch is "survives restart", drop it or down-rank it. Disk persistence is still fine when it has *other* benefits (sharing across processes, archival), but not as a standalone justification.
