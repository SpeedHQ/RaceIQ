---
name: subagent-model-tiers
description: Never use Fable 5 for any subagent (single or fan-out) unless explicitly told; default all Agent calls to sonnet (or haiku)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cf4b698a-e9c4-4099-bf7c-534633ca5170
---

Never spawn ANY subagent (Agent tool) on Fable 5 unless user explicitly says so — single-task or fan-out. Fable is for investigation and orchestration in the main loop only, never as a delegated worker.

**Why:** Fable is top-tier/expensive; delegated work (single or parallel) is fine on a smaller model. User caught default Agent calls silently picking Fable even for one-off tasks.

**How to apply:** Every Agent tool call must pass `model: "sonnet"` (or `haiku` for trivial work) explicitly — do not omit model and let it default. No exceptions without explicit user instruction.

**Session 2026-07-14 addendum:** user later said "do not spawn agents, work in here" — for repetitive curation-style work in this project, do it inline in the main loop, no Agent calls at all.
