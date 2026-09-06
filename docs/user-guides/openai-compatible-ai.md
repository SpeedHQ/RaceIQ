# OpenAI-Compatible AI Setup

Use LM Studio, Ollama, OpenRouter, LiteLLM, or any OpenAI-compatible endpoint.

## Requirements

- A reachable OpenAI-compatible provider endpoint.
- Optional bearer API key when provider requires authentication.

## Providers

### LM Studio

1. Install from <https://lmstudio.ai/>.
2. Load a model from **Discover** or **Local**.
3. Open **Developer** tab and start the server.
4. Copy endpoint URL (commonly `http://localhost:1234/v1`).

### Ollama

1. Run Ollama and load a model.
2. Verify its OpenAI-compatible endpoint is reachable.
3. Use that endpoint in RaceIQ.

### OpenRouter

1. Copy your OpenRouter API key.
2. Use `https://openrouter.ai/api/v1` as endpoint.
3. Select an OpenRouter model ID, such as `openai/gpt-4o-mini`.

## Configure RaceIQ

1. Open **Settings → AI**.
2. Set **Provider** to **OpenAI-compatible**.
3. Set **Endpoint** to provider base URL, including `/v1` when required.
4. Enter optional **OpenAI-compatible API Key**.
5. Click **Load models**, select one model, then save.

RaceIQ sends requests only to configured endpoint with bearer authentication when key is set.


## Troubleshooting

- **No models appear**: ensure the provider is running, a model is loaded, and the endpoint includes any required `/v1` path.
- **Slow responses**: choose a smaller model or adjust provider GPU/offload settings.
- **Provider runs on another machine**: allow LAN access in the provider, then use its LAN address instead of `localhost`.

## Data handling

With a loopback endpoint, RaceIQ requests remain on the same machine. With a LAN endpoint, requests remain on that network path unless the provider forwards or retains them. Review provider configuration and logs for its data-handling policy.