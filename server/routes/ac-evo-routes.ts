import { Hono } from "hono";
import { getAllAcEvoCars, getAcEvoCarClass } from "../../shared/ac-evo-car-data";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO } from "../games/ac-evo/structs";
import { readCString } from "../games/ac-evo/utils";

interface FieldDef {
  offset: number;
  type: string;
  size?: number;
}

function readField(buf: Buffer, def: FieldDef): number | string {
  const { offset, type, size } = def;
  const bufLen = buf.length;
  // Out-of-bounds guard
  if (type === "cstring" || type === "wstring") {
    if (offset + (size ?? 0) > bufLen) return "";
  } else if (type === "u64") {
    if (offset + 8 > bufLen) return -999;
  } else if (type === "u16" || type === "i16") {
    if (offset + 2 > bufLen) return -999;
  } else if (type === "u8" || type === "i8" || type === "bool") {
    if (offset + 1 > bufLen) return -999;
  } else if (type === "struct") {
    return offset; // just return the offset as a hint — sub-struct readers handle internals
  } else {
    if (offset + 4 > bufLen) return -999;
  }
  switch (type) {
    case "f32": return buf.readFloatLE(offset);
    case "i32": return buf.readInt32LE(offset);
    case "u32": return buf.readUInt32LE(offset);
    case "i16": return buf.readInt16LE(offset);
    case "u16": return buf.readUInt16LE(offset);
    case "i8": return buf.readInt8(offset);
    case "u8": return buf.readUInt8(offset);
    case "bool": return buf.readUInt8(offset) ? 1 : 0;
    case "u64": return Number(buf.readBigUInt64LE(offset));
    case "cstring": return readCString(buf, offset, size ?? 0);
    case "wstring": return buf.slice(offset, offset + (size ?? 0)).toString("utf16le").replace(/\x00+.*$/, "");
    default: return -999;
  }
}

export const acEvoRoutes = new Hono()

  .get("/api/ac-evo/cars", (c) => {
    const cars = getAllAcEvoCars().map((car) => ({ ...car }));
    cars.sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name));
    return c.json(cars);
  })

  .get("/api/ac-evo/cars/:ordinal/class", (c) => {
    const ord = Number(c.req.param("ordinal"));
    if (!Number.isFinite(ord)) return c.json({ class: null });
    return c.json({ class: getAcEvoCarClass(ord) ?? null });
  })

  /** Parsed field values from each shared memory page using v0.6 struct offsets. */
  .get("/api/ac-evo/debug/raw", (c) => {
    const { acEvoReader } = require("../index") as typeof import("../index");
    const bufs = acEvoReader.getDebugBuffers?.();
    if (!bufs) {
      return c.json({ error: "AC Evo not connected or getDebugBuffers not available" }, 503);
    }
    const { physics, graphics, staticData } = bufs;

    const p: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(PHYSICS)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      p[key] = readField(physics, def as FieldDef);
    }

    const g: Record<string, number | string> = {};
    for (const [key, def] of Object.entries(GRAPHICS_EVO)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      g[key] = readField(graphics, def as FieldDef);
    }

    const s: Record<string, number | string> = {};
    // Also try reading static as legacy wchar_t layout for compat diagnostics
    const sLegacy: Record<string, string> = {
      sm_version_wchar: staticData.slice(0, 30).toString("utf16le").replace(/\x00+.*$/, ""),
      ac_evo_version_wchar: staticData.slice(30, 60).toString("utf16le").replace(/\x00+.*$/, ""),
      carModel_wchar_at68: staticData.slice(68, 134).toString("utf16le").replace(/\x00+.*$/, ""),
      playerName_wchar_at200: staticData.slice(200, 266).toString("utf16le").replace(/\x00+.*$/, ""),
    };
    for (const [key, def] of Object.entries(STATIC_EVO)) {
      if (key === "SIZE" || typeof def !== "object") continue;
      s[key] = readField(staticData, def as FieldDef);
    }

    return c.json({
      sizes: { physics: physics.length, graphics: graphics.length, staticData: staticData.length },
      physics: p,
      graphics: g,
      static_v06: s,
      static_legacy_wchar: sLegacy,
    });
  })

  /**
   * Raw byte dumps (base64) of each page — lets the UI render a live hex view
   * with byte-change highlighting for diagnosing unknown struct layouts.
   */
  .get("/api/ac-evo/debug/hex", (c) => {
    const { acEvoReader } = require("../index") as typeof import("../index");
    const bufs = acEvoReader.getDebugBuffers?.();
    if (!bufs) {
      return c.json({ error: "AC Evo not connected" }, 503);
    }
    return c.json({
      physics: bufs.physics.toString("base64"),
      graphics: bufs.graphics.toString("base64"),
      staticData: bufs.staticData.toString("base64"),
      ts: Date.now(),
    });
  })

  /**
   * Side-by-side view: for every field in each struct, show offset + raw hex
   * bytes + our interpretation. Lets you visually confirm we're not masking 0s.
   */
  .get("/api/ac-evo/debug/verify", (c) => {
    const { acEvoReader } = require("../index") as typeof import("../index");
    const bufs = acEvoReader.getDebugBuffers?.();
    if (!bufs) return c.json({ error: "AC Evo not connected" }, 503);

    function byteLen(type: string, size?: number): number {
      switch (type) {
        case "f32": case "i32": case "u32": return 4;
        case "u16": case "i16": return 2;
        case "u8": case "i8": case "bool": return 1;
        case "u64": return 8;
        case "cstring": case "wstring": return size ?? 0;
        case "struct": return 0;
        default: return 4;
      }
    }

    function scan(buf: Buffer, defs: Record<string, unknown>): Array<{
      field: string; offset: number; type: string; hex: string; value: number | string;
    }> {
      const rows: Array<{ field: string; offset: number; type: string; hex: string; value: number | string }> = [];
      for (const [field, raw] of Object.entries(defs)) {
        if (field === "SIZE" || typeof raw !== "object") continue;
        const def = raw as { offset: number; type: string; size?: number };
        const n = byteLen(def.type, def.size);
        const slice = buf.slice(def.offset, def.offset + Math.min(n, 16));
        const hex = slice.toString("hex").replace(/(..)/g, "$1 ").trim();
        const value = readField(buf, def);
        rows.push({ field, offset: def.offset, type: def.type, hex, value });
      }
      return rows.sort((a, b) => a.offset - b.offset);
    }

    return c.json({
      physics: scan(bufs.physics, PHYSICS as unknown as Record<string, unknown>),
      graphics: scan(bufs.graphics, GRAPHICS_EVO as unknown as Record<string, unknown>),
      static: scan(bufs.staticData, STATIC_EVO as unknown as Record<string, unknown>),
    });
  });
