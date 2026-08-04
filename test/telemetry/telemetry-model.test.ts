import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../shared/games/init";
import { getGame } from "../../shared/games/registry";
import {
  getFuelDisplay,
  getTireTemperatureSourceUnit,
} from "../../shared/games/telemetry";
import type { TelemetryModel } from "../../shared/games/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";

initGameAdapters();

type ScalarMetric = "boost" | "power" | "torque";
type SourceChannel = "clutch" | "handBrake" | "weather" | "pitStatus";

const adapterCases: Array<{
  gameId: GameId;
  fuel: TelemetryModel["fuel"]["packetUnit"];
  tireTemperature: TelemetryModel["tireTemperature"]["packetUnit"];
  scalarMetrics: ScalarMetric[];
  brakeTemperature: boolean;
  tirePressure: boolean;
  ers: boolean;
  sourceChannels: SourceChannel[];
}> = [
  {
    gameId: "fm-2023",
    fuel: "fraction",
    tireTemperature: "fahrenheit",
    scalarMetrics: ["boost", "power", "torque"],
    brakeTemperature: false,
    tirePressure: false,
    ers: false,
    sourceChannels: ["clutch", "handBrake"],
  },
  {
    gameId: "f1-2025",
    fuel: "fraction",
    tireTemperature: "celsius",
    scalarMetrics: ["power"],
    brakeTemperature: true,
    tirePressure: true,
    ers: true,
    sourceChannels: ["clutch", "weather"],
  },
  {
    gameId: "acc",
    fuel: "litre",
    tireTemperature: "celsius",
    scalarMetrics: [],
    brakeTemperature: true,
    tirePressure: true,
    ers: false,
    sourceChannels: ["pitStatus"],
  },
  {
    gameId: "ac-evo",
    fuel: "litre",
    tireTemperature: "celsius",
    scalarMetrics: [],
    brakeTemperature: true,
    tirePressure: true,
    ers: false,
    sourceChannels: ["weather", "pitStatus"],
  },
  {
    gameId: "iracing",
    fuel: "litre",
    tireTemperature: "celsius",
    scalarMetrics: [],
    brakeTemperature: false,
    tirePressure: true,
    ers: false,
    sourceChannels: ["clutch", "pitStatus"],
  },
];

describe("game telemetry models", () => {
  for (const expected of adapterCases) {
    test(`${expected.gameId} declares its accepted packet variants`, () => {
      const model = getGame(expected.gameId).telemetry;

      expect(model.fuel.packetUnit).toBe(expected.fuel);
      expect(model.tireTemperature.packetUnit).toBe(
        expected.tireTemperature,
      );
      expect(model.brakeTemperature !== undefined).toBe(
        expected.brakeTemperature,
      );
      expect(model.tirePressure !== undefined).toBe(
        expected.tirePressure,
      );
      expect(model.ers === true).toBe(expected.ers);

      const supportedScalars = (
        ["boost", "power", "torque"] as const
      ).filter((metric) => model[metric] !== undefined);
      expect(supportedScalars).toEqual(expected.scalarMetrics);
      const supportedSourceChannels = (
        ["clutch", "handBrake", "weather", "pitStatus"] as const
      ).filter((channel) => model[channel] !== undefined);
      expect(supportedSourceChannels).toEqual(expected.sourceChannels);
    });

    test(`${expected.gameId} capability presence is independent of a zero value`, () => {
      const model = getGame(expected.gameId).telemetry;
      const packet = {
        gameId: expected.gameId,
        Boost: 0,
        Power: 0,
        Torque: 0,
      } as TelemetryPacket;
      const values = {
        boost: packet.Boost,
        power: packet.Power,
        torque: packet.Torque,
      };

      const visibleZeroMetrics = (
        ["boost", "power", "torque"] as const
      ).filter(
        (metric) => model[metric] !== undefined && values[metric] === 0,
      );
      expect(visibleZeroMetrics).toEqual(expected.scalarMetrics);
    });
  }
  test("weather freshness distinguishes real zeroes from normalized placeholders", () => {
    expect(getGame("f1-2025").telemetry.weather).toEqual({
      source: "direct",
      freshness: "continuous",
    });
    expect(getGame("ac-evo").telemetry.weather).toEqual({
      source: "direct",
      freshness: "static",
    });
    expect(getGame("acc").telemetry.weather).toBeUndefined();
    expect(getGame("iracing").telemetry.weather).toBeUndefined();
  });
});

describe("telemetry interpretation helpers", () => {
  test("fraction fuel resolves to percentage and includes a fill ratio at zero", () => {
    const display = getFuelDisplay(
      { Fuel: 0, FuelCapacity: undefined },
      getGame("fm-2023").telemetry.fuel,
    );

    expect(display).toEqual({ amount: 0, unit: "%", fillRatio: 0 });
  });

  test("litre fuel uses a real capacity when available", () => {
    const display = getFuelDisplay(
      { Fuel: 40, FuelCapacity: 100 },
      getGame("acc").telemetry.fuel,
    );

    expect(display).toEqual({ amount: 40, unit: "L", fillRatio: 0.4 });
  });

  test("litre fuel does not invent a fill ratio without capacity", () => {
    const display = getFuelDisplay(
      { Fuel: 40, FuelCapacity: undefined },
      getGame("iracing").telemetry.fuel,
    );

    expect(display).toEqual({ amount: 40, unit: "L" });
  });

  test("temperature source units come from the adapter model", () => {
    expect(
      getTireTemperatureSourceUnit(
        getGame("fm-2023").telemetry.tireTemperature,
      ),
    ).toBe("F");
    expect(
      getTireTemperatureSourceUnit(
        getGame("f1-2025").telemetry.tireTemperature,
      ),
    ).toBe("C");
  });
});
