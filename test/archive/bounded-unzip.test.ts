import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { gzipSync } from "node:zlib";
import {
  assertArchiveUploadSize,
  unzipBounded,
  type ZipExtractionLimits,
} from "../../server/archive/bounded-unzip";
import { decompressIfGzipSync } from "../../server/session-capture/framing";

const limits: ZipExtractionLimits = {
  maxArchiveBytes: 1024,
  maxEntries: 2,
  maxEntryBytes: 32,
  maxTotalBytes: 48,
};

describe("bounded ZIP extraction", () => {
  test("rejects oversized compressed uploads before decoding", () => {
    expect(() => assertArchiveUploadSize(512 * 1024 * 1024 + 1)).toThrow(
      "512 MiB upload limit",
    );
  });

  test("rejects a compressed entry whose declared output is too large", () => {
    const zip = zipSync({ "large.ld": new Uint8Array(33) });

    expect(() => unzipBounded(zip, limits)).toThrow(
      "exceeds the uncompressed size limit",
    );
  });

  test("rejects gzip output beyond the capture limit", () => {
    const gzip = gzipSync(Buffer.alloc(33));

    expect(() => decompressIfGzipSync(gzip, 32)).toThrow();
  });

  test("rejects aggregate output and entry-count bombs", () => {
    const aggregate = zipSync({
      "one.ld": new Uint8Array(25),
      "two.ldx": new Uint8Array(25),
    });
    expect(() => unzipBounded(aggregate, limits)).toThrow(
      "total uncompressed size limit",
    );

    const tooMany = zipSync({
      one: new Uint8Array(1),
      two: new Uint8Array(1),
      three: new Uint8Array(1),
    });
    expect(() => unzipBounded(tooMany, limits)).toThrow("2-entry limit");
  });

  test("extracts archives inside every bound", () => {
    const zip = zipSync({
      "session.ld": new Uint8Array([1, 2, 3]),
      "session.ldx": new Uint8Array([4, 5]),
    });

    expect(Object.keys(unzipBounded(zip, limits))).toEqual([
      "session.ld",
      "session.ldx",
    ]);
  });
});
