import type { RaceResultEvidence, RaceResultProvenance } from "@raceiq/shared/racing/results/types";

export const evidence: RaceResultEvidence = {
  fieldStatus: {
    sessionType: "direct",
    classification: "direct",
    finishingPosition: "direct",
    qualifyingPosition: "direct",
    isPodium: "derived",
    isFastestLap: "derived",
    pitEvents: "derived",
    tyreStrategy: "simplified",
    fuelStrategy: "unavailable",
  },
  conflicts: [],
};
export const provenance: RaceResultProvenance = {
  catalogVersion: "catalog-7",
  catalogHash: "sha256:catalog",
  catalogSchemaVersion: "schema-2",
  parserVersion: "f1-parser-3",
  resolverVersion: "resolver-4",
  derivationId: "race-result-derivation",
  derivationVersion: "3",
  derivationCodeHash: "sha256:derivation",
  rawInput: { objectId: "session.bin", contentHash: "sha256:raw", byteOffset: 64, byteLength: 128 },
  authorityPolicyId: "race-result-outcome-authority",
  authorityPolicyVersion: "1",
};
