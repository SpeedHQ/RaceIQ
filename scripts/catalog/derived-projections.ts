// Derived sector and cross-source catalog projections.

import {
  GAME_RACE_EVENT_DERIVATIONS,
  getGameRaceEventDerivation,
} from "../../server/games/race-event-derivations";
import { GAME_IDS } from "./model";
import type {
  AvailableLink,
  CatalogGroup,
  CatalogVariable,
  GameId,
  GameLink,
} from "./model";
import {
  addDefinedVariable,
  derivedLink,
  normalizedLink,
  unavailableGames,
} from "./extension-mapping";
import { unavailable } from "./ast-discovery";

function raceEventDerivedLink(
  gameId: GameId,
  semanticId: string,
  nativeUnit: string,
  sources: string[],
  normalization: string,
  description: string,
  freshness: AvailableLink["freshness"] = "continuous",
): AvailableLink {
  const derivation = getGameRaceEventDerivation(gameId, semanticId);
  if (!derivation) {
    throw new Error(
      `Missing runtime race-event derivation ${gameId}:${semanticId}`,
    );
  }
  return {
    kind: "derived",
    nativeUnit,
    sources,
    freshness,
    normalization,
    description,
    provenance: {
      origin: "derivation",
      artifact: GAME_RACE_EVENT_DERIVATIONS[gameId].artifact,
    },
    execution: {
      kind: "derivation",
      id: derivation.id,
      version: derivation.version,
      codeHash: derivation.codeHash,
      deterministic: derivation.deterministic,
      inputs: derivation.inputs,
      missingDataPolicy: derivation.missingDataPolicy,
    },
  };
}

function completeRaceEventRawSources(
  variables: ReadonlyMap<string, CatalogVariable>,
): void {
  for (const gameId of GAME_IDS) {
    for (const derivation of GAME_RACE_EVENT_DERIVATIONS[gameId].derivations) {
      const target = variables.get(derivation.output.semanticId)?.games[gameId];
      if (!target || target.kind !== "derived") {
        throw new Error(
          `Missing race-event catalog mapping ${gameId}:${derivation.output.semanticId}`,
        );
      }
      if (!Array.isArray(target.sources)) {
        throw new Error(
          `Race-event mapping ${gameId}:${derivation.output.semanticId} must use scalar sources`,
        );
      }
      for (const input of derivation.inputs) {
        const dependency = variables.get(input.semanticId)?.games[gameId];
        if (!dependency || dependency.kind === "unavailable") {
          if (input.required) {
            throw new Error(
              `Missing required race-event input ${gameId}:${input.semanticId}`,
            );
          }
          continue;
        }
        const dependencySources = Array.isArray(dependency.sources)
          ? dependency.sources
          : Object.values(dependency.sources).flat();
        for (const source of dependencySources) {
          if (!target.sources.includes(source)) {
            target.sources.push(source);
          }
        }
      }
    }
  }
}

