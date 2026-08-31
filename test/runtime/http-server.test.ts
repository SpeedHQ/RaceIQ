import { describe, expect, test } from "bun:test";
import { staticAssetHeaders } from "../../server/runtime/http-server";

describe("static asset headers", () => {
  test("marks gzip JSON assets for transparent browser decompression", () => {
    expect(staticAssetHeaders("/dist/public/demo-lap.json.gz")).toEqual({
      "content-encoding": "gzip",
      "content-type": "application/json",
    });
  });

  test("leaves ordinary assets on Bun's default content type", () => {
    expect(staticAssetHeaders("/dist/public/index.html")).toBeUndefined();
  });
});
