// Derived projections, contract metadata, and source provenance enrichment.

export {
  addSectorDerivedVariables,
  addCrossSourceProjections,
  addRaceEventSemanticProjections,
} from "./derived-projections";
export {
  canonicalize,
  contentHash,
  telemetryCatalogSourceHash,
  ENUM_DOMAINS,
  dimensionForUnit,
  scalarValueTypeFor,
  valueTypeFor,
  structuredSchemaFor,
  cardinalityFor,
  rangeForUnit,
} from "./contract-inference";
export {
  mappingArtifact,
  enrichCatalogContracts,
} from "./contract-provenance";
