import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "../../shared/games/init";
import { FuelGauge, PowerTorque } from "../src/components/telemetry/Gauges";
import { PitEstimate } from "../src/components/telemetry/PitEstimate";
import { fakeAccPacket, fakeF1Packet, fakeForzaPacket, fakePit } from "../src/stories/fakeData";

initGameAdapters();

describe("telemetry capability UI", () => {
  test("renders supported power and torque even when their values are zero", () => {
    const forzaMarkup = renderToStaticMarkup(
      createElement(PowerTorque, {
        packet: { ...fakeForzaPacket, Power: 0, Torque: 0 },
      }),
    );
    const f1Markup = renderToStaticMarkup(
      createElement(PowerTorque, {
        packet: { ...fakeF1Packet, Power: 0, Torque: 0 },
      }),
    );
    const accMarkup = renderToStaticMarkup(
      createElement(PowerTorque, {
        packet: { ...fakeAccPacket, Power: 0, Torque: 0 },
      }),
    );

    expect(forzaMarkup).toContain("Power");
    expect(forzaMarkup).toContain("Torque");
    expect(f1Markup).toContain("Power");
    expect(f1Markup).not.toContain("Torque");
    expect(accMarkup).toBe("");
  });

  test("shows litre fuel without inventing a percentage when capacity is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(FuelGauge, {
        packet: {
          ...fakeAccPacket,
          gameId: "iracing",
          Fuel: 40,
          FuelCapacity: undefined,
        },
      }),
    );

    expect(markup).toContain("Fuel 40.0L");
    expect(markup).toContain("Fuel capacity unavailable");
    expect(markup).not.toContain("width:40%");
  });

  test("uses a source-provided litre capacity for the fuel fill bar", () => {
    const markup = renderToStaticMarkup(
      createElement(FuelGauge, {
        packet: {
          ...fakeAccPacket,
          Fuel: 40,
          FuelCapacity: 100,
        },
      }),
    );

    expect(markup).toContain("Fuel 40.0L");
    expect(markup).toContain("width:40%");
  });

  test("renders the ACC live dashboard fuel fill from fixture capacity", () => {
    const markup = renderToStaticMarkup(
      createElement(PitEstimate, {
        packet: fakeAccPacket,
        pit: fakePit,
      }),
    );

    expect(fakeAccPacket.FuelCapacity).toBe(120);
    expect(markup).not.toContain("Fuel capacity unavailable");
    expect(markup).toContain(`width:${(fakeAccPacket.Fuel / fakeAccPacket.FuelCapacity) * 100}%`);
  });

  test("keeps F1 dashboard fixture fuel normalized to a tank fraction", () => {
    const markup = renderToStaticMarkup(
      createElement(PitEstimate, {
        packet: fakeF1Packet,
        pit: fakePit,
      }),
    );

    expect(fakeF1Packet.Fuel).toBeGreaterThan(0);
    expect(fakeF1Packet.Fuel).toBeLessThanOrEqual(1);
    expect(markup).toContain("39%");
    expect(markup).not.toContain("4250%");
  });
});
