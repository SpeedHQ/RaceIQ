import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccOpponentStandings } from "../src/components/acc/AccOpponentStandings";
import type { LiveCompetitorView } from "../src/lib/live-telemetry-view";

const competitors: LiveCompetitorView[] = Array.from({ length: 12 }, (_, index) => ({
  carIndex: 100 + index,
  position: index + 1,
  name: `Driver ${index + 1}`,
  classId: "0",
  className: "GT3",
  lapsComplete: 8,
  lastLapS: 91.234,
  lastLapValid: index !== 7,
  pitStatus: index === 7 ? "pit_lane" : "out",
  connected: index !== 7,
})).reverse();
const source = { source: "acc-broadcast", state: "available", reasonCode: "ready" } as const;

test("focuses actual player and neighbors, sorts rows and separates omitted ranks", () => {
  const markup = renderToStaticMarkup(<AccOpponentStandings competitors={competitors} playerCarIndex={107} opponentSource={source} />);
  const rows = [...markup.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)].map((match) => match[0]);
  const drivers = rows.filter((row) => row.includes("Driver "));
  expect(drivers.map((row) => row.match(/Driver (\d+)/)?.[1])).toEqual(["1", "6", "7", "8", "9", "10"]);
  expect(drivers.filter((row) => row.includes('data-selected="true"')).map((row) => row.match(/Driver (\d+)/)?.[1])).toEqual(["8"]);
  expect(rows.filter((row) => row.includes("…"))).toHaveLength(2);
  expect(markup).toContain("Show all (12)");
  expect(markup).not.toMatch(/<tr\b[^>]*>\s*<tr\b/);
});

test("renders source-backed class, lap validity, pit, connectivity, and missing gap", () => {
  const markup = renderToStaticMarkup(<AccOpponentStandings competitors={competitors.filter((row) => row.carIndex === 107)} playerCarIndex={107} opponentSource={source} />);
  expect(markup).toContain("GT3");
  expect(markup).toContain("1:31.234 (invalid)");
  expect(markup).toContain("Pit lane");
  expect(markup).toContain("Disconnected");
  expect(markup).toContain("—");
});

test("source loss or rejected grid removes table while preserving local explanation", () => {
  for (const state of ["unavailable", "stale", "malformed"] as const) {
    const markup = renderToStaticMarkup(<AccOpponentStandings competitors={competitors} playerCarIndex={107} opponentSource={{ ...source, state, reasonCode: "source-timeout" }} />);
    expect(markup).not.toContain("<table");
    expect(markup).toContain(`Opponent standings ${state}: source-timeout`);
  }
  const rejected = renderToStaticMarkup(<AccOpponentStandings competitors={[]} playerCarIndex={107} opponentSource={source} />);
  expect(rejected).not.toContain("<table");
  expect(rejected).toContain("incomplete-grid");
});
