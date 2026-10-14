import { expect, test } from "bun:test";
import { uploadPayloadFingerprint } from "../src/payload";

test("payload identity distinguishes recording/setup boundaries and absent attachments", () => {
  const recording = new Uint8Array([1, 2, 3]);
  const setup = new Uint8Array([4, 5]);
  expect(uploadPayloadFingerprint(recording, setup)).not.toBe(
    uploadPayloadFingerprint(new Uint8Array([1, 2, 3, 4, 5]), null),
  );
  expect(uploadPayloadFingerprint(recording, null)).not.toBe(
    uploadPayloadFingerprint(recording, new Uint8Array()),
  );
});

test("payload identity hashes only submitted view bytes and tracks content changes", () => {
  const storage = new Uint8Array([99, 1, 2, 3, 88]);
  const submitted = storage.subarray(1, 4);
  const fingerprint = uploadPayloadFingerprint(submitted, null);
  expect(fingerprint).toBe(uploadPayloadFingerprint(new Uint8Array([1, 2, 3]), null));
  storage[0] = 77;
  expect(uploadPayloadFingerprint(submitted, null)).toBe(fingerprint);
  submitted[1] = 9;
  expect(uploadPayloadFingerprint(submitted, null)).not.toBe(fingerprint);
});
