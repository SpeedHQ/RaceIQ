# Local AI Hosting with LM Studio

Run RaceIQ's AI coaching on your own hardware. No API key, no data leaves your PC, and no per-request costs. Great if you already have a capable GPU and want unlimited lap analyses.

## What you need

- **Windows PC** — same machine as RaceIQ (or another on your LAN)
- **GPU with 8+ GB VRAM** recommended — smaller models run on CPU, but slowly
- **~10 GB disk** per model you download
- [LM Studio](https://lmstudio.ai/) — free desktop app for running local LLMs

> LM Studio exposes an **OpenAI-compatible** API, which is what RaceIQ's "Local" provider talks to. Ollama and other compatible servers work the same way.

## 1. Install LM Studio

1. Download LM Studio from <https://lmstudio.ai/> and install it
2. Launch LM Studio

## 2. Download a model

In LM Studio, open the **Discover** tab (magnifying-glass icon) and pick a model. Click **Download** and wait for it to finish.

### Recommended — Thinking / Reasoning models

These produce a `<think>...</think>` scratchpad before the answer. Slower per response, but the coaching output is noticeably sharper — they actually reason through the lap data instead of pattern-matching. **Pick one of these if you can spare the tokens.**

| Model | Size | VRAM | Notes |
|-------|------|------|-------|
| `Qwen3-8B` (Q4_K_M) | ~5 GB | 8 GB | Thinking toggle, great quality for the size |
| `Qwen3-14B` (Q4_K_M) | ~9 GB | 12 GB | **Recommended sweet spot** — fast + strong reasoning |
| `Qwen3-30B-A3B` (Q4_K_M) | ~18 GB | 20 GB | MoE — only 3B active, runs fast on consumer GPUs |
| `QwQ-32B` (Q4_K_M) | ~19 GB | 24 GB | Dedicated reasoning model, top-tier for lap analysis |
| `DeepSeek-R1-Distill-Qwen-14B` (Q4_K_M) | ~9 GB | 12 GB | Distilled R1 reasoning, good balance |

### Standard (non-thinking) models

Faster responses, lower VRAM, still capable for most coaching tasks.

| Model | Size | VRAM | Notes |
|-------|------|------|-------|
| `Gemma-3-4B-Instruct` (Q4_K_M) | ~3 GB | 6 GB | Google's 2025 model, solid for low-end GPUs |
| `Gemma-3-12B-Instruct` (Q4_K_M) | ~7.5 GB | 10 GB | Well-rounded, strong instruction following |
| `Gemma-3-27B-Instruct` (Q4_K_M) | ~16 GB | 20 GB | High quality, approaches frontier for local |
| `Llama-3.1-8B-Instruct` (Q4_K_M) | ~5 GB | 8 GB | Widely tested baseline |
| `Mistral-Small-3-24B-Instruct` (Q4_K_M) | ~14 GB | 18 GB | Strong generalist, fast at this size |

> **Tip:** Instruction-tuned (`-Instruct`, `-Chat`) and thinking variants respond to RaceIQ's coaching prompts much better than base models. Avoid anything without those suffixes.

> **Enabling thinking in Qwen3:** LM Studio respects the `/think` and `/no_think` control tags in system prompts, and most builds default to thinking mode. If responses look too short or skip reasoning, check the model's chat template settings.

## 3. Start the local server

1. Open the **Developer** tab in LM Studio (terminal/server icon on the left sidebar)
2. Select the model you downloaded from the dropdown at the top
3. Click **Start Server**

LM Studio now serves an OpenAI-compatible API at:

```
http://localhost:1234/v1
```

Leave LM Studio running while you use RaceIQ.

## 4. Configure RaceIQ

1. Open RaceIQ → **Settings → AI**
2. Set **Provider** to **Local (LM Studio / Ollama)**
3. Set **Endpoint** to `http://localhost:1234/v1`
4. Click **Load models** — your loaded model should appear in the dropdown
5. Select it and save

From now on, all AI-powered features (lap analysis, comparison, chat) route through your local model.

## Troubleshooting

**No models appear in the dropdown.**
Make sure LM Studio's server is running (green "Running" indicator on the Developer tab). Check the endpoint URL includes `/v1`.

**Responses are slow.**
Open the model's load settings in LM Studio and increase **GPU offload layers** to the max your VRAM allows. If you still can't fit, try a smaller quant (e.g. `Q4_K_S` instead of `Q5_K_M`) or a smaller model.

**Responses are truncated or low quality.**
- Raise the **context length** in LM Studio's model load settings (8192+ recommended)
- Try a larger or more recent instruction-tuned model
- Local 7B models are noticeably weaker than frontier cloud models — upgrade to 14B+ if quality matters

**RaceIQ runs on a different machine than LM Studio.**
In LM Studio, tick **Serve on local network** (Developer tab → server settings), then use the host PC's LAN IP in RaceIQ's endpoint field, e.g. `http://192.168.1.42:1234/v1`.

## Privacy note

When using the Local provider, telemetry and prompts stay on your network. Nothing is sent to Anthropic, OpenAI, Google, or any third party.
