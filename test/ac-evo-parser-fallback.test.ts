import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../server/games/ac-evo/parser";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO } from "../server/games/ac-evo/structs";

function emptyBuffers() {
  return {
    physics: Buffer.alloc(PHYSICS.SIZE),
    graphics: Buffer.alloc(GRAPHICS_EVO.SIZE),
    staticData: Buffer.alloc(STATIC_EVO.SIZE),
  };
}

function writeCString(buf: Buffer, offset: number, size: number, value: string) {
  buf.fill(0, offset, offset + size);
  buf.write(value, offset, Math.min(value.length, size - 1), "utf8");
}

describe("AC Evo parser — malformed/empty STATIC recovery", () => {
  test("zero-filled STATIC does not throw, parser returns a packet with carOrdinal=0", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    const cache = createAcEvoParserCache();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);

    expect(packet).not.toBeNull();
    expect(packet!.gameId).toBe("ac-evo");
    expect(cache.carOrdinal).toBe(0);
    expect(cache.trackOrdinal).toBe(0);
  });

  test("unknown car display name resolves to carOrdinal=0 without throwing", () => {
    const { physics, graphics, staticData } = emptyBuffers();
    writeCString(graphics, GRAPHICS_EVO.car_model.offset, GRAPHICS_EVO.car_model.size, "__Not A Real Car__");
    const cache = createAcEvoParserCache();

    const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);

    expect(packet).not.toBeNull();
    expect(cache.carOrdinal).toBe(0);
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
});
