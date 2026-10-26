import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readTrackEdge(svg: string, id: "left" | "right"): { x: number; z: number }[] {
  const paths = [...svg.matchAll(/<path\b([^>]*)>/g)];
  const path = paths.find(([, attributes]) => attributes.match(/\bid="([^"]*)"/)?.[1] === id)?.[1];
  const data = path?.match(/\bd="([^"]*)"/)?.[1];
  expect(data, `SVG must contain a ${id} boundary`).toBeDefined();
  const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const polyline = new RegExp(`^M\\s+${number}\\s+${number}(?:\\s+L\\s+${number}\\s+${number})*\\s+Z$`);
  expect(data).toMatch(polyline);
  const values = data!.match(new RegExp(number, "g"))!.map(Number);
  expect(values.length).toBeGreaterThanOrEqual(6);
  expect(values.every(Number.isFinite)).toBe(true);
  const points = Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2]!, z: values[index * 2 + 1]! }));
  return points;
}

test("AMS2 Replay renders the extracted SVG circuit in native coordinates", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const response = await request.get("/api/laps?gameId=ams2");
  expect(response.ok()).toBe(true);
  const laps = await response.json() as { id: number; sessionId: number; trackId: string; lapNumber: number; lapTime: number }[];
  const lap = laps.find(lap => String(lap.trackId) === "165370945" && lap.lapNumber === 4 && lap.lapTime > 60);
  expect(lap, "Brands Hatch Indy Polo fixture needs its fourth completed lap").toBeDefined();
  const boundariesResponse = await request.get(`/api/track-boundaries/${lap!.trackId}?gameId=ams2`);
  expect(boundariesResponse.ok()).toBe(true);
  const boundaries = await boundariesResponse.json() as { coordSystem: string; leftEdge: unknown[]; rightEdge: unknown[] };
  const catalog = JSON.parse(readFileSync(resolve(__dirname, "../../../../game-ams2/assets/tracks.json"), "utf8")) as { tracks: { layout: string; trackSvg: string; lengthM: number }[] };
  const track = catalog.tracks.find(entry => entry.layout === "BrandsHatch_Indy");
  expect(track).toBeDefined();
  const svg = readFileSync(resolve(__dirname, "../../../../game-ams2/assets", track!.trackSvg), "utf8");
  const leftEdge = readTrackEdge(svg, "left");
  const rightEdge = readTrackEdge(svg, "right");
  expect(boundaries.coordSystem).toBe("ams2-world");
  expect(boundaries.leftEdge).toEqual(leftEdge);
  expect(boundaries.rightEdge).toEqual(rightEdge);

  await page.goto(`/ams2/sessions/${lap!.sessionId}/replay/${lap!.id}?forceWebGL=true`);
  const split = page.getByRole("button", { name: "Split recordings", exact: true });
  await page.addLocatorHandler(split, () => split.click());
  const scene = page.locator("[data-replay-scene]");
  await expect(scene).toHaveAttribute("data-scene-ready", "true", { timeout: 60_000 });
  const canvas = scene.locator("canvas").first();
  await expect(canvas).toHaveAttribute("data-track-geometry-source", "calibrated-boundaries");
  await expect.poll(async () => Number(await canvas.getAttribute("data-track-edge-count"))).toBeGreaterThan(0);
  const data = page.locator("[data-spectate-data-side]");
  await expect(data).toHaveAttribute("data-packet-count", /^\d+$/);
  const packetCount = Number(await data.getAttribute("data-packet-count"));
  await expect.poll(async () => Number(await canvas.getAttribute("data-a-racing-line-segments"))).toBeGreaterThan(packetCount * 0.95);
  await page.getByRole("slider", { name: "Replay position", exact: true }).fill("20.025");
  await expect(scene).toHaveAttribute("data-side-a-state", "ready");
  await page.screenshot({ path: testInfo.outputPath("ams2-svg-replay.png"), animations: "disabled" });
});

