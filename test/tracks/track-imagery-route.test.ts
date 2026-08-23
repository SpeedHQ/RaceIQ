import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import sharp from "sharp";
import { trackImageryRoutes } from "../../server/routes/tracks/imagery-routes";
import { getBaseTrackImagePath } from "../../server/tracks/imagery";

const GAME_ID = "iracing";
const BASE_TRACK_NAME = "Imagery route test venue";
const IMAGE_PATH = getBaseTrackImagePath(GAME_ID, BASE_TRACK_NAME);
const ROUTE = `/api/track-base-image?gameId=${GAME_ID}&baseTrackName=${encodeURIComponent(BASE_TRACK_NAME)}`;

afterEach(() => rmSync(IMAGE_PATH, { force: true }));

describe("base track satellite image route", () => {
  test("stores an uploaded image as normalized WebP and serves it", async () => {
    const png = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#2457ff" } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append("file", new File([png], "satellite.png", { type: "image/png" }));

    const upload = await trackImageryRoutes.request(ROUTE, { method: "POST", body: form });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { imageUrl: string };
    expect(uploaded.imageUrl).toContain("/api/track-base-image?");

    const response = await trackImageryRoutes.request(uploaded.imageUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    const metadata = await sharp(await response.arrayBuffer()).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 32, height: 18 });
  });

  test("rejects undecodable image bytes", async () => {
    const form = new FormData();
    form.append("file", new File(["not an image"], "satellite.png", { type: "image/png" }));

    const response = await trackImageryRoutes.request(ROUTE, { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Image could not be decoded" });
  });
});