export
function addSectorDerivedVariables(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
): void {
  const currentIndex = variables.get("timing.sector.current-index");
  if (!currentIndex) throw new Error("Missing current-sector semantic variable");
  currentIndex.games["fm-2023"] = derivedLink(
    "m",
    ["TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
    "select sector containing current lap distance",
    "RaceIQ derives sector index from curated track boundaries.",
  );
  currentIndex.games["ac-evo"] = derivedLink(
    "m",
    ["TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
    "select sector containing current lap distance",
    "AC Evo sector fields are placeholders, so RaceIQ uses curated track boundaries.",
  );
  currentIndex.games.iracing = derivedLink(
    "fraction",
    ["iracing.lapDistancePct", "iracing.sectorStarts"],
    "select greatest sector start not above current lap fraction",
    "RaceIQ derives current sector from native iRacing SplitTimeInfo layout.",
  );

  const layoutIndexes = variables.get("timing.sector.layout.indexes");
  if (layoutIndexes) {
    for (const gameId of GAME_IDS) {
      if (layoutIndexes.games[gameId].kind !== "unavailable") continue;
      layoutIndexes.games[gameId] = derivedLink(
        "count",
        gameId === "iracing"
          ? ["iracing.sectorStarts"]
          : ["RaceIQ.Track.sectorStarts"],
        "generate sequential zero-based indexes for each sector boundary",
        `${gameId} sector indexes follow ordered sector boundary list.`,
        "static",
      );
    }
  }

  const layoutStarts = variables.get("timing.sector.layout.start-fractions");
  if (layoutStarts) {
    for (const gameId of ["fm-2023", "f1-2025", "acc", "ac-evo"] as const) {
      layoutStarts.games[gameId] = derivedLink(
        "fraction",
        ["RaceIQ.Track.sectorStarts"],
        "use curated track-specific sector start fractions",
        gameId === "f1-2025"
          ? "F1 packets provide authoritative times but not boundary distances; RaceIQ layout is display/derivation metadata."
          : `${gameId} uses RaceIQ curated track-sector boundaries.`,
        "static",
      );
    }
  }

  const unavailableByDefault = (description: string) =>
    unavailableGames(description);

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.current-time",
    {
      "fm-2023": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "RaceIQ.Track.sectorStarts"],
        "current lap time - time at current sector entry",
        "RaceIQ times curated sector-boundary crossings.",
      ),
      "f1-2025": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "f1.currentSector", "f1.sector1Time", "f1.sector2Time"],
        "subtract completed current-lap sector times from lap elapsed time",
        "RaceIQ derives running F1 sector time from native completed splits.",
      ),
      acc: derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "acc.currentSectorIndex"],
        "current lap time - time at native sector-index transition",
        "RaceIQ times ACC native sector transitions.",
      ),
      "ac-evo": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
        "current lap time - time at curated sector boundary",
        "RaceIQ derives AC Evo sector timing from lap distance.",
      ),
      iracing: derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "iracing.lapDistancePct", "iracing.sectorStarts"],
        "current lap time - time at native sector boundary",
        "RaceIQ times crossings of iRacing native variable-length sector layout.",
      ),
    },
  );

  for (const sector of ["s1", "s2", "s3"] as const) {
    const currentId = `timing.sector.current-lap.${sector}`;
    if (!variables.has(currentId)) {
      addDefinedVariable(
        variables,
        groups,
        currentId,
        unavailableGames("No native fixed-sector field is exposed."),
      );
    }
    const current = variables.get(currentId)!;
    for (const gameId of GAME_IDS) {
      if (current.games[gameId].kind !== "unavailable") continue;
      current.games[gameId] = derivedLink(
        "s",
        ["LiveSectorData.currentTimes"],
        `select sector index ${Number(sector.slice(1)) - 1}`,
        `${gameId} fixed ${sector.toUpperCase()} projection is derived from current variable-length sector array.`,
      );
    }

    const lastId = `timing.sector.last-lap.${sector}`;
    if (!variables.has(lastId)) {
      addDefinedVariable(
        variables,
        groups,
        lastId,
        unavailableGames("No native fixed-sector field is exposed."),
      );
    }
    const last = variables.get(lastId)!;
    for (const gameId of GAME_IDS) {
      if (last.games[gameId].kind !== "unavailable") continue;
      last.games[gameId] = derivedLink(
        "s",
        ["LapMeta.sectorTimes"],
        `select sector index ${Number(sector.slice(1)) - 1}`,
        `${gameId} fixed ${sector.toUpperCase()} projection is derived from persisted variable-length sector array.`,
        "static",
      );
    }
  }

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.current-lap.times",
    {
      "fm-2023": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
        "accumulate elapsed time between curated sector boundaries",
        "RaceIQ assembles current Forza sector array.",
      ),
      "f1-2025": derivedLink(
        "s",
        ["f1.sector1Time", "f1.sector2Time", "TelemetryPacket.CurrentLap"],
        "[S1, S2, current S3 running time]",
        "RaceIQ assembles current F1 three-sector array from native splits.",
      ),
      acc: derivedLink(
        "ms",
        ["acc.currentSectorIndex", "acc.lastSectorTime", "TelemetryPacket.CurrentLap"],
        "append native completed sector milliseconds and running sector seconds",
        "RaceIQ assembles current ACC sector array from native transitions.",
      ),
      "ac-evo": derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "TelemetryPacket.DistanceTraveled", "RaceIQ.Track.sectorStarts"],
        "accumulate elapsed time between curated sector boundaries",
        "RaceIQ assembles current AC Evo sector array.",
      ),
      iracing: derivedLink(
        "s",
        ["TelemetryPacket.CurrentLap", "iracing.lapDistancePct", "iracing.sectorStarts"],
        "accumulate elapsed time between native variable-length sector boundaries",
        "RaceIQ assembles current iRacing sector array.",
      ),
    },
  );

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.last-lap.times",
    {
      "fm-2023": derivedLink(
        "s",
        ["LapMeta.sectorTimes", "TelemetryPacket.LastLap"],
        "persist sector-boundary timings and derive final sector from lap total",
        "RaceIQ stores last completed Forza sector array.",
      ),
      "f1-2025": derivedLink(
        "s",
        ["f1.lapSectors.s1", "f1.lapSectors.s2", "f1.lapSectors.s3"],
        "select most recently completed lap from lap-number-keyed SessionHistory records",
        "RaceIQ selects definitive F1 splits for most recently completed lap.",
      ),
      acc: derivedLink(
        "ms",
        ["acc.currentSectorIndex", "acc.lastSectorTime", "TelemetryPacket.LastLap"],
        "assemble native completed sectors; final sector = lap time - prior sectors",
        "RaceIQ stores completed ACC sector array.",
      ),
      "ac-evo": derivedLink(
        "s",
        ["LapMeta.sectorTimes", "TelemetryPacket.LastLap"],
        "persist curated-boundary timings and derive final sector from lap total",
        "RaceIQ stores completed AC Evo sector array.",
      ),
      iracing: derivedLink(
        "s",
        ["iracing.sectorStarts", "iracing.lapDistancePct", "TelemetryPacket.CurrentLap", "TelemetryPacket.LastLap"],
        "time native boundary crossings; final sector = lap time - prior sectors",
        "RaceIQ stores variable-length iRacing sector array.",
      ),
    },
  );

  addDefinedVariable(
    variables,
    groups,
    "timing.sector.best-times",
    Object.fromEntries(
      GAME_IDS.map((gameId) => [
        gameId,
        derivedLink(
          "s",
          ["LapMeta.sectorTimes"],
          "minimum valid time at each sector index across completed laps",
          `${gameId} best sectors are derived from RaceIQ persisted lap-sector arrays.`,
          "static",
        ),
      ]),
    ) as Record<GameId, GameLink>,
  );

  const lastCompleted = variables.get("timing.sector.last-completed-time");
  if (lastCompleted) {
    lastCompleted.games["f1-2025"] = derivedLink(
      "s",
      ["f1.currentSector", "f1.sector1Time", "f1.sector2Time", "f1.lastS3"],
      "select split belonging to most recently completed sector",
      "RaceIQ selects last completed F1 split from native sector-specific fields.",
    );
    lastCompleted.games["fm-2023"] = derivedLink(
      "s",
      ["LiveSectorData.currentTimes"],
      "select most recently completed entry",
      "RaceIQ derives from curated boundary timing.",
    );
    lastCompleted.games["ac-evo"] = derivedLink(
      "s",
      ["LiveSectorData.currentTimes"],
      "select most recently completed entry",
      "RaceIQ derives from curated boundary timing.",
    );
    lastCompleted.games.iracing = derivedLink(
      "s",
      ["LiveSectorData.currentTimes"],
      "select most recently completed entry",
      "RaceIQ derives from native iRacing sector boundaries.",
    );
  }

  // Ensure all custom mappings still satisfy every-game catalog contract.
  for (const id of [
    "timing.sector.current-time",
    "timing.sector.current-lap.times",
    "timing.sector.last-lap.times",
    "timing.sector.best-times",
  ]) {
    const variable = variables.get(id);
    if (!variable) continue;
    for (const gameId of GAME_IDS) {
      variable.games[gameId] ??= unavailableByDefault(
        "No equivalent sector value is currently available.",
      )[gameId];
    }
  }
}

