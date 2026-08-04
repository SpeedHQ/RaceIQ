// iRacing SDK aliases and SessionInfo YAML mapping.
import { IRACING_SESSION_INFO_CATALOG_FIELDS } from "../../shared/games/iracing/session-info/catalog";
import { IRACING_SESSION_INFO_RAW_SOURCE } from "../../shared/games/iracing/session-info/contracts";
import { SEMANTIC_DEFINITIONS } from "./semantic-definitions";
import { categoryFor, humanize, slug, unitFor } from "./ast-discovery";
import { attachChild } from "./packet-mapping";
import { addSource } from "./extension-field-mapping";
import { appendNormalization, unavailableGames } from "./extension-metadata";
import type { AvailableLink, CatalogGroup, CatalogVariable, GameId, SourceVariable } from "./model";

function iRacingFreshness(name: string): AvailableLink["freshness"] {
  return /tempC[LMR]$|wear[LMR]$|coldPressure$/.test(name)
    ? "pit-snapshot"
    : "continuous";
}

function generalizeIRacingDescription(description: string): string {
  return description
    .replace(/^(LF|RF|LR|RR)\s+tire\s+/i, "")
    .replace(/^(LF|RF|LR|RR)\s+/i, "")
    .replace(/^./, (char) => char.toUpperCase());
}

function canonicalIRacingUnit(unit: string): string {
  const aliases: Record<string, string> = {
    C: "°C",
    RPM: "rpm",
    "revs/min": "rpm",
    "N*m": "N·m",
    l: "L",
    "l or kWh": "L or kWh",
    "m/s^2": "m/s²",
    "m/s at 360 Hz": "m/s",
  };
  return aliases[unit] ?? unit;
}

function inferredIRacingUnit(
  raw: { name: string; type: string; unit: string },
  semantic?: CatalogVariable,
): string {
  if (raw.unit) return raw.unit;
  if (raw.type === "bool") return "boolean";
  if (semantic && semantic.canonicalUnit !== "text") {
    return semantic.canonicalUnit;
  }
  const inferred = unitFor(humanize(raw.name), raw.type);
  return inferred === "unitless" && /char|string/i.test(raw.type)
    ? "text"
    : inferred;
}

