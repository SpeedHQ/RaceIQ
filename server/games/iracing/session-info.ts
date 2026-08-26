import type { IRacingSessionSnapshot } from "./source-frame";

export interface IRacingDriverSnapshot {
  carIndex: number;
  userId?: number;
  displayName?: string;
  carClassId?: number;
  carClassShortName?: string;
  isSpectator?: boolean;
  carIsPaceCar?: boolean;
}

const optionalNumber = (value: string | undefined): number | undefined => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const optionalBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  return undefined;
};
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return trimmed.slice(1, -1).replace(/\\"/g, `"`).replace(/''/g, `'`);
    }
  }
  return trimmed;
}

function findScalar(lines: readonly string[], key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match && match[1] !== "") return unquote(match[1]);
  }
  return undefined;
}

function toNumber(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseIRacingFuelCapacity(
  yaml: string,
): number | undefined {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const capacity = toNumber(
    findScalar(lines, "DriverCarFuelMaxLtr"),
    Number.NaN,
  );
  return Number.isFinite(capacity) && capacity > 0 ? capacity : undefined;
}

function parseTrackLengthM(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*(km|m|mi|ft)?/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  switch ((match[2] ?? "m").toLowerCase()) {
    case "km":
      return amount * 1000;
    case "mi":
      return amount * 1609.344;
    case "ft":
      return amount * 0.3048;
    default:
      return amount;
  }
}

function parseSectorStarts(lines: readonly string[]): number[] | undefined {
  let inSplitTimeInfo = false;
  let sectionIndent = -1;
  const starts: number[] = [];

  for (const line of lines) {
    if (!inSplitTimeInfo) {
      const match = line.match(/^(\s*)SplitTimeInfo:\s*$/);
      if (match) {
        inSplitTimeInfo = true;
        sectionIndent = match[1].length;
      }
      continue;
    }

    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= sectionIndent) break;

    const match = line.match(/^\s*SectorStartPct:\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0 && value < 1) starts.push(value);
  }

  const unique = [...new Set(starts)].sort((a, b) => a - b);
  return unique.length >= 2 ? unique : undefined;
}

function parseDrivers(lines: readonly string[]): Array<Record<string, string>> {
  const drivers: Array<Record<string, string>> = [];
  let inDrivers = false;
  let driversIndent = -1;
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    if (!inDrivers) {
      const match = line.match(/^(\s*)Drivers:\s*$/);
      if (match) {
        inDrivers = true;
        driversIndent = match[1].length;
      }
      continue;
    }

    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    const listMatch = line.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    // iRacing's emitter uses YAML's indentationless sequence form, so the
    // "- CarIdx" row may align with the "Drivers:" key itself.
    if (listMatch && indent >= driversIndent) {
      current = {};
      drivers.push(current);
      current[listMatch[1]] = unquote(listMatch[2]);
      continue;
    }

    if (indent <= driversIndent) break;

    const fieldMatch = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (current && fieldMatch) {
      current[fieldMatch[1]] = unquote(fieldMatch[2]);
    }
  }

  return drivers;
}
export function parseIRacingDrivers(yaml: string): IRacingDriverSnapshot[] {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  return parseDrivers(lines)
    .map((entry): IRacingDriverSnapshot | null => {
      const carIndex = optionalNumber(entry.CarIdx);
      if (carIndex === undefined || !Number.isInteger(carIndex) || carIndex < 0) return null;
      return {
        carIndex,
        userId: optionalNumber(entry.UserID),
        displayName: entry.UserName ?? entry.AbbrevName ?? entry.Initials,
        carClassId: optionalNumber(entry.CarClassID),
        carClassShortName: entry.CarClassShortName,
        isSpectator: optionalBoolean(entry.IsSpectator),
        carIsPaceCar: optionalBoolean(entry.CarIsPaceCar),
      };
    })
    .filter((entry): entry is IRacingDriverSnapshot => entry !== null);
}
export function parseIRacingSessionType(yaml: string, sessionNum: number): string {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  let matching = false;
  for (const line of lines) {
    const session = line.match(/^\s*-\s*SessionNum:\s*(-?\d+)/);
    if (session) {
      matching = Number(session[1]) === sessionNum;
      continue;
    }
    if (matching) {
      const type = line.match(/^\s*SessionType:\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/);
      if (type) return (type[1] ?? type[2] ?? type[3] ?? "unknown").trim().toLowerCase().replace(/\s+/g, "_");
    }
  }
  return "unknown";
}

export function parseIRacingSessionInfo(
  yaml: string,
  sessionNumOverride?: number,
): IRacingSessionSnapshot {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const driverCarIdx = toNumber(findScalar(lines, "DriverCarIdx"), -1);
  const driver = parseDrivers(lines).find(
    (entry) => toNumber(entry.CarIdx, -2) === driverCarIdx,
  );

  const trackName =
    findScalar(lines, "TrackDisplayName") ??
    findScalar(lines, "TrackDisplayShortName") ??
    findScalar(lines, "TrackName") ??
    "Unknown iRacing track";

  return {
    sessionId: toNumber(findScalar(lines, "SessionID"), 0),
    subSessionId: toNumber(findScalar(lines, "SubSessionID"), 0),
    sessionNum: sessionNumOverride ?? 0,
    driverCarIdx,
    trackId: toNumber(findScalar(lines, "TrackID"), -1),
    trackName,
    trackLengthM: parseTrackLengthM(findScalar(lines, "TrackLength")),
    sectorStarts: parseSectorStarts(lines),
    carId: toNumber(driver?.CarID, -1),
    carName:
      driver?.CarScreenName ??
      driver?.CarScreenNameShort ??
      driver?.CarPath ??
      "Unknown iRacing car",
    carClassId: toNumber(driver?.CarClassID, -1),
    carClassName: driver?.CarClassShortName ?? driver?.CarClassRelSpeed ?? "Unknown class",
    engineIdleRpm: toNumber(findScalar(lines, "DriverCarIdleRPM"), 0),
    engineRedlineRpm: toNumber(findScalar(lines, "DriverCarRedLine"), 0),
    engineCylinderCount: toNumber(findScalar(lines, "DriverCarEngCylinderCount"), 0),
  };
}