export function addRaceEventSemanticProjections(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
): void {
  const unavailable = unavailableGames(
    "Simulator does not provide source telemetry for this canonical race-event semantic.",
  );
  addDefinedVariable(variables, groups, "race.control.phase", {
    ...unavailable,
    acc: raceEventDerivedLink("acc", "race.control.phase", "enum", ["acc.flagStatus", "TelemetryPacket.IsRaceOn"], "ACC race-event semantic derivation", "ACC flag-status projection."),
    "ac-evo": raceEventDerivedLink("ac-evo", "race.control.phase", "enum", ["acc.flagStatus", "TelemetryPacket.IsRaceOn"], "AC Evo race-event semantic derivation", "AC Evo flag-status projection."),
    "f1-2025": raceEventDerivedLink("f1-2025", "race.control.phase", "enum", ["f1.resultSource", "f1.resultStatus", "f1.safetyCarStatus", "f1.vehicleFIAFlags"], "F1 race-event semantic derivation", "F1 result and race-control projection."),
    iracing: raceEventDerivedLink("iracing", "race.control.phase", "enum", ["iRacing.SessionFlags", "iRacing.SessionState"], "iRacing race-event semantic derivation", "iRacing session race-control projection."),
  });
  addDefinedVariable(variables, groups, "race.control.caution-kind", {
    ...unavailable,
    acc: raceEventDerivedLink("acc", "race.control.caution-kind", "enum", ["acc.flagStatus"], "ACC race-event semantic derivation", "ACC flag-status projection."),
    "ac-evo": raceEventDerivedLink("ac-evo", "race.control.caution-kind", "enum", ["acc.flagStatus"], "AC Evo race-event semantic derivation", "AC Evo flag-status projection."),
    "f1-2025": raceEventDerivedLink("f1-2025", "race.control.caution-kind", "enum", ["f1.safetyCarStatus", "f1.vehicleFIAFlags"], "F1 race-event semantic derivation", "F1 safety-car and flag projection."),
    iracing: raceEventDerivedLink("iracing", "race.control.caution-kind", "enum", ["iRacing.SessionFlags", "iRacing.SessionState"], "iRacing race-event semantic derivation", "iRacing session race-control projection."),
  });
  addDefinedVariable(variables, groups, "race.player.pit-state", {
    ...unavailable,
    acc: raceEventDerivedLink("acc", "race.player.pit-state", "enum", ["acc.pitStatus"], "ACC race-event semantic derivation", "ACC player pit-status projection."),
    "ac-evo": raceEventDerivedLink("ac-evo", "race.player.pit-state", "enum", ["acc.pitStatus"], "AC Evo race-event semantic derivation", "AC Evo player pit-status projection."),
    "f1-2025": raceEventDerivedLink("f1-2025", "race.player.pit-state", "enum", ["f1.pitStatus"], "F1 race-event semantic derivation", "F1 player pit-status projection."),
    iracing: raceEventDerivedLink("iracing", "race.player.pit-state", "enum", ["iRacing.OnPitRoad", "iRacing.PlayerCarInPitStall"], "iRacing race-event semantic derivation", "iRacing player pit-state projection."),
  });
  addDefinedVariable(variables, groups, "race.pit-service.lifecycle-status", {
    ...unavailable,
    iracing: raceEventDerivedLink("iracing", "race.pit-service.lifecycle-status", "enum", ["iRacing.PlayerCarPitSvStatus"], "iRacing race-event semantic derivation", "iRacing pit-service lifecycle projection."),
  });
  addDefinedVariable(variables, groups, "race.pit-service.tire-change-counts", {
    ...unavailable,
    iracing: raceEventDerivedLink("iracing", "race.pit-service.tire-change-counts", "count", ["iRacing.TireSetsUsed"], "iRacing race-event semantic derivation", "iRacing full-set tire-use projection; each native increment represents four tires.", "pit-snapshot"),
  });
  addDefinedVariable(variables, groups, "race.pit-service.repair-time-remaining", {
    ...unavailable,
    iracing: raceEventDerivedLink("iracing", "race.pit-service.repair-time-remaining", "s", ["iRacing.PitRepairLeft", "iRacing.PitOptRepairLeft"], "iRacing race-event semantic derivation", "iRacing mandatory and optional repair countdown projection."),
  });
  completeRaceEventRawSources(variables);
}