const IRACING_SDK_ALIASES: Record<string, string> = {
  CamCameraNumber: "diagnostics.camera.active-camera-number",
  CamCameraState: "diagnostics.camera.state-flags",
  CamCarIdx: "identity.camera-focus-car-index",
  CamGroupNumber: "diagnostics.camera.active-group-number",
  CarIdxBestLapNum: "timing.competitor.best-lap-number",
  CarIdxBestLapTime: "timing.competitor.best-lap-time",
  CarIdxClass: "race.competitor.car-class-id",
  CarIdxClassPosition: "race.competitor.class-position",
  CarIdxEstTime: "timing.competitor.estimated-time",
  CarIdxF2Time: "timing.competitor.gap-to-leader",
  CarIdxFastRepairsUsed: "race.competitor.fast-repairs-used",
  CarIdxGear: "inputs.competitor.gear",
  CarIdxLap: "timing.competitor.current-lap-number",
  CarIdxLapCompleted: "race.competitor.laps-complete",
  CarIdxLapDistPct: "timing.competitor.lap-fraction",
  CarIdxLastLapTime: "timing.competitor.last-lap-time",
  CarIdxOnPitRoad: "race.competitor.pit-status",
  CarIdxP2P_Count: "race.competitor.push-to-pass-count",
  CarIdxP2P_Status: "race.competitor.push-to-pass-active",
  CarIdxPaceFlags: "race.competitor.pace-flags",
  CarIdxPaceLine: "race.competitor.pace-line",
  CarIdxPaceRow: "race.competitor.pace-row",
  CarIdxPosition: "race.competitor.position",
  CarIdxQualTireCompound: "tires.competitor.qualifying-compound",
  CarIdxQualTireCompoundLocked:
    "tires.competitor.qualifying-compound-locked",
  CarIdxRPM: "engine.competitor-rpm",
  CarIdxSteer: "inputs.competitor-steering-angle",
  CarIdxSessionFlags: "race.competitor.session-flags",
  CarIdxTireCompound: "tires.competitor.compound",
  CarIdxTrackSurface: "race.competitor.track-location",
  CarIdxTrackSurfaceMaterial:
    "race.competitor.track-surface-material",
  DCDriversSoFar: "session.driver-change.drivers-used",
  DCLapStatus: "race.driver-change-lap-status",
  LapBestLap: "timing.best-lap-number",
  LapBestNLapLap: "timing.n-lap-average.best-ending-lap",
  LapBestNLapTime: "timing.n-lap-average.best-time",
  LapCompleted: "timing.last-completed-lap-number",
  LapDeltaToSessionLastlLap: "timing.delta-to-session-last-lap",
  LapDeltaToSessionLastlLap_DD:
    "timing.delta-to-session-last-lap-rate",
  LapDeltaToSessionLastlLap_OK:
    "timing.delta-to-session-last-lap-valid",
  LapDeltaToBestLap_DD: "timing.lap-delta-to-best-lap-rate",
  LapDeltaToBestLap_OK: "timing.lap-delta-to-best-lap-valid",
  LapDeltaToOptimalLap_DD: "timing.lap-delta-to-optimal-lap-rate",
  LapDeltaToOptimalLap_OK: "timing.lap-delta-to-optimal-lap-valid",
  LapDeltaToSessionBestLap_DD:
    "timing.lap-delta-to-session-best-lap-rate",
  LapDeltaToSessionBestLap_OK:
    "timing.lap-delta-to-session-best-lap-valid",
  LapDeltaToSessionOptimalLap_DD:
    "timing.lap-delta-to-session-optimal-lap-rate",
  LapDeltaToSessionOptimalLap_OK:
    "timing.lap-delta-to-session-optimal-lap-valid",
  LapLasNLapSeq: "timing.n-lap-average.clean-lap-count",
  LapLastNLapTime: "timing.n-lap-average.current-time",
  LoadNumTextures: "diagnostics.car-number-texture-loading",
  LapDistPct: "timing.lap-fraction",
  PlayerCarIdx: "identity.player-car-index",
  PlayerCarClass: "identity.player-car-class-id",
  PlayerCarClassPosition: "race.player-class-position",
  SessionUniqueID: "session.session-id",
  PlayerIncidents: "race.incident-flags",
  PlayerCarDriverIncidentCount: "race.driver-incident-count",
  PlayerCarMyIncidentCount: "race.player-incident-count",
  PlayerCarTeamIncidentCount: "race.team-incident-count",
  PlayerTireCompound: "tires.tire-compound-code",
  FuelLevelPct: "fuel.fuel-percent",
  WaterTemp: "engine.coolant-temperature",
  OilTemp: "engine.oil-temperature",
  OilPress: "engine.oil-pressure",
  OkToReloadTextures: "diagnostics.texture-reload-allowed",
  PitOptRepairLeft: "race.pit-service.optional-repair-time-remaining",
  PitRepairLeft: "race.pit-service.mandatory-repair-time-remaining",
  PitSvFlags: "race.pit-service.flags",
  PitSvFuel: "race.pit-service.fuel-add-amount",
  PitSvLFP: "race.pit-service.tire-pressure",
  PitSvLRP: "race.pit-service.tire-pressure",
  PitSvRFP: "race.pit-service.tire-pressure",
  PitSvRRP: "race.pit-service.tire-pressure",
  PitSvTireCompound: "race.pit-service.tire-compound",
  PlayerCarPitSvStatus: "race.pit-service.status",
  P2P_Count: "race.player.push-to-pass-count",
  P2P_Status: "race.player.push-to-pass-active",
  RadioTransmitCarIdx: "diagnostics.radio.transmitting-car-index",
  RadioTransmitFrequencyIdx:
    "diagnostics.radio.transmitting-frequency-index",
  RadioTransmitRadioIdx: "diagnostics.radio.transmitting-radio-index",
  SessionLapsRemain: "session.laps-remaining",
  SessionLapsRemainEx: "session.laps-remaining",
  SessionLapsTotal: "timing.total-laps",
  dcStarter: "inputs.starter-trigger",
};

