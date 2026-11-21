---
status: proposed
---
# Use ChatGPT plan usage as a RaceIQ model provider

## Context

RaceIQ selects providers independently for Analysis, Chat, Auto-tune, and Driver Profile. A separate ACP/Codex agent would add a subprocess, a second tool boundary and workflow-specific integration. A direct copy of OMP's Codex transport would couple RaceIQ to the ChatGPT backend protocol.

## Proposed decision

Add `chatgpt-subscription` as a peer provider using [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) and the public Responses API. Reuse RaceIQ's provider resolver, Mastra agents, tools and data contracts. Keep account credentials local, separate from API keys and settings. No implicit billing fallback.

## Consequences

Eligibility for the actual distribution, secure credential storage, and live preview behavior across text, app tools, and structured output are release gates. A failed gate blocks release; a chat-only integration, ACP, or a private backend endpoint is not an approved fallback.

Plan: [Shared contract](../superpowers/plans/chatgpt-provider-contract.md) · [UI](../superpowers/plans/chatgpt-provider-ui-plan.md) · [Backend](../superpowers/plans/chatgpt-provider-backend-plan.md)
