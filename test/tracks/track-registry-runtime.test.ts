import { describe, expect, test } from "bun:test";

import { getAcEvoTracks } from "../../shared/racing/tracks/catalogs/ac-evo";
import { getAccTracks } from "../../shared/racing/tracks/catalogs/acc";
import { getF1Tracks } from "../../shared/racing/tracks/catalogs/f1";
import { fmTrackCatalog } from "../../shared/racing/tracks/catalogs/fm";
import { getAllIRacingTracks } from "../../shared/racing/tracks/catalogs/iracing";
import { trackConfigurationCanonicalId } from "../../shared/racing/tracks/configuration";
import { getTrackRegistry, getTrackRegistryIndexes } from "../../shared/racing/tracks/registry";
import {
  listTrackConfigurations,
  loadTrackConfiguration,
  loadTrackConfigurationFactsSlug,
} from "../../server/tracks/configuration";
import type { GameId } from "../../shared/games/ids";

const catalogOrdinals: Record<GameId, number[]> = {
  "f1-2025": [...getF1Tracks().keys()],
  acc: [...getAccTracks().keys()],
  "ac-evo": [...getAcEvoTracks().keys()],
  "fm-2023": [...fmTrackCatalog.keys()],
  iracing: getAllIRacingTracks().map(({ ordinal }) => ordinal),
};

describe("generated track registry runtime contract", () => {
  test("preserves every existing game and track-ordinal assignment", () => {
    const indexes = getTrackRegistryIndexes();
    const missing = Object.entries(catalogOrdinals).flatMap(([gameId, ordinals]) =>
      ordinals
        .filter((ordinal) => !indexes.assignmentsByGame.get(gameId as GameId)?.has(ordinal))
        .map((ordinal) => `${gameId}/${ordinal}`),
    );
    expect(missing).toEqual([]);
  });

  test("in-memory configuration joins preserve every canonical layout and facts identity", () => {
    const registry = getTrackRegistry();
    const indexes = getTrackRegistryIndexes();
    expect(listTrackConfigurations()).toHaveLength(registry.assignments.length);

    for (const assignment of registry.assignments) {
      const configuration = loadTrackConfiguration(assignment.gameId, assignment.trackOrdinal);
      expect(configuration, `${assignment.gameId}/${assignment.trackOrdinal}`).not.toBeNull();
      expect(trackConfigurationCanonicalId(configuration!)).toBe(assignment.layoutId);
      expect(loadTrackConfigurationFactsSlug(assignment.gameId, assignment.trackOrdinal)).toBe(
        indexes.layoutsById.get(assignment.layoutId)?.factsSlug ?? null,
      );
    }
  });

  test("equivalent current Spa layouts share one canonical identity and facts roster", () => {
    const indexes = getTrackRegistryIndexes();
    const layoutId = indexes.assignmentsByGame.get("f1-2025")?.get(10)?.layoutId;
    expect(layoutId).toBe("circuit-de-spa-francorchamps/grand-prix");
    expect(indexes.layoutsById.get(layoutId!)?.factsSlug).toBe("spa");
    expect(
      [...(indexes.assignmentsByLayoutId.get(layoutId!) ?? [])]
        .map(({ gameId, trackOrdinal }) => `${gameId}/${trackOrdinal}`)
        .sort(),
    ).toEqual(["ac-evo/5", "acc/6", "f1-2025/10", "fm-2023/530", "iracing/523"]);
  });
});
