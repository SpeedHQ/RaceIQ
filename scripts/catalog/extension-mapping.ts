// Compatibility facade for extension, iRacing, and setup mappings.
import {
  NORMALIZED_SEMANTIC_ALIASES, normalizedSemantic, addSource, extensionFields, extensionFieldSets, addExtensionVariable,
} from "./extension-field-mapping";
import {
  EXTENSION_ALIASES, EXTENSION_METADATA, UNAVAILABLE_EXTENSION_SOURCES, unavailableExtensionSource, extensionMetadata, extensionAlias, unavailableGames, appendNormalization,
} from "./extension-metadata";
import {
  iRacingFreshness, generalizeIRacingDescription, canonicalIRacingUnit, inferredIRacingUnit, IRACING_SDK_ALIASES, IRACING_YAML_ALIASES, addIRacingYamlField, addIRacingRawYamlSource,
} from "./iracing-mapping";
import { addSetupFileVariable, addDefinedVariable, derivedLink, normalizedLink } from "./setup-link-mapping";

export {
  NORMALIZED_SEMANTIC_ALIASES, normalizedSemantic, addSource, extensionFields, extensionFieldSets,
  EXTENSION_ALIASES, EXTENSION_METADATA, UNAVAILABLE_EXTENSION_SOURCES, unavailableExtensionSource, extensionMetadata, extensionAlias, unavailableGames, appendNormalization,
  addExtensionVariable, iRacingFreshness, generalizeIRacingDescription, canonicalIRacingUnit, inferredIRacingUnit,
  IRACING_SDK_ALIASES, IRACING_YAML_ALIASES, addIRacingYamlField, addIRacingRawYamlSource, addSetupFileVariable, addDefinedVariable, derivedLink, normalizedLink,
};
