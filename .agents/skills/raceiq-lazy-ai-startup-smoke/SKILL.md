---
name: raceiq-lazy-ai-startup-smoke
description: Verify RaceIQ Online lazy AI/Mastra initialization and the dashboard-auth CLI regression (auth disable must not open chat-memory.db or mastra-observability.duckdb); diagnose timeouts from concurrent load.
---

# RaceIQ Online lazy AI startup verification

Repo: RaceIQ/online (desktop). Context: AI agents/chat memory are lazy singletons (`apps/backend/src/ai/agents.ts` getters are async; `server/ai/chat-agent.ts` getChatMemory). `raceiq auth disable` must not create `chat-memory.db` or `mastra-observability.duckdb`.

## Gates
1. CLI regression: `bun --no-env-file test apps/backend/test/runtime/dashboard-auth.test.ts` (29 tests; CLI scenario spawns `apps/backend/src/index.ts auth disable` with a 10s test timeout).
   - If it times out only while other heavy jobs (e.g. Cloud e2e) run, rerun alone with `-t "CLI disable requires"` (about 2s) then the full file (about 13s). Load, not code, was the cause once.
2. Isolated AI + Studio smoke (dev Mastra path):
   `DATA_DIR=$(mktemp -d) NODE_ENV=development bun --no-env-file -e 'import { Hono } from "hono"; import { mountStudioServer } from "./apps/backend/src/runtime/dev-studio.ts"; import { getChatMemory } from "./server/ai/chat-agent.ts"; const app=new Hono(); await mountStudioServer(app); const m=getChatMemory(); if(m!==getChatMemory()) throw 1; await m.getThreadById({threadId:"x"}); const r=await app.request("http://localhost/studio-api/agents"); if(r.status!==200) throw 2; console.log("PASS"); process.exit(0)'`
   - "No AI provider selected" WARN lines from formatAgentList are expected noise with no provider configured.

## Pitfalls found
- In `apps/backend/src/mastra/index.ts`, imported agent factories must be aliased (`create*Agent`) because the file exports same-named `get*Agent` registry getters; duplicate bindings break module load.
- `sessionAgentForFocus` returns a Promise; callers/tests (e.g. `test/experiments/chat-branch-context.test.ts`) must await before `spyOn(..., "stream")`.
