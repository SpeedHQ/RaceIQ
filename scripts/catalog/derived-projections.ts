// Derived sector and cross-source catalog projections.

import { GAME_IDS } from "./model";
import type {
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

export
function addCrossSourceProjections(
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
          [`TelemetryPacket.${forzaSlipFields[index]}`],
        ]),
      ),
      freshness: "continuous",
      description:
        "Uses TelemetryPacket per-wheel normalized lateral slip; parser provenance: ForzaDataOut.TireSlipAngleFL/FR/RL/RR.",
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
  const fuelCapacity = variables.get("fuel.capacity");
  const iracingCapacity = fuelCapacity?.games.iracing;
  if (fuelCapacity && iracingCapacity && iracingCapacity.kind !== "unavailable") {
    const sessionSources = Array.isArray(iracingCapacity.sources)
      ? iracingCapacity.sources
      : Object.values(iracingCapacity.sources).flat();
    fuelCapacity.games.iracing = {
      kind: "direct",
      nativeUnit: "L",
      sources: [
        "TelemetryPacket.FuelCapacity",
        ...sessionSources.filter(
          (source) => source !== "TelemetryPacket.FuelCapacity",
        ),
      ],
      freshness: "session-update",
      description:
        "Uses normalized packet fuel capacity first and SessionInfo capacity when packet value is absent.",
    };
  }


  addDefinedVariable(
    variables,
    groups,
    "fuel.remaining-volume",
    unavailableGames("No fuel-volume representation is currently available."),
  );
  const remainingVolume = variables.get("fuel.remaining-volume")!;
  if (remainingVolume.games["fm-2023"].kind === "unavailable") {
    remainingVolume.games["fm-2023"] = unavailable(
      "source-not-provided",
      "Forza packet provides fuel fraction but no tank capacity, so litres cannot be derived safely.",
    );
  }
  if (remainingVolume.games["f1-2025"].kind === "unavailable") {
    remainingVolume.games["f1-2025"] = derivedLink(
      "fraction and L",
      ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
      "fuel remaining fraction * fuel capacity",
      "RaceIQ derives F1 fuel volume from native fraction and capacity.",
    );
  }

  addDefinedVariable(
    variables,
    groups,
    "fuel.remaining-fraction",
    unavailableGames("No fuel-fraction representation is currently available."),
  );
  const remainingFraction = variables.get("fuel.remaining-fraction")!;
  for (const gameId of ["acc", "ac-evo"] as const) {
    if (remainingFraction.games[gameId].kind !== "unavailable") continue;
    remainingFraction.games[gameId] = derivedLink(
      "L",
      ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
      "fuel remaining volume / fuel capacity",
      `RaceIQ derives ${gameId} fuel fraction from volume and capacity.`,
    );
  }
  remainingFraction.games.iracing = normalizedLink(
    "fraction or L",
    [
      "iRacing.FuelLevelPct",
      "TelemetryPacket.Fuel",
      "TelemetryPacket.FuelCapacity",
    ],
    "use FuelLevelPct when available; otherwise divide fuel remaining volume by fuel capacity",
    "RaceIQ prefers iRacing's live fuel fraction and falls back to packet volume/capacity only when the live channel is absent.",
  );


  addDefinedVariable(
    variables,
    groups,
    "fuel.remaining-percent",
    unavailableGames("No fuel-percentage representation is currently available."),
  );
  const remainingPercent = variables.get("fuel.remaining-percent")!;
  const percentSources: Record<GameId, string[]> = {
    "fm-2023": ["TelemetryPacket.Fuel"],
    "f1-2025": ["TelemetryPacket.Fuel"],
    acc: ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
    "ac-evo": ["TelemetryPacket.Fuel", "TelemetryPacket.FuelCapacity"],
    iracing: ["iRacing.FuelLevelPct"],
  };
  for (const gameId of GAME_IDS) {
    if (remainingPercent.games[gameId].kind !== "unavailable") continue;
    remainingPercent.games[gameId] = derivedLink(
      "fraction",
      percentSources[gameId],
      "fuel remaining fraction * 100",
      gameId === "iracing"
        ? "RaceIQ prefers iRacing's direct FuelLevelPct fraction over a volume/capacity fallback."
        : `RaceIQ derives ${gameId} fuel percentage from its canonical fraction.`,
    );
  }
}
