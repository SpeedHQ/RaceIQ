# Local AI Setup

Use LM Studio or another OpenAI-compatible server (including Ollama-compatible endpoints) to keep telemetry analysis local.

## Requirements

- A machine running an OpenAI-compatible local provider.
- Network access from RaceIQ to the provider endpoint.

## Run an OpenAI-compatible provider

### LM Studio

1. Install from <https://lmstudio.ai/>.
2. Load a model from **Discover** or **Local**.
3. Open **Developer** tab and start the server.
4. Copy endpoint URL (commonly `http://localhost:1234/v1`).

### Ollama

1. Run Ollama and load a model.
2. Verify its OpenAI-compatible endpoint is reachable.
3. Use that endpoint in RaceIQ.

## Configure RaceIQ

1. Open **Settings → AI**.
2. Set **Provider** to **Local (LM Studio / Ollama)**.
3. Set **Endpoint** to your local URL.
4. Click **Load models** and select one model.
5. Save and run AI analysis.

RaceIQ sends local-provider requests only to the configured endpoint.

## Troubleshooting

- **No models appear**: ensure the provider is running, a model is loaded, and the endpoint includes any required `/v1` path.
- **Slow responses**: choose a smaller model or adjust provider GPU/offload settings.
- **Provider runs on another machine**: allow LAN access in the provider, then use its LAN address instead of `localhost`.

## Data handling

With a loopback endpoint, RaceIQ requests remain on the same machine. With a LAN endpoint, requests remain on that network path unless the provider forwards or retains them. Review provider configuration and logs for its data-handling policy.