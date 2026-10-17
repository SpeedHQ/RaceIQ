import { describe, expect, test } from "bun:test";
import { wheelLabelRows, type WheelLabelConfig } from "../src/components/wireframe/WheelLabels";
import { readSceneWheelValue, sceneTemperatureReadings } from "../src/components/wireframe/SceneOverlays";
const config = (overrides: Partial<WheelLabelConfig> = {}): WheelLabelConfig => ({
  temperatureReadings: [], carcassBands: [null, null, null], fmtTemp: (value) => `${value}°`,
  temperatureThresholds: { cold: 60, warm: 85, hot: 100 }, wear: null, wearRate: 0,
  brakeTemp: 0, pressurePsi: null, coldPressure: false, side: "left", isRear: false,
  ...overrides,
});

describe("wireframe wheel telemetry details", () => {
  test("shows supported wear and cold setup pressure without requiring temperatures", () => {
    const rows = wheelLabelRows(config({ wear: 0.2, pressurePsi: 25.4, coldPressure: true }));
    expect(rows[0]?.values[0]?.text).toBe("80%");
    expect(rows.some((row) => row.values[0]?.text === "25.4 psi")).toBe(true);
    expect(rows.some((row) => row.kind === "profile")).toBe(false);
  });

  test("keeps missing or invalid pit wear unavailable instead of displaying full health", () => {
    expect(wheelLabelRows(config())[0]?.values[0]?.text).toBe("—");
    expect(wheelLabelRows(config({ wear: Number.NaN }))[0]?.values[0]?.text).toBe("—");
  });

  test("does not fabricate pressure when channel absent and keeps live pressure distinct", () => {
    const rows = wheelLabelRows(config({ pressurePsi: 28, coldPressure: false }));
    expect(rows.some((row) => row.values[0]?.text === "28.0 psi")).toBe(true);
    expect(wheelLabelRows(config()).some((row) => row.values.some(({ text }) => text.includes("psi")))).toBe(false);
  });
  test("invalid temperature readings stay unavailable in rendered label data", () => {
    const rows = wheelLabelRows(config({
      temperatureReadings: [{ kind: "surface", value: Number.NaN }],
      carcassBands: [Number.POSITIVE_INFINITY, null, null],
    }));
    expect(rows.find((row) => row.kind === "profile")?.values[0]?.text).toBe("—");
    expect(rows.filter((row) => row.kind === "profile").flatMap((row) => row.values.map(({ text }) => text))).toEqual(["—"]);
  });


  test("non-finite wear rates never render", () => {
    expect(wheelLabelRows(config({ wearRate: Number.NaN })).some((row) => row.values.some(({ text }) => text.includes("%/s")))).toBe(false);
  });

  test("rejects unsupported and stale evidence before producing label values", () => {
    const id = "tires.tire-wear";
    const values = { [id]: [0, 0.2, NaN, 0.4] };
    expect(readSceneWheelValue({ values, states: {}, freshness: {} }, id, 1)).toBe(0.2);
    expect(readSceneWheelValue({ values, states: { [id]: "not-applicable" }, freshness: {} }, id, 0)).toBeNull();
    expect(readSceneWheelValue({ values, states: { [id]: "ok" }, freshness: { [id]: "stale" } }, id, 0)).toBeNull();
    expect(readSceneWheelValue({ values, states: {}, freshness: {} }, id, 2)).toBeNull();
  });

  test("valid carcass middle survives an unavailable representative channel", () => {
    const primary = "tire.temperature.carcass.middle";
    const frame = { values: { [primary]: [91, 92, 93, 94] }, states: { [primary]: "ok", "tire.temperature.carcass.representative": "missing" }, freshness: { [primary]: "fresh", "tire.temperature.carcass.representative": "stale" } };
    expect(sceneTemperatureReadings(frame, 0, "left", primary, "pit-snapshot")).toEqual([{ kind: "carcass", value: 91 }]);
    expect(sceneTemperatureReadings({ ...frame, states: { [primary]: "missing" } }, 0, "left", primary, "pit-snapshot")).toEqual([{ kind: "carcass", value: null }]);
  });

  test("retains aged pit observations and cold setup pressure only as historical values", () => {
    const ids = ["tire.temperature.carcass.middle", "tires.tire-wear", "tires.tire-pressure"];
    const values = { [ids[0]]: [42, 43, 44, 45], [ids[1]]: [0.1, 0.2, 0.3, 0.4], [ids[2]]: [28, 28, 28, 28] };
    const frame = { values, states: Object.fromEntries(ids.map((id) => [id, "stale"])), freshness: Object.fromEntries(ids.map((id) => [id, "stale"])) };
    expect(readSceneWheelValue(frame, ids[0], 0)).toBeNull();
    const temperature = readSceneWheelValue(frame, ids[0], 0, "pit-snapshot");
    const wear = readSceneWheelValue(frame, ids[1], 0, "pit-snapshot");
    const pressure = readSceneWheelValue(frame, ids[2], 0, "static");
    const rows = wheelLabelRows(config({ carcassBands: [null, temperature, null], wear, pressurePsi: pressure, coldPressure: true, pitTemperature: true, pitHealth: true, historicalSnapshot: true }));
    expect(rows[0]?.values[0]?.text).toBe("90%");
    expect(rows.some((row) => row.values.some(({ text }) => text === "42°"))).toBe(true);
    expect(rows.some((row) => row.values.some(({ text }) => text === "28.0 psi"))).toBe(true);
    expect(rows.some((row) => row.kind === "note")).toBe(true);
    expect(readSceneWheelValue({ ...frame, states: { [ids[0]]: "invalid" } }, ids[0], 0, "pit-snapshot")).toBeNull();
    expect(readSceneWheelValue({ ...frame, values: {} }, ids[2], 0, "static")).toBeNull();
  });
});
