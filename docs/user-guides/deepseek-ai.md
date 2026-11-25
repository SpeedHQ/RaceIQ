# DeepSeek AI Setup

Use DeepSeek as the AI provider for lap analysis, chat, auto-tune and driver profiles.

## Requirements

- A DeepSeek API key from <https://platform.deepseek.com/api_keys>.
- Network access to `https://api.deepseek.com`.

## Configure RaceIQ

1. Open **Settings → AI**.
2. Set **Provider** to **DeepSeek**.
3. Paste the API key into **DeepSeek API Key**.
4. Click **Load models**. RaceIQ reads the key's catalogue from `GET /models` and preselects
   `deepseek-flash`; `deepseek-v4-pro` is offered as well.
5. Repeat for **AI Chat**, **Setup Engineer** and **Driver Profile** if you want those features
   on DeepSeek too.

RaceIQ talks to the fixed endpoint `https://api.deepseek.com` — there is no endpoint field to
fill in, unlike the OpenAI-compatible provider.

## What the provider supports

| Capability | Detail |
| --- | --- |
| Chat completions | OpenAI-compatible `/chat/completions` |
| Tool calls | Supported, so the driver coach keeps every tool (`record_drill`, `compare_laps`, …) |
| Reasoning | Switched off for analysis requests, so the answer keeps the whole output budget |
| Context window | 1,000,000 tokens (shown in the context meter) |
| Image input | `deepseek-flash` only; `deepseek-v4-pro` is text-only |
| JSON output | Used for structured analysis requests |

## Notes

- DeepSeek is **not** handled by the OpenAI-compatible provider. It has its own endpoint and its
  own request rules: thinking is switched off, and structured requests ask for `json_object` with
  the schema in the prompt, because DeepSeek rejects `json_schema`.
- Auto-tune uses the provider and model selected for auto-tune, or the analysis settings when those fields are empty. Unsupported providers produce an error instead of switching providers.
- If **Load models** fails, the picker falls back to the built-in list so you can still pick a
  model and save. The failure reason is logged under `[AI]` in the app log.
- Key storage uses the OS credential store, same as the other providers.

## AI quality evaluations

Save the DeepSeek API key in **Settings → AI**, then select the evaluation model explicitly:

```sh
EVALS_PROVIDER=deepseek EVALS_MODEL=deepseek-flash bun run test:ai
EVALS_PROVIDER=deepseek EVALS_MODEL=deepseek-flash bun run ai:baseline
```

`EVALS_MODEL` is required; evaluation runs do not select a fallback model. DeepSeek evaluation
requests disable thinking, matching production analysis requests.

In Linux source checkouts, the development keystore is process-local and in memory. A key saved in a running server is unavailable to a separate evaluation CLI process, so these CLI commands cannot authenticate using that key. macOS and Windows use their OS credential stores.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `DeepSeek API key not set.` | Key not saved for the feature you are using; each feature has its own provider setting. |
| Requests fail with 401 | Key revoked or copied with extra whitespace. |
| Model list empty | `/models` unreachable; the static fallback list is still selectable. |
