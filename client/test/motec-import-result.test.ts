import { expect, test } from "bun:test";
import { formatMotecLapTime, formatMotecMissingChannels } from "../src/components/analyse/MotecImportModal";

test("formats imported lap times as seconds", () => {
  expect(formatMotecLapTime(143.637)).toBe("2:23.637");
  expect(formatMotecLapTime(138.146)).toBe("2:18.146");
});

test("formats exact missing MoTeC channels for finished import notes", () => {
  expect(formatMotecMissingChannels(["ROTY", "CLUTCH"])).toBe("ROTY, CLUTCH");
  expect(formatMotecMissingChannels([])).toBe("none");
});
