import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { estimateChatGptApiCost } from "@raceiq/shared/integrations/ai/chatgpt-subscription";
import { chatGptReasoningLevels } from "@raceiq/shared/integrations/ai/openai-reasoning";
import { createChatGptPricingCache } from "../../../src/ai/chatgpt-chat-pricing";

const model = "gpt-6.2-sol";
const standard = { input: 2, cache_read: 0.1, output: 10 };
const long = { input: 4, cache_read: 0.2, output: 15, tier: { type: "context", size: 272_000 } };

test("fetches rates on demand, shares refresh, and retains valid rates during outage", async () => {
  let time = 0;
  let requests = 0;
  let failure = true;
  let output = 10;
  const getPricing = createChatGptPricingCache(async () => {
    requests++;
    return failure ? new Response(null, { status: 503 }) : Response.json({
      openai: { models: { [model]: { cost: { ...standard, output, tiers: [long] } } } },
    });
  }, () => time);
  expect(requests).toBe(0);
  expect(await getPricing()).toEqual({ fetchedAt: null, models: {} });
  expect(await getPricing()).toEqual({ fetchedAt: null, models: {} });
  expect(requests).toBe(1);
  failure = false;
  time += 60_000;
  const [first, concurrent] = await Promise.all([getPricing(), getPricing()]);
  expect(first).toBe(concurrent);
  expect(requests).toBe(2);
  expect(first.fetchedAt).toBe(time);
  expect(first.models[model]?.longContext).toEqual({ threshold: 272_000, input: 4, cachedInput: 0.2, output: 15 });
  time += 6 * 60 * 60_000 - 1;
  expect(await getPricing()).toBe(first);
  expect(requests).toBe(2);
  time++;
  failure = true;
  expect(await getPricing()).toBe(first);
  expect(await getPricing()).toBe(first);
  expect(requests).toBe(3);
  time += 60_000;
  failure = false;
  output = 12;
  expect((await getPricing()).models[model]?.output).toBe(12);
  expect(requests).toBe(4);
});

test("reuses rates after restart and keeps expired rates until refresh succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-chatgpt-pricing-"));
  const cachePath = join(directory, "cache", "pricing.json");
  let time = 1;
  let requests = 0;
  let output = 10;
  let available = true;
  const catalog = async () => {
    requests++;
    return available
      ? Response.json({ openai: { models: { [model]: { cost: { ...standard, output, tiers: [long] } } } } })
      : new Response(null, { status: 503 });
  };
  try {
    const cold = createChatGptPricingCache(catalog, () => time, cachePath);
    const [initial, requested] = await Promise.all([cold("boot"), cold()]);
    expect(requested).toBe(initial);
    expect(initial.models[model]?.output).toBe(10);
    expect(await createChatGptPricingCache(catalog, () => time, cachePath)("boot")).toEqual(initial);
    expect(requests).toBe(1);

    time += 6 * 60 * 60_000;
    available = false;
    const restarted = createChatGptPricingCache(catalog, () => time, cachePath);
    expect(await restarted("boot")).toEqual(initial);
    expect(requests).toBe(1);
    expect(await restarted()).toEqual(initial);
    expect(requests).toBe(2);

    time += 60_000;
    available = true;
    output = 12;
    const refreshed = await restarted();
    expect(refreshed.fetchedAt).toBe(time);
    expect(refreshed.models[model]?.output).toBe(12);
    expect(await createChatGptPricingCache(catalog, () => time, cachePath)()).toEqual(refreshed);
    expect(requests).toBe(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores invalid disk rates and serves fetched rates even when disk is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-chatgpt-pricing-"));
  const cachePath = join(directory, "pricing.json");
  try {
    await writeFile(cachePath, JSON.stringify({ fetchedAt: 1, models: { [model]: { ...standard, cachedInput: -1 } } }));
    const offline = createChatGptPricingCache(async () => new Response(null, { status: 503 }), () => 2, cachePath);
    expect(await offline("boot")).toEqual({ fetchedAt: null, models: {} });

    const blockedPath = join(cachePath, "nested.json");
    const online = createChatGptPricingCache(async () => Response.json({
      openai: { models: { [model]: { cost: standard } } },
    }), () => 2, blockedPath);
    expect((await online()).models[model]).toEqual({ input: 2, cachedInput: 0.1, output: 10 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prices cached input once and applies context tiers per request", async () => {
  const getPricing = createChatGptPricingCache(async () => Response.json({
    openai: { models: { [model]: { cost: { ...standard, tiers: [long] } } } },
  }));
  const pricing = await getPricing();
  const request = { model, inputTokens: 272_000, cachedInputTokens: 500, outputTokens: 100 };
  expect(estimateChatGptApiCost([request], pricing)).toBeCloseTo(0.54405, 9);
  expect(estimateChatGptApiCost([request, { ...request, inputTokens: 272_001 }], pricing)).toBeCloseTo(1.631654, 9);
  expect(estimateChatGptApiCost([request, { ...request, model: "gpt-future" }], pricing)).toBeNull();
});

test("only offers documented efforts for the selected model", () => {
  expect(chatGptReasoningLevels(model)).toContain("high");
  expect(chatGptReasoningLevels(model)).not.toContain("none");
  expect(chatGptReasoningLevels("gpt-6-luna")).toContain("none");
  expect(chatGptReasoningLevels("gpt-99")).toEqual([]);
});
