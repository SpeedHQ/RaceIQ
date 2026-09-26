import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../../../server/games/ac-evo/parser";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO, ACEVO_STATUS } from "../../../server/games/ac-evo/structs";
import { LapDetectorAcEvo } from "../../../server/games/ac-evo/lap-detector";
import { CapturingDbAdapter } from "../../../server/telemetry/pipeline-ports";

function emptyBuffers() {
  const graphics = Buffer.alloc(GRAPHICS_EVO.SIZE);
  // Default status (0) is AC_OFF — parser gates out. Force AC_LIVE so the
  // parser runs through the full body and exercises the STATIC fallback paths.
  graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
  return {
    physics: Buffer.alloc(PHYSICS.SIZE),
    graphics,
    staticData: Buffer.alloc(STATIC_EVO.SIZE),
  };
}

function writeCString(buf: Buffer, offset: number, size: number, value: string) {
  buf.fill(0, offset, offset + size);
  buf.write(value, offset, Math.min(value.length, size - 1), "utf8");
}

describe("AC Evo parser — malformed/empty STATIC recovery", () => {
  test("preserves exact native car and reversible track/configuration through blank pages", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();
    const blank = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(blank.CarId).toBe("");
    expect(blank.TrackId).toBe("");

    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "Porsche 992 GT3 R Rennsport");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "Monza");
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "GP");
    const first = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(first.CarId).toBe("Porsche 992 GT3 R Rennsport");
    expect(first.TrackId).toBe(JSON.stringify(["Monza", "GP"]));
    expect(first.CarOrdinal).toBe(-1);
    expect(first.TrackOrdinal).toBe(-1);

    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "Junior");
    const second = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(second.TrackId).toBe(JSON.stringify(["Monza", "Junior"]));
    expect(second.TrackId).not.toBe(first.TrackId);

    graphics.fill(0, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.offset + GRAPHICS_EVO.car_model.size);
    staticData.fill(0, STATIC_EVO.track.offset, STATIC_EVO.track.offset + STATIC_EVO.track.size);
    staticData.fill(0, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.offset + STATIC_EVO.track_configuration.size);
    const afterBlank = parseAcEvoBuffers(physics, graphics, staticData, cache)!;
    expect(afterBlank.CarId).toBe(first.CarId);
    expect(afterBlank.TrackId).toBe(second.TrackId);
  });

  test("configuration arriving before track survives until complete native pair", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "Grand Prix");
    expect(parseAcEvoBuffers(physics, graphics, staticData, cache)!.TrackId).toBe("");
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "Silverstone");
    expect(parseAcEvoBuffers(physics, graphics, staticData, cache)!.TrackId).toBe(JSON.stringify(["Silverstone", "Grand Prix"]));
  });

  test("unknown native strings remain exact rather than resolving catalog ordinals", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "__Not A Real Car__");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "__not_a_real_track__");
    const packet = parseAcEvoBuffers(physics, graphics, staticData, createAcEvoParserCache())!;
    expect(packet.CarId).toBe("__Not A Real Car__");
    expect(packet.TrackId).toBe(JSON.stringify(["__not_a_real_track__", ""]));
  });
  test("new and changed native IDs persist on same session without discovered-car allocation", async () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();
    const db = new CapturingDbAdapter();
    const detector = new LapDetectorAcEvo({ db });
    await detector.feed(parseAcEvoBuffers(physics, graphics, staticData, cache)!);
    expect(db.sessions[0]).toMatchObject({ carId: "", trackId: "" });

    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "Porsche 992 GT3 R Rennsport");
    writeCString(staticData, STATIC_EVO.track.offset, STATIC_EVO.track.size, "Monza");
    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "GP");
    await detector.feed(parseAcEvoBuffers(physics, graphics, staticData, cache)!);
    expect(db.sessions[0]).toMatchObject({
      carId: "Porsche 992 GT3 R Rennsport",
      trackId: JSON.stringify(["Monza", "GP"]),
    });

    writeCString(staticData, STATIC_EVO.track_configuration.offset, STATIC_EVO.track_configuration.size, "Junior");
    await detector.feed(parseAcEvoBuffers(physics, graphics, staticData, cache)!);
    expect(db.sessions[0]!.trackId).toBe(JSON.stringify(["Monza", "Junior"]));
    expect(db.sessions).toHaveLength(1);
    await detector.finalizeCurrentSession();
  });

  test("undersized buffers return null (no throw)", () => {
    const cache = createAcEvoParserCache();
    const packet = parseAcEvoBuffers(
      Buffer.alloc(PHYSICS.SIZE - 1),
      Buffer.alloc(GRAPHICS_EVO.SIZE),
      Buffer.alloc(STATIC_EVO.SIZE),
      cache,
    );
    expect(packet).toBeNull();
  });

  test("maps source-provided fuel capacity in litres", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    physics.writeFloatLE(42, PHYSICS.fuel.offset);
    graphics.writeFloatLE(100, GRAPHICS_EVO.max_fuel.offset);

    const packet = parseAcEvoBuffers(
      physics,
      graphics,
      staticData,
      createAcEvoParserCache(),
    );

    expect(packet).not.toBeNull();
    expect(packet!.Fuel).toBeCloseTo(42);
    expect(packet!.FuelCapacity).toBeCloseTo(100);
  });
});
