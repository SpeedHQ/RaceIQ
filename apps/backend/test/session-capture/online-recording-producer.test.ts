import { expect, test } from "bun:test";
import { createOnlineRecordingProducer } from "@raceiq/backend-core/session-capture/online-recording-producer";

test("Online producer refuses construction without the real historical binding resolver", () => {
  // Exercise JavaScript callers too: a missing resolver must fail before any source work.
  expect(() => Reflect.apply(createOnlineRecordingProducer, undefined, [])).toThrow("driver_identity_required");
  expect(() => Reflect.apply(createOnlineRecordingProducer, undefined, [{}])).toThrow("driver_identity_required");
});
