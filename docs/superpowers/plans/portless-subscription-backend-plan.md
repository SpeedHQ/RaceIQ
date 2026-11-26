# Portless subscription backend plan

[Contract and PL-1–3 verification](portless-subscription-contract.md) · [UI plan](portless-subscription-ui-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

| Task | Scope and owner | Prerequisite | Acceptance |
| --- | --- | --- | --- |
| PLB-1 | Main session: `scripts/dev/{dev,dashboard-listeners}.ts`, `client/vite.config.ts` | Agreed contract | PL-1–3 |
| PLB-2 | Main session: `apps/backend/src/runtime/{http-access,chatgpt-subscription-runtime}.ts`, account/settings route composition and tests | Contract; independent of UI | PL-1–3 |
| PLB-3 | Main session: run real launcher, local/relay HTTP and existing dashboard-listener/authorization tests | PLB-1 and PLB-2; UI for integrated verification | PL-1–3 |

PLB-1: Mint an unexposed random 32-byte launch secret in `scripts/dev/dev.ts`, shared only through child environment. Extend the TCP relay in `startDashboardListeners` to track its connected upstream sockets before forwarding bytes; keep HTTP and WebSocket byte forwarding unchanged. In `forwardDashboardOrigin`, remove any supplied proof, preserve existing general proxy headers, and stamp only eligible requests per the contract. Never stamp `PROXY_TARGET` traffic. Do not introduce a persistent secret or new user preference.

PLB-2: In `http-access.ts`, derive trusted browser origin from real loopback ingress and matching proof. Retain the strict direct path and require matching Origin for account mutations and subscription inference. Apply the same guard to provider discovery, settings/model catalog and inference. Enable the macOS account service automatically for the combined dev launcher; preserve explicit production pilot behavior. Deny unavailable or remote requests before touching protected storage or Codex. Reuse account/session middleware; leave OAuth callback and protocol unchanged.

PLB-3: Reuse `chatgpt-subscription-routes.test.ts`, `chatgpt-subscription-ingress.test.ts`, and the dashboard TCP relay fixture. Include cross-origin, copied/forged proof and production variants, real Portless quota and account actions. Main session owns execution and results.
