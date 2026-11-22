---
status: accepted
---
# Use ChatGPT plan usage as a RaceIQ model provider

## Context

RaceIQ selects providers independently for Analysis, Chat, Auto-tune, and Driver Profile. A separate ACP/Codex agent would add a subprocess, a second tool boundary and workflow-specific integration. A direct copy of OMP's Codex transport would couple RaceIQ to the ChatGPT backend protocol.

## Decision

Add `chatgpt-subscription` as a peer provider using [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) and the public Responses API. Reuse RaceIQ's provider resolver, Mastra agents, tools and data contracts. Keep account credentials local, separate from API keys and settings. No implicit billing fallback.

The free local macOS build is the first live test target. Use macOS Keychain for its credentials. Windows retains a separate protected-storage and packaged verification requirement.

## Consequences

Eligibility for the actual distribution, secure credential storage, and live preview behavior across text, app tools, and structured output are release gates. A failed gate blocks release; a chat-only integration, ACP, or a private backend endpoint is not an approved fallback.

The local macOS build may run an installed Codex app server for read-only quota display. Codex manages its own sign-in; this exception does not authorize Codex for RaceIQ inference or allow credential sharing.

Codex usage: [Shared contract](../superpowers/plans/codex-usage-contract.md) · [UI](../superpowers/plans/codex-usage-ui-plan.md) · [Backend](../superpowers/plans/codex-usage-backend-plan.md)

Local macOS development also supports subscription controls over the standard Portless launcher. The backend accepts proof of local proxy ingress only in development. LAN and production policy remain unchanged.

Portless: [Shared contract](../superpowers/plans/portless-subscription-contract.md) · [UI](../superpowers/plans/portless-subscription-ui-plan.md) · [Backend](../superpowers/plans/portless-subscription-backend-plan.md)

Plan: [Shared contract](../superpowers/plans/chatgpt-provider-contract.md) · [UI](../superpowers/plans/chatgpt-provider-ui-plan.md) · [Backend](../superpowers/plans/chatgpt-provider-backend-plan.md)
