# Portless subscription contract

[Backend plan](portless-subscription-backend-plan.md) · [UI plan](portless-subscription-ui-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

Approved: default local macOS `bun dev` supports ChatGPT sign-in, account controls, provider selection and Codex usage at its printed Portless URL. No opt-in or URL change. Production, LAN and remote proxy access remain unchanged. Do not enable inference or launch Codex as a consequence of opening Settings.

## Boundary

Reuse the [subscription account API](chatgpt-provider-contract.md#account-api) and [Codex usage API](codex-usage-contract.md#operation). Request and response shapes, status codes, settings, callbacks and same-origin CSRF checks remain unchanged. For local development only, use the browser-facing Portless authority for the same-origin check. For example, `POST /api/auth/chatgpt-subscription/connect` with `Origin: http://raceiq.localhost:1355` and `{ "accountId": null }` returns existing `201 { attemptId, authorizationUrl }` when RaceIQ session checks pass; a foreign/missing Origin or unproven LAN request returns 403. Read-only GET permits no Origin from the verified local ingress. No caching of account or quota data. No localhost-hostname heuristic in the UI.

The combined macOS launcher shares an ephemeral secret between its server and Vite processes. Vite strips any inbound proof header. It attaches its own proof only to an HTTP API request for the assigned `.localhost` authority that did not come from a LAN relay, destined for the same launcher's loopback backend. The backend authenticates the proof on the actual loopback socket before treating the forwarded authority as browser origin. LAN relay connections are identified by their upstream socket before bytes reach Vite. Production ignores proof. The account service still uses its existing protected local storage, and the callback stays on loopback.

## Acceptance and verification

| ID | Real entry point and observable result |
| --- | --- |
| PL-1 | Launch isolated macOS `bun dev --onboarding false` without a local subscription opt-in. At its printed Portless URL, open AI Settings. See the sign-in button and Codex control with no RaceIQ account. Start sign-in, observe the real OpenAI authorization URL and pending state, then cancel. Check quota from the installed signed-in CLI. Verify provider discovery returns the subscription and disposal of the pending sign-in works. A completed OpenAI sign-in requires interactive user approval; record separately if not exercised. |
| PL-2 | Against that launch, try a foreign Origin, a mutation without Origin, direct forged forwarding/proof headers, and traffic through a LAN relay with the copied Portless Host/Origin and forged proof. Verify account/quota and the shared invocation guard deny them. Verify a legitimate direct local request still works and existing RaceIQ session/CSRF checks still apply. |
| PL-3 | Verify existing LAN dashboard HTTP and WebSocket forwarding remains intact. Launch with production access policy and assert no Portless access or implicit subscription opt-in. Missing CLI/auth/Keychain retain existing unavailable behavior and do not expose credentials. |

Main session runs PL-1–3 using isolated app data and the existing real browser/ingress harnesses plus `bun run typecheck`, then records observed results and unexercised cases. Fixture auth or quota is not proof of a live OpenAI or Codex login.