const IRACING_YAML_ALIASES: Record<string, string> = {
  "WeekendInfo.TrackName": "identity.track-name",
  "WeekendInfo.TrackDisplayName": "identity.track-name",
  "WeekendInfo.TrackDisplayShortName": "identity.track-name",
  "WeekendInfo.TrackID": "identity.track-ordinal",
  "WeekendInfo.TrackLength": "timing.track-length",
  "WeekendInfo.TrackLengthOfficial": "timing.official-track-length",
  "WeekendInfo.TrackVersion": "diagnostics.track-content-version",
  "WeekendInfo.TrackAltitude": "identity.track.altitude",
  "WeekendInfo.TrackCity": "identity.track.city",
  "WeekendInfo.TrackCleanup": "weather.track-cleanup-mode",
  "WeekendInfo.TrackConfigName": "identity.track.configuration-name",
  "WeekendInfo.TrackCountry": "identity.track.country",
  "WeekendInfo.TrackDirection": "identity.track.direction",
  "WeekendInfo.TrackDynamicTrack": "weather.dynamic-track-mode",
  "WeekendInfo.TrackLatitude": "identity.track.latitude",
  "WeekendInfo.TrackLongitude": "identity.track.longitude",
  "WeekendInfo.TrackNorthOffset": "identity.track.north-offset",
  "WeekendInfo.TrackNumTurns": "identity.track.turn-count",
  "WeekendInfo.TrackType": "identity.track.type",
  "WeekendInfo.SessionID": "session.session-id",
  "WeekendInfo.SubSessionID": "session.subsession-id",
  "WeekendInfo.TrackPitSpeedLimit": "race.pit-speed-limit",
  "WeekendInfo.TrackAirTemp": "weather.air-temp",
  "WeekendInfo.TrackAirPressure": "weather.air-pressure",
  "WeekendInfo.TrackFogLevel": "weather.fog-level",
  "WeekendInfo.TrackRelativeHumidity": "weather.relative-humidity",
  "WeekendInfo.TrackSkies": "weather.skies",
  "WeekendInfo.TrackSurfaceTemp": "weather.track-temp",
  "WeekendInfo.TrackWeatherType": "weather.weather-type",
  "WeekendInfo.TrackPrecipitation": "weather.rain-percent",
  "WeekendInfo.TrackWindVel": "weather.wind-speed",
  "WeekendInfo.TrackWindDir": "weather.wind-direction",
  "WeekendInfo.BuildVersion": "diagnostics.sim-build-version",
  "WeekendInfo.BuildTarget": "diagnostics.sim-build-target",
  "WeekendInfo.BuildType": "diagnostics.sim-build-type",
  "WeekendInfo.Category": "session.category",
  "WeekendInfo.DCRuleSet": "session.driver-change-rule-set",
  "WeekendInfo.EventType": "session.event-type",
  "WeekendInfo.HeatRacing": "session.heat-racing",
  "WeekendInfo.LeagueID": "session.league-id",
  "WeekendInfo.MaxDrivers": "session.maximum-drivers",
  "WeekendInfo.MinDrivers": "session.minimum-drivers",
  "WeekendInfo.NumCarClasses": "session.car-class-count",
  "WeekendInfo.NumCarTypes": "session.car-type-count",
  "WeekendInfo.Official": "session.official",
  "WeekendInfo.QualifierMustStartRace":
    "session.qualifier-must-start-race",
  "WeekendInfo.RaceWeek": "session.race-week",
  "WeekendInfo.SeasonID": "session.season-id",
  "WeekendInfo.SeriesID": "session.series-id",
  "WeekendInfo.SimMode": "session.sim-mode",
  "WeekendInfo.TeamRacing": "session.team-racing",
  "WeekendInfo.TelemetryOptions.TelemetryDiskFile":
    "diagnostics.telemetry.disk-file",
  "WeekendInfo.WeekendOptions.CommercialMode":
    "session.configuration.commercial-mode",
  "WeekendInfo.WeekendOptions.CourseCautions":
    "session.configuration.course-cautions",
  "WeekendInfo.WeekendOptions.Date": "session.configuration.date",
  "WeekendInfo.WeekendOptions.EarthRotationSpeedupFactor":
    "session.configuration.earth-rotation-speedup-factor",
  "WeekendInfo.WeekendOptions.FastRepairsLimit":
    "session.configuration.fast-repair-limit",
  "WeekendInfo.WeekendOptions.GreenWhiteCheckeredLimit":
    "session.configuration.green-white-checkered-limit",
  "WeekendInfo.WeekendOptions.HardcoreLevel":
    "session.configuration.hardcore-level",
  "WeekendInfo.WeekendOptions.HasOpenRegistration":
    "session.configuration.open-registration",
  "WeekendInfo.WeekendOptions.IncidentLimit":
    "session.configuration.incident-limit",
  "WeekendInfo.WeekendOptions.NightMode":
    "session.configuration.night-mode",
  "WeekendInfo.WeekendOptions.NumJokerLaps":
    "session.configuration.joker-lap-count",
  "WeekendInfo.WeekendOptions.NumStarters":
    "session.configuration.starter-count",
  "WeekendInfo.WeekendOptions.QualifyScoring":
    "session.configuration.qualifying-scoring",
  "WeekendInfo.WeekendOptions.Restarts":
    "session.configuration.restarts",
  "WeekendInfo.WeekendOptions.ShortParadeLap":
    "session.configuration.short-parade-lap",
  "WeekendInfo.WeekendOptions.StandingStart":
    "session.configuration.standing-start",
  "WeekendInfo.WeekendOptions.StartingGrid":
    "session.configuration.starting-grid",
  "WeekendInfo.WeekendOptions.StrictLapsChecking":
    "session.configuration.strict-lap-checking",
  "WeekendInfo.WeekendOptions.TimeOfDay":
    "session.configuration.time-of-day",
  "WeekendInfo.WeekendOptions.Unofficial":
    "session.configuration.unofficial",
  "WeekendInfo.WeekendOptions.FogLevel": "weather.configured.fog-level",
  "WeekendInfo.WeekendOptions.RelativeHumidity":
    "weather.configured.relative-humidity",
  "WeekendInfo.WeekendOptions.Skies": "weather.configured.skies",
  "WeekendInfo.WeekendOptions.WeatherTemp":
    "weather.configured.temperature",
  "WeekendInfo.WeekendOptions.WeatherType":
    "weather.configured.weather-type",
  "WeekendInfo.WeekendOptions.WindDirection":
    "weather.configured.wind-direction",
  "WeekendInfo.WeekendOptions.WindSpeed": "weather.configured.wind-speed",
  "SessionInfo.Sessions[].SessionType": "session.session-type",
  "SessionInfo.Sessions[].SessionLaps": "timing.total-laps",
  "SessionInfo.Sessions[].SessionName": "session.schedule.names",
  "SessionInfo.Sessions[].SessionNum": "session.schedule.numbers",
  "SessionInfo.Sessions[].SessionNumLapsToAvg":
    "session.schedule.laps-to-average",
  "SessionInfo.Sessions[].SessionRunGroupsUsed":
    "session.schedule.run-groups-used",
  "SessionInfo.Sessions[].SessionSkipped": "session.schedule.skipped",
  "SessionInfo.Sessions[].SessionSubType": "session.schedule.subtype",
  "SessionInfo.Sessions[].SessionTime": "session.schedule.time-limit",
  "SessionInfo.Sessions[].SessionTrackRubberState":
    "weather.track-rubber-state",
  "SessionInfo.Sessions[].SessionEnforceTireCompoundChange":
    "session.configuration.enforce-tire-compound-change",
  "SessionInfo.Sessions[].ResultsAverageLapTime":
    "timing.session-average-lap-time",
  "SessionInfo.Sessions[].ResultsLapsComplete":
    "race.session-summary.laps-complete",
  "SessionInfo.Sessions[].ResultsNumCautionFlags":
    "race.session-summary.caution-flags",
  "SessionInfo.Sessions[].ResultsNumCautionLaps":
    "race.session-summary.caution-laps",
  "SessionInfo.Sessions[].ResultsNumLeadChanges":
    "race.session-summary.lead-changes",
  "SessionInfo.Sessions[].ResultsOfficial":
    "race.session-summary.official",
  "SessionInfo.Sessions[].ResultsFastestLap[].CarIdx":
    "race.competitor.car-index",
  "SessionInfo.Sessions[].ResultsFastestLap[].FastestLap":
    "timing.session-fastest-lap.number",
  "SessionInfo.Sessions[].ResultsFastestLap[].FastestTime":
    "timing.session-fastest-lap.time",
  "SessionInfo.Sessions[].ResultsPositions[].Position":
    "race.competitor.position",
  "SessionInfo.Sessions[].ResultsPositions[].ClassPosition":
    "race.competitor.class-position",
  "SessionInfo.Sessions[].ResultsPositions[].CarIdx":
    "race.competitor.car-index",
  "SessionInfo.Sessions[].ResultsPositions[].Lap":
    "timing.competitor.current-lap-number",
  "SessionInfo.Sessions[].ResultsPositions[].Time":
    "timing.competitor.total-time",
  "SessionInfo.Sessions[].ResultsPositions[].FastestLap":
    "timing.competitor.best-lap-number",
  "SessionInfo.Sessions[].ResultsPositions[].FastestTime":
    "timing.competitor.best-lap-time",
  "SessionInfo.Sessions[].ResultsPositions[].LastTime":
    "timing.competitor.last-lap-time",
  "SessionInfo.Sessions[].ResultsPositions[].Incidents":
    "race.competitor.incidents",
  "SessionInfo.Sessions[].ResultsPositions[].LapsComplete":
    "race.competitor.laps-complete",
  "SessionInfo.Sessions[].ResultsPositions[].LapsLed":
    "race.competitor.laps-led",
  "SessionInfo.Sessions[].ResultsPositions[].JokerLapsComplete":
    "race.competitor.joker-laps-complete",
  "SessionInfo.Sessions[].ResultsPositions[].LapsDriven":
    "race.competitor.laps-driven",
  "SessionInfo.Sessions[].ResultsPositions[].ReasonOutId":
    "race.competitor.reason-out-id",
  "SessionInfo.Sessions[].ResultsPositions[].ReasonOutStr":
    "race.competitor.reason-out-text",
  "QualifyResultsInfo.Results[].Position": "race.competitor.position",
  "QualifyResultsInfo.Results[].ClassPosition":
    "race.competitor.class-position",
  "QualifyResultsInfo.Results[].CarIdx": "race.competitor.car-index",
  "QualifyResultsInfo.Results[].FastestLap":
    "timing.competitor.best-lap-number",
  "QualifyResultsInfo.Results[].FastestTime":
    "timing.competitor.best-lap-time",
  "DriverInfo.DriverCarIdleRPM": "engine.engine-idle-rpm",
  "DriverInfo.DriverCarRedLine": "engine.engine-max-rpm",
  "DriverInfo.DriverCarFuelMaxLtr": "fuel.fuel-capacity",
  "DriverInfo.DriverCarGearNeutral":
    "inputs.gearbox.neutral-position-count",
  "DriverInfo.DriverCarGearNumForward": "inputs.gearbox.forward-gear-count",
  "DriverInfo.DriverCarGearReverse":
    "inputs.gearbox.reverse-position-count",
  "DriverInfo.DriverCarIsElectric": "identity.player-car-electric",
  "DriverInfo.DriverUserID": "identity.player-driver-id",
  "DriverInfo.PaceCarIdx": "race.pace-car-index",
  "DriverInfo.DriverHeadPosX": "motion.driver-head-position.x",
  "DriverInfo.DriverHeadPosY": "motion.driver-head-position.y",
  "DriverInfo.DriverHeadPosZ": "motion.driver-head-position.z",
  "DriverInfo.DriverCarFuelKgPerLtr": "fuel.density",
  "DriverInfo.DriverCarMaxFuelPct": "fuel.maximum-fill-percentage",
  "DriverInfo.DriverCarSLFirstRPM": "engine.shift-light.first-rpm",
  "DriverInfo.DriverCarSLShiftRPM": "engine.shift-light.shift-rpm",
  "DriverInfo.DriverCarSLLastRPM": "engine.shift-light.last-rpm",
  "DriverInfo.DriverCarSLBlinkRPM": "engine.shift-light.blink-rpm",
  "DriverInfo.DriverCarVersion": "identity.player-car-version",
  "DriverInfo.DriverPitTrkPct": "race.pit-stall-lap-fraction",
  "DriverInfo.DriverCarEngCylinderCount": "engine.cylinder-count",
  "DriverInfo.DriverCarIdx": "identity.player-car-index",
  "DriverInfo.DriverIncidentCount": "race.driver-incident-count",
  "DriverInfo.DriverCarEstLapTime": "timing.predicted-lap-time",
  "DriverInfo.DriverSetupName": "setup.metadata.name",
  "DriverInfo.DriverSetupIsModified": "setup.metadata.modified",
  "DriverInfo.DriverSetupLoadTypeName": "setup.metadata.load-type",
  "DriverInfo.DriverSetupPassedTech": "setup.metadata.passed-tech",
  "WeekendInfo.WeekendOptions.IsFixedSetup": "setup.metadata.fixed",
  "DriverInfo.Drivers[].CarIdx": "race.competitor.car-index",
  "DriverInfo.Drivers[].UserID": "race.competitor.driver-id",
  "DriverInfo.Drivers[].UserName": "race.competitor.driver-name",
  "DriverInfo.Drivers[].TeamID": "race.competitor.team-id",
  "DriverInfo.Drivers[].TeamName": "race.competitor.team-name",
  "DriverInfo.Drivers[].CarID": "race.competitor.car-id",
  "DriverInfo.Drivers[].CarScreenName": "race.competitor.car-name",
  "DriverInfo.Drivers[].CarScreenNameShort": "race.competitor.car-name",
  "DriverInfo.Drivers[].CarClassID": "race.competitor.car-class-id",
  "DriverInfo.Drivers[].CarClassShortName":
    "race.competitor.car-class-name",
  "DriverInfo.Drivers[].AbbrevName":
    "race.competitor.driver-abbreviated-name",
  "DriverInfo.Drivers[].Initials": "race.competitor.driver-initials",
  "DriverInfo.Drivers[].IRating": "race.competitor.rating",
  "DriverInfo.Drivers[].LicLevel": "race.competitor.license-level",
  "DriverInfo.Drivers[].LicSubLevel": "race.competitor.license-sublevel",
  "DriverInfo.Drivers[].LicString": "race.competitor.license-name",
  "DriverInfo.Drivers[].LicColor": "race.competitor.license-color",
  "DriverInfo.Drivers[].ClubName": "race.competitor.club-name",
  "DriverInfo.Drivers[].DivisionName": "race.competitor.division-name",
  "DriverInfo.Drivers[].IsSpectator": "race.competitor.is-spectator",
  "DriverInfo.Drivers[].CarNumber": "race.competitor.car-number",
  "DriverInfo.Drivers[].CarNumberRaw": "race.competitor.car-number-raw",
  "DriverInfo.Drivers[].CarPath": "race.competitor.car-path",
  "DriverInfo.Drivers[].CarIsAI": "race.competitor.is-ai",
  "DriverInfo.Drivers[].CarIsPaceCar": "race.competitor.is-pace-car",
  "DriverInfo.Drivers[].CarClassColor":
    "race.competitor.car-class-color",
  "DriverInfo.Drivers[].CarClassLicenseLevel":
    "race.competitor.car-class-license-level",
  "DriverInfo.Drivers[].CarClassMaxFuelPct":
    "race.competitor.class-max-fuel-percentage",
  "DriverInfo.Drivers[].CarClassPowerAdjust":
    "race.competitor.class-power-adjust",
  "DriverInfo.Drivers[].CarClassRelSpeed":
    "race.competitor.class-relative-speed",
  "DriverInfo.Drivers[].CarClassWeightPenalty":
    "race.competitor.class-weight-penalty",
  "DriverInfo.Drivers[].CarClassDryTireSetLimit":
    "race.competitor.class-dry-tire-set-limit",
  "DriverInfo.Drivers[].CarClassEstLapTime":
    "timing.competitor.class-estimated-lap-time",
  "DriverInfo.Drivers[].CarIsElectric": "race.competitor.car-electric",
  "DriverInfo.Drivers[].ClubID": "race.competitor.club-id",
  "DriverInfo.Drivers[].DivisionID": "race.competitor.division-id",
  "DriverInfo.Drivers[].CarDesignStr": "race.competitor.car-design",
  "DriverInfo.Drivers[].CarNumberDesignStr":
    "race.competitor.car-number-design",
  "DriverInfo.Drivers[].HelmetDesignStr":
    "race.competitor.helmet-design",
  "DriverInfo.Drivers[].SuitDesignStr": "race.competitor.suit-design",
  "DriverInfo.Drivers[].CarSponsor_1":
    "race.competitor.primary-sponsor",
  "DriverInfo.Drivers[].CarSponsor_2":
    "race.competitor.secondary-sponsor",
  "DriverInfo.Drivers[].CurDriverIncidentCount":
    "race.competitor.driver-incident-count",
  "DriverInfo.Drivers[].TeamIncidentCount":
    "race.competitor.team-incident-count",
  "CameraInfo.Groups[].GroupName": "diagnostics.camera.group-name",
  "CameraInfo.Groups[].GroupNum": "diagnostics.camera.group-number",
  "CameraInfo.Groups[].IsScenic": "diagnostics.camera.group-scenic",
  "CameraInfo.Groups[].Cameras[].CameraName": "diagnostics.camera.name",
  "CameraInfo.Groups[].Cameras[].CameraNum": "diagnostics.camera.number",
  "RadioInfo.SelectedRadioNum": "diagnostics.radio.selected-radio-number",
  "RadioInfo.Radios[].HopCount": "diagnostics.radio.hop-count",
  "RadioInfo.Radios[].NumFrequencies": "diagnostics.radio.frequency-count",
  "RadioInfo.Radios[].RadioNum": "diagnostics.radio.number",
  "RadioInfo.Radios[].ScanningIsOn": "diagnostics.radio.scanning",
  "RadioInfo.Radios[].TunedToFrequencyNum":
    "diagnostics.radio.tuned-frequency-number",
  "RadioInfo.Radios[].Frequencies[].CanScan":
    "diagnostics.radio.frequency-can-scan",
  "RadioInfo.Radios[].Frequencies[].CanSquawk":
    "diagnostics.radio.frequency-can-squawk",
  "RadioInfo.Radios[].Frequencies[].CarIdx":
    "diagnostics.radio.frequency-car-index",
  "RadioInfo.Radios[].Frequencies[].ClubID":
    "diagnostics.radio.frequency-club-id",
  "RadioInfo.Radios[].Frequencies[].EntryIdx":
    "diagnostics.radio.frequency-entry-index",
  "RadioInfo.Radios[].Frequencies[].FrequencyName":
    "diagnostics.radio.frequency-name",
  "RadioInfo.Radios[].Frequencies[].FrequencyNum":
    "diagnostics.radio.frequency-number",
  "RadioInfo.Radios[].Frequencies[].IsDeletable":
    "diagnostics.radio.frequency-deletable",
  "RadioInfo.Radios[].Frequencies[].IsMutable":
    "diagnostics.radio.frequency-mutable",
  "RadioInfo.Radios[].Frequencies[].Muted":
    "diagnostics.radio.frequency-muted",
  "RadioInfo.Radios[].Frequencies[].Priority":
    "diagnostics.radio.frequency-priority",
  "SplitTimeInfo.Sectors[].SectorNum": "timing.sector.layout.indexes",
  "SplitTimeInfo.Sectors[].SectorStartPct":
    "timing.sector.layout.start-fractions",
};

