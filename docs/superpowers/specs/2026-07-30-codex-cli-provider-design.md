# Codex CLI AI Provider Design

## Goal

Add an `OpenAI Codex (ChatGPT subscription)` provider option for RaceIQ AI features. The provider must use the locally installed, authenticated Codex CLI rather than an OpenAI API key.

## Scope

Support Codex for analysis, chat, auto-tune, and driver-profile provider settings. Existing Gemini, OpenAI API, and Local providers remain unchanged.

## Architecture

The server treats `codex` as a provider with no stored secret. A small provider adapter invokes the Codex CLI as a subprocess with a structured prompt and parses its JSON output. The adapter reports missing executable, missing authentication, non-zero exit, timeout, and malformed output as actionable provider errors.

Settings exposes Codex alongside existing providers. Codex does not render an API-key input. Model selection uses a configured model string when supplied; otherwise the adapter uses the CLI default. Model discovery is not required because Codex CLI subscription models are controlled by the CLI.

Provider configuration and model mapping remain centralized, so all AI entry points use the same provider ID and error behavior. Codex-specific execution is isolated from direct OpenAI API calls and does not set `OPENAI_API_KEY`.

## Data flow

1. User selects Codex in Settings.
2. Settings saves `codex` and optional model values.
3. Server checks/invokes the local `codex` executable for each request.
4. CLI returns structured response text.
5. Server maps response into existing analysis/chat result contracts.

## Failure handling

- Missing CLI: explain that Codex CLI must be installed and available on PATH.
- Unauthenticated CLI: explain that the user must run Codex login.
- CLI failure or timeout: preserve provider error and avoid falling back silently to a metered provider.
- Invalid output: return a parse error with bounded diagnostic text.

## Verification

Add unit coverage for provider recognition, configuration state, model mapping, and CLI output/error parsing. Add a smoke path using a deterministic fake Codex executable; do not call a real subscription service in tests.
