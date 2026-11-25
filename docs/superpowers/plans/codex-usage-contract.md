# Codex usage contract

[Backend plan](codex-usage-backend-plan.md) · [UI plan](codex-usage-ui-plan.md) · [ADR](../../adr/0016-chatgpt-subscription-provider.md)

Approved scope: an opt-in, local macOS quota reader using Codex-managed ChatGPT sign-in. It is independent of RaceIQ's ChatGPT subscription provider, connected-app limit, credentials, and inference. No bundled Codex, account management, private HTTP integration, credit spending, or support on other platforms.

The [Portless contract](portless-subscription-contract.md) makes this available by default in local macOS development; production opt-in remains unchanged.

## Operation

`POST /api/auth/chatgpt-subscription/codex-usage` takes no body or parameters. It reads quota without making an inference call. POST uses the existing direct-loopback, canonical Host, matching Origin, RaceIQ authorization and CSRF checks before starting any process. Use `Cache-Control: no-store`. The existing account state's `availability: "available"` indicates whether the local build exposes the control, irrespective of whether a RaceIQ account is connected.

- `200`: `{ "status": "available", "windows": [{ "usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1784649600 }] }`. Nonempty array in upstream primary/secondary order, with at most two windows. `usedPercent` is 0–100, inclusive. `windowDurationMins` is a positive integer or null. `resetsAt` is Unix seconds or null. Label missing metadata as unknown or omit it; never infer values.
- `200`: `{ "status": "cli_missing" }`, `{ "status": "sign_in_required" }`, `{ "status": "quota_unavailable" }`, or `{ "status": "read_failed" }`. No `windows` in these states. `sign_in_required` includes API-key-only authentication. An unrecognized or malformed RPC reply, timeout, or upstream error becomes `read_failed` without raw diagnostics.
- Denied or unsupported callers get existing guarded-route errors (`403`/`503`, or existing RaceIQ authorization response). No Codex process starts. No accounts, tokens, credit details, or raw upstream diagnostics cross this boundary.

[Codex App Server rate-limit semantics](https://developers.openai.com/codex/app-server#6-rate-limits-chatgpt) are authoritative. Only the `codex` bucket counts: prefer its keyed entry; otherwise accept the singular bucket only if its `limitId` equals `codex`. Skip null windows. No matching bucket or windows returns `quota_unavailable`.

## Acceptance and integration

| ID | Scenario and expected result |
| --- | --- |
| CU-1 | Start the actual local app with the macOS opt-in and a Codex-managed ChatGPT account. Open AI Settings and request Codex usage. Verify the backend returns only sanitized quota data without a RaceIQ sign-in or inference request. For the isolated protocol fixture, put a test `codex` executable first in the server's PATH so the actual backend launches it. Assert the allowlisted RPC exchange and no inherited inference keys. Also exercise the installed CLI live; a fixture cannot prove upstream compatibility. |
| CU-2 | On the same app with the executable fixture, return 0% and 100% windows, one with a reset and one with missing metadata plus unrelated quota. Verify values, localized reset time, and Codex label. Activate refresh by keyboard at narrow width, return a changed snapshot, and verify the update and existing ChatGPT usage link. |
| CU-3 | Repeat from Settings with a PATH lacking Codex; then run the fixture for signed out, API key, unrelated bucket, error/timeout and recovery. Verify distinct guidance, removal of any previous numbers, and no false zero. Send requests with foreign Origin, without direct local ingress, or with feature opt-in off. Assert rejection and no child invocation. |

Run CU-1–3 and `bun run typecheck` after both sides are integrated. Reuse the existing Settings navigation in the seeded Playwright suite; use an isolated app with direct loopback for the Codex scenarios. Record observed results and any unavailable live account or platform explicitly. The main session owns integration and verification.
