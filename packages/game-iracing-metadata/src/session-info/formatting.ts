function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\bRpm\b/gi, "RPM")
    .replace(/\bId\b/g, "ID")
    .trim();
}

function unitFor(path: string): string {
  const field = path.split(".").at(-1) ?? path;
  const exactUnits: Record<string, string> = {
    TrackDirection: "text",
    NumCarClasses: "count",
    NumCarTypes: "count",
    DriverCarIdx: "index",
    PaceCarIdx: "index",
    DriverCarMaxFuelPct: "value-with-unit",
    DriverCarGearNeutral: "count",
    DriverCarGearNumForward: "count",
    DriverCarGearReverse: "count",
    DriverCarIsElectric: "boolean",
    CarClassRelSpeed: "value-with-unit",
    CarClassEstLapTime: "s",
    CarIsElectric: "boolean",
    ResultsLapsComplete: "count",
    ResultsOfficial: "boolean",
    ResultsNumCautionFlags: "count",
    ResultsNumCautionLaps: "count",
    ResultsNumLeadChanges: "count",
    Incidents: "count",
    JokerLapsComplete: "count",
    LapsComplete: "count",
    LapsDriven: "count",
    LapsLed: "count",
    SessionEnforceTireCompoundChange: "boolean",
    SessionNumLapsToAvg: "count",
    SessionRunGroupsUsed: "count",
    SessionSkipped: "boolean",
  };
  if (exactUnits[field]) return exactUnits[field];
  if (
    /^(TrackLength|TrackLengthOfficial|TrackAltitude|TrackPitSpeedLimit|TrackAirPressure|TrackAirTemp|TrackFogLevel|TrackPrecipitation|TrackRelativeHumidity|TrackSurfaceTemp|TrackWindDir|TrackWindVel|WeatherTemp|RelativeHumidity|FogLevel|WindDirection|WindSpeed|CarClassMaxFuelPct|CarClassWeightPenalty|CarClassPowerAdjust|CarClassDryTireSetLimit|SessionLaps|SessionTime|IncidentLimit|FastRepairsLimit)$/.test(
      field,
    )
  ) {
    return "value-with-unit";
  }
  if (/^(FastestTime|LastTime|Time|ResultsAverageLapTime|DriverCarEstLapTime)$/.test(field)) {
    return "s";
  }
  if (/RPM$|RedLine$/.test(field)) return "rpm";
  if (/FuelMaxLtr$/.test(field)) return "L";
  if (/FuelKgPerLtr$/.test(field)) return "kg/L";
  if (/HeadPos[XYZ]$/.test(field)) return "m";
  if (/PitTrkPct$|SectorStartPct$/.test(field)) return "fraction";
  if (field === "SectorNum") return "index";
  if (/Latitude$|Longitude$|NorthOffset$|Direction$/.test(field)) return "deg";
  if (/Color$/.test(field)) return "color";
  if (
    /^(Official|Unofficial|TeamRacing|QualifierMustStartRace|HeatRacing|StandingStart|ShortParadeLap|HasOpenRegistration|IsFixedSetup|IsScenic|ScanningIsOn|CanScan|CanSquawk|IsDeletable|IsMutable|Muted|DriverSetupIsModified|DriverSetupPassedTech|CarIsAI|CarIsPaceCar|IsSpectator)$/.test(
      field,
    )
  ) {
    return "boolean";
  }
  if (/ID$|Id$|UserID$|TeamID$|ClubID$|CarID$|ClassID$|LeagueID$|SeasonID$|SeriesID$|SessionID$|SubSessionID$/.test(field)) {
    return "id";
  }
  if (/Idx$|Num$|Position$|Lap$|Laps$|Count$|Rating$|Level$|Priority$|Turns$|Drivers$|Starters$|Frequencies$|Flags$|Changes$|Week$/.test(field)) {
    return "count";
  }
  return "text";
}

export { humanize, unitFor };
