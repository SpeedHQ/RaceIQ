import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseCarSetup } from "../server/games/ac-evo/carsetup";

/**
 * `POST /api/tunes/place-setup` accepts a binary AC EVO `.carsetup` as base64
 * alongside the original JSON path.
 *
 * The one thing that actually matters here is BYTE FIDELITY. `.carsetup` is
 * protobuf wire format with no shipped schema, and `carsetup-writer.ts` patches
 * a setup by splicing bytes at offsets recorded during decode. Re-serialising a
 * file — even "losslessly" — would move those offsets and silently corrupt
 * every later write. So the placed file must be byte-identical to the dropped
 * one, which is why the route writes the Buffer verbatim instead of going
 * through JSON.stringify.
 *
 * These assertions cover the encode/decode contract the route depends on rather
 * than booting an HTTP server: the route's own logic is a base64 decode, a
 * `parseCarSetup` validity gate, and a verbatim write.
 */

const FIXTURE = resolve(import.meta.dir, "artifacts/carsetup/Default-12312.carsetup");

describe("place-setup: binary .carsetup round-trip", () => {
  test("base64 encode → decode is byte-identical", () => {
    const original = readFileSync(FIXTURE);

    // Exactly what the client does: bytes → base64 over the wire.
    const base64 = original.toString("base64");
    // Exactly what the route does: base64 → Buffer, written verbatim.
    const decoded = Buffer.from(base64, "base64");

    expect(decoded.length).toBe(original.length);
    expect(decoded.equals(original)).toBe(true);
  });

  test("a round-tripped file still decodes as a setup", () => {
    const original = readFileSync(FIXTURE);
    const decoded = Buffer.from(original.toString("base64"), "base64");

    const before = parseCarSetup(original);
    const after = parseCarSetup(decoded);

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    // Byte offsets are what carsetup-writer.ts patches against, so the whole
    // decoded tree — spans included — must be identical, not merely equivalent.
    expect(after).toEqual(before!);
  });

  test("JSON.stringify round-trip does NOT survive — why the binary path exists", () => {
    const original = readFileSync(FIXTURE);
    // The pre-existing JSON path would have written the file like this. It is
    // not a valid setup afterwards, which is the bug this change avoids.
    const viaJson = Buffer.from(JSON.stringify(original.toString("utf-8")), "utf-8");
    expect(viaJson.equals(original)).toBe(false);
  });

  test("the validity gate rejects a file that is not a setup", () => {
    // The route refuses to write junk into the driver's game folder.
    expect(parseCarSetup(Buffer.from("this is not a carsetup", "utf-8"))).toBeNull();

    // ⚠️ An empty buffer does NOT come back null — it decodes to an empty wire
    // tree. A `!parseCarSetup(bytes)` check alone would therefore accept it, so
    // the route additionally requires at least one decoded field. Pinned here
    // because the null-only guard looks correct and is not.
    const empty = parseCarSetup(Buffer.alloc(0));
    expect(empty).not.toBeNull();
    expect(empty!.raw.length).toBe(0);

    // A real setup is what passing the gate looks like.
    expect(parseCarSetup(readFileSync(FIXTURE))!.raw.length).toBeGreaterThan(0);
  });
});