export function addCrossSourceProjections(
  variables: Map<string, CatalogVariable>,
  groups: Map<string, CatalogGroup>,
): void {
  const physicalSlipAngle = variables.get("tires.tire-slip-angle");
  const normalizedSlipAngle = variables.get(
    "tires.normalized-tire-slip-angle",
  );
  if (physicalSlipAngle && normalizedSlipAngle) {
    physicalSlipAngle.games["fm-2023"] = unavailable(
      "source-not-provided",
      "Forza exposes a normalized lateral-slip signal, not a physical slip angle in radians.",
    );
    const forzaSlipFields = [
      "TireSlipAngleFL",
      "TireSlipAngleFR",
      "TireSlipAngleRL",
      "TireSlipAngleRR",
    ];
    normalizedSlipAngle.packetFields = [
      ...new Set([
        ...(normalizedSlipAngle.packetFields ?? []),
        ...forzaSlipFields,
      ]),
    ];
    normalizedSlipAngle.games["fm-2023"] = {
      kind: "direct",
      nativeUnit: "ratio",
      sources: Object.fromEntries(
        ["FL", "FR", "RL", "RR"].map((wheel, index) => [
          wheel,
          [`ForzaDataOut.${forzaSlipFields[index]}`],
        ]),
      ),
      freshness: "continuous",
      description:
        "Forza provides source-normalized per-wheel lateral slip rather than a physical angle.",
    };
  }

  const lapsRemaining = variables.get("session.laps-remaining");
  if (lapsRemaining) {
    lapsRemaining.games.iracing = normalizedLink(
      "count",
      ["iRacing.SessionLapsRemainEx", "iRacing.SessionLapsRemain"],
      "prefer improved SessionLapsRemainEx; fallback to deprecated SessionLapsRemain",
      "RaceIQ can use improved iRacing laps-remaining value with legacy fallback.",
    );
  }

  const pitServicePressure = variables.get("race.pit-service.tire-pressure");
  if (pitServicePressure) {
    pitServicePressure.games.iracing = {
      kind: "direct",
      nativeUnit: "kPa",
      sources: {
        FL: ["iRacing.PitSvLFP"],
        FR: ["iRacing.PitSvRFP"],
        RL: ["iRacing.PitSvLRP"],
        RR: ["iRacing.PitSvRRP"],
      },
      freshness: "continuous",
      description:
        "iRacing exposes requested cold pressure separately for each pit-service tire.",
    };
  }

  const lapFraction = variables.get("timing.lap-fraction");
  if (lapFraction) {
    lapFraction.games["f1-2025"] = derivedLink(
      "m",
      ["TelemetryPacket.DistanceTraveled", "f1.trackLength"],
      "clamp current-lap distance / track length to 0-1",
      "RaceIQ can derive F1 lap fraction from native lap distance and track length.",
    );
    lapFraction.games["ac-evo"] = derivedLink(
      "m and km",
      ["TelemetryPacket.DistanceTraveled", "acc.acEvo.lapLengthKm"],
      "(session distance modulo (lap length km * 1000)) / (lap length km * 1000)",
      "RaceIQ can derive AC Evo lap fraction from integrated distance and lap length.",
    );
  }

  const compound = variables.get("tires.tire-compound");
  if (compound) {
    compound.games.acc = {
      kind: "simplified",
      nativeUnit: "text",
      sources: ["acc.tireCompound"],
      freshness: "continuous",
      normalization: "retain source compound name as common representation",
      description: "ACC common compound is projected from detailed source name.",
    };
    compound.games["ac-evo"] = {
      kind: "simplified",
      nativeUnit: "text",
      sources: ["acc.tireCompound"],
      freshness: "continuous",
      normalization: "retain source compound name as common representation",
      description: "AC Evo common compound is projected from detailed source name.",
    };
    compound.games.iracing = {
      kind: "simplified",
      nativeUnit: "id",
      sources: ["iRacing.PlayerTireCompound"],
      freshness: "continuous",
      normalization: "retain source compound code as common representation",
      description: "iRacing common compound is projected from detailed source code.",
    };
  }

  addDefinedVariable(variables, groups, "fuel.remaining-volume", {
    "fm-2023": unavailable(
      "source-not-provided",
      "Forza packet provides fuel fraction but no tank capacity, so litres cannot be derived safely.",
    ),
    "f1-2025": derivedLink(
      "fraction and L",
      ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
      "fuel fraction * fuel capacity",
      "RaceIQ derives F1 fuel volume from native fraction and capacity.",
    ),
    acc: {
      kind: "direct",
      nativeUnit: "L",
      sources: ["TelemetryPacket.Fuel"],
      freshness: "continuous",
      description: "ACC normalized packet retains source fuel litres.",
    },
    "ac-evo": {
      kind: "direct",
      nativeUnit: "L",
      sources: ["TelemetryPacket.Fuel"],
      freshness: "continuous",
      description: "AC Evo normalized packet retains source fuel litres.",
    },
    iracing: {
      kind: "direct",
      nativeUnit: "L",
      sources: ["TelemetryPacket.Fuel"],
      freshness: "continuous",
      description: "iRacing normalized packet retains SDK fuel litres.",
    },
  });

  const fuelPercent = variables.get("fuel.fuel-percent");
  if (fuelPercent) {
    fuelPercent.games["fm-2023"] = normalizedLink(
      "fraction",
      ["TelemetryPacket.Fuel"],
      "fraction * 100",
      "RaceIQ converts Forza fuel fraction to percentage.",
    );
    fuelPercent.games["f1-2025"] = normalizedLink(
      "fraction",
      ["TelemetryPacket.Fuel"],
      "fraction * 100",
      "RaceIQ converts F1 fuel fraction to percentage.",
    );
    for (const gameId of ["acc", "ac-evo"] as const) {
      fuelPercent.games[gameId] = derivedLink(
        "L",
        ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
        "fuel litres / capacity litres * 100",
        `RaceIQ derives ${gameId} fuel percentage from volume and capacity.`,
      );
    }
  }
}