function addIRacingYamlField(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
  field: (typeof IRACING_SESSION_INFO_CATALOG_FIELDS)[number],
): void {
  const semanticId =
    field.semanticId ??
    IRACING_YAML_ALIASES[field.path] ??
    `${categoryFor(`${field.path} ${field.description}`)}.${slug(field.path)}`;
  const definition = SEMANTIC_DEFINITIONS[semanticId];
  const category = categoryFor(`${field.path} ${field.description}`);
  const semanticRoot = semanticId.split(".")[0];
  let variable = variables.get(semanticId);

  if (!variable) {
    variable = {
      id: semanticId,
      label: definition?.label ?? field.label,
      description: definition?.description ?? field.description,
      parentId:
        definition?.parentId ?? (groups.has(semanticRoot) ? semanticRoot : category),
      canonicalUnit: definition?.canonicalUnit ?? field.unit,
      shape:
        definition?.shape ??
        (field.path.includes("[]") || field.path.endsWith(".**")
          ? "structured"
          : "scalar"),
      games: unavailableGames(
        "No equivalent source value is currently identified for this parser.",
      ),
    };
    variables.set(semanticId, variable);
    attachChild(groups, variable.parentId, semanticId);
  }

  const sourcePath = `iRacing.SessionInfo.${field.path}`;
  const requiresCurrentSessionSelection = [
    "SessionInfo.Sessions[].SessionType",
    "SessionInfo.Sessions[].SessionLaps",
  ].includes(field.path);
  const existing = variable.games.iracing;
  if (existing.kind === "unavailable") {
    variable.games.iracing = {
      kind:
        !requiresCurrentSessionSelection &&
        (field.unit === variable.canonicalUnit || field.unit === "structured")
          ? "direct"
          : "normalized",
      nativeUnit: field.unit,
      sources: [sourcePath],
      freshness: "session-update",
      ...(requiresCurrentSessionSelection
        ? {
            normalization: "select YAML entry matching current session number",
          }
        : field.unit !== variable.canonicalUnit && field.unit !== "structured"
          ? {
              normalization: `parse YAML ${field.unit} as ${variable.canonicalUnit}`,
            }
        : {}),
      description:
        field.retention === "exact"
          ? "Complete SessionInfo YAML is preserved verbatim by iRacing source-frame v3."
          : field.retention === "normalized"
            ? "iRacing YAML field is normalized into the source-frame session summary."
            : "iRacing YAML field is catalogued but not retained by the source frame.",
    };
  } else if (Array.isArray(existing.sources)) {
    if (!existing.sources.includes(sourcePath)) existing.sources.push(sourcePath);
    if (requiresCurrentSessionSelection) {
      existing.kind = "normalized";
      appendNormalization(
        existing,
        "select YAML entry matching current session number",
      );
    } else if (
      field.unit === "value-with-unit" &&
      field.unit !== variable.canonicalUnit
    ) {
      existing.kind = "normalized";
      appendNormalization(
        existing,
        `parse YAML value-with-unit as ${variable.canonicalUnit}`,
      );
    }
  }

  addSource(inventories, "iracing", {
    path: `SessionInfo.${field.path}`,
    label: field.label,
    unit: field.unit,
    dataType: "yaml",
    ...(!field.path.includes("[]") && !field.path.endsWith(".**")
      ? { count: 1 }
      : {}),
    description: field.description,
    semanticId,
    sourceKind: "yaml",
    recordedByRaceIQ: field.retention === "exact",
    retention: field.retention,
  });
}

