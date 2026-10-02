/**
 * MoTeC i2 `.ldx` sidecar reader.
 *
 * The `.ldx` is a small XML file holding marker blocks. Lap splits live in the
 * `Beacons` marker group as `<Marker Time="..."/>` elements, where Time is
 * **microseconds** from the start of the log.
 *
 * Note the beacon group is frequently empty — AC Evo's exporter writes an empty
 * `<MarkerGroup Name="Beacons"></MarkerGroup>` for a standalone hotlap, and
 * leaves the log's own `LAP_BEACON` channel zero-filled to match. A log with no
 * beacons is a single unsplit stint, not an error.
 */

const MARKER_RE = /<Marker\b[^>]*>/gi;
const TIME_ATTR_RE = /\bTime\s*=\s*"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)"/i;

/**
 * Extract beacon times, in **seconds** from log start, sorted ascending.
 * Returns an empty array for a missing, malformed, or beacon-less sidecar.
 */
export function parseLdxBeacons(xml: string): number[] {
  const times = new Set<number>();
  for (
    let marker = MARKER_RE.exec(xml);
    marker !== null;
    marker = MARKER_RE.exec(xml)
  ) {
    const match = TIME_ATTR_RE.exec(marker[0]);
    if (!match) continue;
    const micros = Number(match[1]);
    if (!Number.isFinite(micros) || micros < 0) continue;
    times.add(micros / 1_000_000);
  }
  return Array.from(times).sort((a, b) => a - b);
}
