// Derived projections, contract metadata, and source provenance enrichment.

export {
  addSectorDerivedVariables,
  addCrossSourceProjections,
} from "./derived-projections";
export {
  canonicalize,
  compareCatalogStrings,
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
  assertCatalogSemanticQuality,
} from "./contract-provenance";
