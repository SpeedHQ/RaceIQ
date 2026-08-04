export interface TrackSpacePoint {
  x: number;
  y: number;
  z: number;
}

/** Parse TrackSpaceSpline BXML tokens into main and pit centerlines. */
export function parseTrackSpaceSpline(data: Buffer): { maintrack: TrackSpacePoint[]; pit: TrackSpacePoint[] } {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0 || (data[i] < 0x20 && data[i] !== 0x09 && data[i] !== 0x0a && data[i] !== 0x0d)) {
      if (i > start) {
        const value = data.subarray(start, i).toString("utf-8");
        if (value.length > 0 && value.charCodeAt(0) >= 0x20) parts.push(value);
      }
      start = i + 1;
    }
  }

  const splines: Record<string, TrackSpacePoint[]> = {};
  let currentSpline: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "name" && i + 1 < parts.length) {
      currentSpline = parts[i + 1];
      splines[currentSpline] ??= [];
      i++;
    } else if (parts[i] === "position" && currentSpline) {
      const values = parts[i + 1];
      if (values?.includes(",")) {
        const [x, y, z] = values.split(",").map((value) => parseFloat(value.trim()));
        if (!isNaN(x) && !isNaN(z)) splines[currentSpline].push({ x, y, z });
        i++;
      }
    }
  }

  return {
    maintrack: splines.maintrack ?? [],
    pit: splines.pit_1 ?? [],
  };
}
