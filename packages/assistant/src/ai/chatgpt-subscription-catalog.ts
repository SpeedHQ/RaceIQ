import { z } from "zod";
import type { AiFeature } from "@raceiq/assistant/ai/ai-features";
import { ChatGptAccountError } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import type { ChatGptAccountBinding } from "@raceiq/shared/integrations/ai/chatgpt-subscription";

const catalogSchema = z.object({ models: z.array(z.object({ slug: z.string().min(1), display_name: z.string().min(1), visibility: z.string() })) });
const catalogTtl = 5 * 60_000;
const gpt6OrNewer = /^gpt-(?:[6-9]|[1-9]\d+)(?=$|[.-])/;
const subscriptionFeatures = ["analysis", "chat", "autoTune", "driverProfile"] as const;

export interface ChatGptCatalogModel {
  id: string;
  name: string;
  features: Exclude<AiFeature, "compaction">[];
  supportsImages: boolean;
}

const cache = new WeakMap<AbortSignal, { at: number; models: ChatGptCatalogModel[] }>();

export async function getChatGptCatalog(binding: ChatGptAccountBinding, refresh = false): Promise<ChatGptCatalogModel[]> {
  binding.signal.throwIfAborted();
  const cached = cache.get(binding.signal);
  if (!refresh && cached && Date.now() - cached.at < catalogTtl) return cached.models;
  const token = await binding.token();
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.any([binding.signal, AbortSignal.timeout(15_000)]),
  }).catch(() => { throw new ChatGptAccountError("upstream_unavailable"); });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ChatGptAccountError(response.status === 401 ? "reauth_required" : response.status === 403 ? "plan_unavailable" : response.status === 429 ? "usage_limit" : "upstream_unavailable");
  }
  const catalog = catalogSchema.safeParse(await response.json().catch(() => null));
  if (!catalog.success) throw new ChatGptAccountError("upstream_unavailable");
  const models: ChatGptCatalogModel[] = [];
  for (const model of catalog.data.models) {
    if (model.visibility !== "list" || !gpt6OrNewer.test(model.slug)) continue;
    models.push({ id: model.slug, name: model.display_name, features: [...subscriptionFeatures], supportsImages: false });
  }
  if (binding.signal.aborted) throw new ChatGptAccountError("reauth_required");
  cache.set(binding.signal, { at: Date.now(), models });
  return models;
}
