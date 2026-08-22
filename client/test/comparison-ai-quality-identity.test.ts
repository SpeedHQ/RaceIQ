import { describe, expect, test } from "bun:test";
import { comparisonAiStateKey } from "../src/lib/lap-ai-state-key";
import { fetchCompareChatHistory, type LapHeader } from "../src/components/comparison/compare-ai-types";

function lap(id: number, qualityGeneration: string, qualityStale = false): LapHeader {
  return {
    id,
    label: `Lap ${id}`,
    lapTime: 90 + id,
    sessionId: 1,
    qualityGeneration,
    qualityStale,
    quality: {
      provenance: {
        schemaVersion: "1",
        policyVersion: "1",
        configurationVersion: "1",
        sourceGeneration: `source-${id}`,
        outputGeneration: qualityGeneration,
      },
    },
  } as LapHeader;
}

describe("comparison AI state identity", () => {
  test("changes when either lap quality generation changes", () => {
    const original = comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b1"));

    expect(comparisonAiStateKey(lap(1, "quality-a2"), lap(2, "quality-b1"))).not.toBe(original);
    expect(comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b2"))).not.toBe(original);
    expect(comparisonAiStateKey(lap(1, "quality-a1", true), lap(2, "quality-b1"))).not.toBe(original);
  });

  test("is stable when lap order is reversed", () => {
    expect(comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b1"))).toBe(comparisonAiStateKey(lap(2, "quality-b1"), lap(1, "quality-a1")));
  });

  test("uses typed RPC with GameId header instead of missing-game 400 path", async () => {
    const serverThreadId = `compare-1-2~q${"a".repeat(64)}`;
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedGameId: string | null = null;
    globalThis.fetch = async (input, init) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      requestedGameId = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("X-Game-Id");
      if (requestedGameId !== "acc") {
        return new Response(JSON.stringify({ error: "Missing or invalid X-Game-Id header" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          messages: [
            { id: "user-1", role: "user", parts: [{ type: "text", text: "Question" }] },
            { id: "system-1", role: "system", parts: [{ type: "text", text: "Hidden" }] },
          ],
          threadId: serverThreadId,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const history = await fetchCompareChatHistory(2, 1, "acc", 1);
      expect(requestedUrl).toEndWith("?gen=1");
      expect(requestedGameId).toBe("acc");
      expect(history.threadId).toBe(serverThreadId);
      expect(history.messages.map((message) => message.role)).toEqual(["user"]);
      expect(history.threadId).not.toContain("quality-a1");
      expect(history.threadId).not.toContain(comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b1")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
