import { expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateImageryRuntimeQueries } from "../src/components/dev/imagery/imagery-api";

test("imagery saves await exact runtime and configuration invalidations", async () => {
  const calls: unknown[][] = [];
  const releases: Array<() => void> = [];
  const queryClient: Pick<QueryClient, "invalidateQueries"> = {
    invalidateQueries: ((filters: { queryKey?: readonly unknown[] }) => {
      calls.push([...(filters.queryKey ?? [])]);
      return new Promise<void>((resolve) => releases.push(resolve));
    }) as QueryClient["invalidateQueries"],
  };

  let completed = false;
  const invalidation = invalidateImageryRuntimeQueries(queryClient, "acc", 42).then(() => {
    completed = true;
  });
  await Promise.resolve();

  expect(calls).toEqual([
    ["track-imagery", 42, "acc"],
    ["track-imagery-configurations"],
  ]);
  expect(completed).toBe(false);

  for (const release of releases) release();
  await invalidation;
  expect(completed).toBe(true);
});
