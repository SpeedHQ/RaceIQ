import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { USER_DATA_DIR } from "@raceiq/backend-core/runtime/config/paths";
import type { ChatGptPricingSnapshot, ChatGptTokenRates } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { z } from "zod";

const catalogUrl = "https://models.dev/api.json";
const ttl = 6 * 60 * 60_000;
const retryDelay = 60_000;
const rate = z.number().nonnegative();
const ratesSchema = z.object({ input: rate, cache_read: rate, output: rate });
const tierSchema = ratesSchema.extend({ tier: z.object({ type: z.literal("context"), size: z.number().int().positive() }) });
const costSchema = ratesSchema.extend({ tiers: z.tuple([tierSchema]).or(z.tuple([])).optional() });
const catalogSchema = z.object({ openai: z.object({ models: z.record(z.string(), z.object({ cost: z.unknown() })) }) });
const storedRatesSchema = z.object({ input: rate, cachedInput: rate, output: rate });
const snapshotSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  models: z.record(
    z.string().regex(/^gpt-\d/),
    storedRatesSchema.extend({
      longContext: storedRatesSchema.extend({ threshold: z.number().int().positive() }).optional(),
    }),
  ).refine((models) => Object.keys(models).length > 0),
});

async function saveSnapshot(path: string, snapshot: ChatGptPricingSnapshot) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(snapshot), { flag: "wx" });
    await rename(temporaryPath, path);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function toRates(data: z.infer<typeof ratesSchema>): ChatGptTokenRates {
  return { input: data.input, cachedInput: data.cache_read, output: data.output };
}

export function createChatGptPricingCache(
  fetchCatalog: (url: string, init: RequestInit) => Promise<Response> = fetch,
  now = Date.now,
  cachePath?: string,
) {
  let snapshot: ChatGptPricingSnapshot = { fetchedAt: null, models: {} };
  let retryAt = 0;
  let pending: Promise<ChatGptPricingSnapshot> | undefined;
  let diskLoad: Promise<void> | undefined;

  async function refresh() {
    try {
      const response = await fetchCatalog(catalogUrl, { redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Pricing catalog HTTP ${response.status}`);
      }
      const catalog = catalogSchema.parse(await response.json());
      const models: ChatGptPricingSnapshot["models"] = Object.create(null);
      for (const [model, { cost }] of Object.entries(catalog.openai.models)) {
        if (!/^gpt-\d/.test(model)) continue;
        const parsed = costSchema.safeParse(cost);
        if (!parsed.success) continue;
        const contextTier = parsed.data.tiers?.[0];
        models[model] = {
          ...toRates(parsed.data),
          ...(contextTier ? { longContext: { ...toRates(contextTier), threshold: contextTier.tier.size } } : {}),
        };
      }
      if (!Object.keys(models).length) throw new Error("Pricing catalog has no supported OpenAI rates");
      snapshot = { fetchedAt: now(), models };
      if (cachePath) await saveSnapshot(cachePath, snapshot);
    } catch {
      retryAt = now() + retryDelay;
    }
    return snapshot;
  }

  return async function getPricing(mode?: "boot"): Promise<ChatGptPricingSnapshot> {
    if (cachePath && snapshot.fetchedAt === null) {
      await (diskLoad ??= readFile(cachePath, "utf8")
        .then((text) => {
          const stored = snapshotSchema.parse(JSON.parse(text));
          if (stored.fetchedAt <= now()) snapshot = stored;
        })
        .catch(() => undefined));
    }
    if (pending) return pending;
    const time = now();
    if ((snapshot.fetchedAt !== null && (mode === "boot" || time - snapshot.fetchedAt < ttl)) || time < retryAt) {
      return snapshot;
    }
    return pending = refresh().finally(() => { pending = undefined; });
  };
}

export const getChatGptPricing = createChatGptPricingCache(fetch, Date.now, join(USER_DATA_DIR, "chatgpt-pricing.json"));
