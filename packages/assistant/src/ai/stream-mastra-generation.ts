interface MastraGenerationStream {
  fullStream: AsyncIterable<{ type: string; payload?: unknown }>;
  finishReason: PromiseLike<string | undefined>;
  text: PromiseLike<string>;
  object: PromiseLike<unknown>;
  totalUsage: PromiseLike<unknown>;
}

export async function consumeMastraGeneration(
  pending: PromiseLike<MastraGenerationStream>,
  structured = false,
): Promise<{ text: string; object: unknown; usage: unknown }> {
  const stream = await pending;
  for await (const chunk of stream.fullStream) {
    if (chunk.type === "error" && chunk.payload && typeof chunk.payload === "object" && "error" in chunk.payload) {
      throw chunk.payload.error;
    }
  }
  if (await stream.finishReason !== "stop") throw new Error("ChatGPT did not complete the request. Try again.");
  const [text, object, usage] = await Promise.all([
    stream.text,
    structured ? stream.object : undefined,
    stream.totalUsage,
  ]);
  return { text, object, usage };
}
