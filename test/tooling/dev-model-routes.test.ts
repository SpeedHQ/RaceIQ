import { describe, expect, test } from "bun:test";
import { modelRoutes } from "../../server/routes/dev/model-routes";

describe("development GT3 model routes", () => {
  test("reports both model sizes and vertex counts", async () => {
    const response = await modelRoutes.request("http://localhost/api/dev/models/gt3");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.original.sizeBytes).toBe(54_465_060);
    expect(payload.optimized.sizeBytes).toBeGreaterThan(0);
    expect(payload.original.vertexCount).toBeGreaterThan(payload.optimized.vertexCount);
  });

  test("reports F1 model stats and serves its original asset", async () => {
    const statsResponse = await modelRoutes.request("http://localhost/api/dev/models/f1");
    expect(statsResponse.status).toBe(200);
    const payload = await statsResponse.json();
    expect(payload.original.sizeBytes).toBe(66_447_808);
    expect(payload.optimized.sizeBytes).toBeGreaterThan(0);
    const modelResponse = await modelRoutes.request("http://localhost/api/dev/models/f1/original");
    expect(modelResponse.status).toBe(200);
    expect((await modelResponse.arrayBuffer()).byteLength).toBe(66_447_808);
  });
  test("serves original model only from dev route", async () => {
    const response = await modelRoutes.request("http://localhost/api/dev/models/gt3/original");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("model/gltf-binary");
    expect((await response.arrayBuffer()).byteLength).toBe(54_465_060);
  });
});