function addIRacingRawYamlSource(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
  inventories: Record<GameId, SourceVariable[]>,
): void {
  const field = IRACING_SESSION_INFO_RAW_SOURCE;
  const semanticId = field.semanticId!;
  const games = unavailableGames(
    "No equivalent raw SessionInfo YAML source is provided by this parser.",
  );
  games.iracing = {
    kind: "direct",
    nativeUnit: field.unit,
    sources: ["iRacing.SessionInfo"],
    freshness: "session-update",
    description:
      "Complete SessionInfo YAML is preserved verbatim by iRacing source-frame v3.",
  };
  variables.set(semanticId, {
    id: semanticId,
    label: field.label,
    description: field.description,
    parentId: "diagnostics",
    canonicalUnit: field.unit,
    shape: "structured",
    games,
  });
  attachChild(groups, "diagnostics", semanticId);

  addSource(inventories, "iracing", {
    path: field.path,
    label: field.label,
    unit: field.unit,
    dataType: "string",
    count: 1,
    description: field.description,
    semanticId,
    sourceKind: "yaml",
    recordedByRaceIQ: true,
    retention: field.retention,
  });
}

export { iRacingFreshness, generalizeIRacingDescription, canonicalIRacingUnit, inferredIRacingUnit, IRACING_SDK_ALIASES, IRACING_YAML_ALIASES, addIRacingYamlField, addIRacingRawYamlSource };
