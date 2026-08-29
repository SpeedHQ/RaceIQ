import { expect, test } from "bun:test";
import { formatMotecLapTime } from "../src/components/analyse/MotecImportModal";

test("formats imported lap times as seconds", () => {
  expect(formatMotecLapTime(143.637)).toBe("2:23.637");
  expect(formatMotecLapTime(138.146)).toBe("2:18.146");
});
