import { describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  getSessionQualityStatus,
  invalidateSessionQualityQueries,
  rebuildSessionQuality,
} from "../src/components/LapQualityBadge";
import { qualityUpdatedQueryKeys, queryKeys } from "../src/hooks/query-keys";

function requestDetails(input: RequestInfo | URL, init?: RequestInit): { method: string; url: string } {
  if (input instanceof Request) return { method: input.method, url: input.url };
  return { method: init?.method ?? "GET", url: String(input) };
}


test("scopes lap issue cache keys by game", () => {
  expect(queryKeys.lapIssuesForLap(99, "iracing")).toEqual(["lap-issues", 99, "iracing"]);
  expect(queryKeys.lapIssuesForLap(99, "iracing")).not.toEqual(queryKeys.lapIssuesForLap(99, "acc"));
});
describe("lap quality RPC integration", () => {
  test("loads session quality through typed GET route", async () => {
    const originalFetch = globalThis.fetch;
    let request: { method: string; url: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = requestDetails(input, init);
      return Response.json({ action: "rebuild_eligibility", laps: [] });
    }) as typeof fetch;

    try {
      const status = await getSessionQualityStatus(42, "iracing");
      expect(request).toEqual({ method: "GET", url: "/api/sessions/42/quality?gameId=iracing" });
      expect(status.action).toBe("rebuild_eligibility");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rebuilds through typed POST route and invalidates every quality query", async () => {
    const originalFetch = globalThis.fetch;
    let request: { method: string; url: string } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = requestDetails(input, init);
      return Response.json({ strategy: "eligibility", status: { action: "current" } });
    }) as typeof fetch;

    try {
      const result = await rebuildSessionQuality(42, "iracing");
      expect(request).toEqual({ method: "POST", url: "/api/sessions/42/quality/rebuild?gameId=iracing" });
      expect(result.strategy).toBe("eligibility");

      const invalidated: unknown[] = [];
      const invalidateQueries = mock(async (filters: { queryKey?: readonly unknown[] }) => {
        invalidated.push(filters.queryKey);
      });
      await invalidateSessionQualityQueries(
        { invalidateQueries } as unknown as Pick<QueryClient, "invalidateQueries">,
        42,
        "iracing",
      );
      expect(invalidated).toEqual(qualityUpdatedQueryKeys(42, "iracing"));
      expect(invalidated).toContainEqual(["session-quality", 42, "iracing"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces typed GET and POST API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ error: "Source recording unavailable" }, { status: 409 })) as typeof fetch;

    try {
      await expect(getSessionQualityStatus(42, "iracing")).rejects.toThrow("Source recording unavailable");
      await expect(rebuildSessionQuality(42, "iracing")).rejects.toThrow("Source recording unavailable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
