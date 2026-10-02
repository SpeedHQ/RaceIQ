// Composed semantic definitions; spread order is catalog insertion order.
import {
  CATEGORY_META,
  DESCRIPTION_OVERRIDES,
  TIRE_IDS,
  semanticDefinition,
} from "./semantic-metadata";
import { SEMANTIC_DEFINITIONS_LIVE } from "./semantic-definitions-live";
import { SEMANTIC_DEFINITIONS_COMPETITOR } from "./semantic-definitions-competitor";
import { SEMANTIC_DEFINITIONS_EXTENDED } from "./semantic-definitions-extended";
import type { SemanticDefinition } from "./model";

const SEMANTIC_DEFINITIONS: Record<string, SemanticDefinition> = {
  ...SEMANTIC_DEFINITIONS_LIVE,
  ...SEMANTIC_DEFINITIONS_COMPETITOR,
  ...SEMANTIC_DEFINITIONS_EXTENDED,
};

export {
  semanticDefinition,
  CATEGORY_META,
  DESCRIPTION_OVERRIDES,
  TIRE_IDS,
  SEMANTIC_DEFINITIONS,
};
