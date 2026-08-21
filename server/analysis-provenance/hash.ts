import { createHash } from "node:crypto";

import { canonicalJson } from "../../shared/core/canonical-json";
import type { AnalysisComponentIdentity } from "../../shared/racing/provenance/contracts";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";

export function analysisCanonicalHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function analysisConfigurationHash(effectiveConfiguration: unknown): `sha256:${string}` {
  return analysisCanonicalHash(effectiveConfiguration);
}

export function analysisContractHash(input: {
  receiptSchemaVersion: string;
  telemetryVersion: TelemetryVersionIdentity;
  analysisComponents: readonly AnalysisComponentIdentity[];
}): `sha256:${string}` {
  return analysisCanonicalHash({
    receiptSchemaVersion: input.receiptSchemaVersion,
    telemetryVersion: input.telemetryVersion,
    analysisComponents: [...input.analysisComponents].sort((left, right) => left.id.localeCompare(right.id)),
  });
}
