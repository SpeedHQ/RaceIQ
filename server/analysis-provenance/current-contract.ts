import {
  analysisConfigurationHash,
  analysisContractHash,
} from "./hash";
import type { GameId } from "../../shared/games/ids";
import { RACE_EVENT_SCHEMA_VERSION } from "../../shared/racing/events/contracts";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import { QUALITY_POLICY_CONFIG_V1 } from "../../shared/racing/quality/policies";
import {
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  type AnalysisComponentIdentity,
} from "../../shared/racing/provenance/contracts";
import {
  SESSION_RUN_ALGORITHM_VERSION,
  SESSION_RUN_SCHEMA_VERSION,
} from "../../shared/racing/runs/contracts";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { tryGetServerGame } from "../games/registry";
import {
  INCIDENT_PENALTY_DETECTOR_ID,
  INCIDENT_PENALTY_DETECTOR_VERSION,
} from "../race-events/detectors/incident-penalty";
import {
  LAP_EVENT_DETECTOR_ID,
  LAP_EVENT_DETECTOR_VERSION,
} from "../race-events/detectors/lap";
import {
  PARTICIPANT_DETECTOR_ID,
  PARTICIPANT_DETECTOR_VERSION,
} from "../race-events/detectors/participant-driver";
import {
  PIT_SERVICE_DETECTOR_ID,
  PIT_SERVICE_DETECTOR_VERSION,
} from "../race-events/detectors/pit-service";
import {
  SESSION_RACE_CONTROL_DETECTOR_ID,
  SESSION_RACE_CONTROL_DETECTOR_VERSION,
} from "../race-events/detectors/session-race-control";
import {
  SOURCE_QUALITY_DETECTOR_ID,
  SOURCE_QUALITY_DETECTOR_VERSION,
} from "../race-events/detectors/source-quality";
import { RACE_RESULT_PROCESSOR_ID } from "../race-results/constants";
import { currentTelemetryVersionIdentity } from "../telemetry/pipeline-ports";


export interface CurrentAnalysisContract {
  telemetryVersion: TelemetryVersionIdentity;
  analysisComponents: AnalysisComponentIdentity[];
  effectiveConfiguration: unknown;
  configurationHash: `sha256:${string}`;
  contractHash: `sha256:${string}`;
}

export function currentAnalysisContract(
  gameId: GameId,
  sourceChannelProfile: SourceChannelProfile | null = null,
): CurrentAnalysisContract {
  const telemetryVersion = currentTelemetryVersionIdentity(gameId);
  const lapDetectorId = tryGetServerGame(gameId)?.lapDetectorId ?? "unknown";
  const analysisComponents: AnalysisComponentIdentity[] = [
    { id: "lap-detector", version: lapDetectorId, schemaVersion: null },
    { id: INCIDENT_PENALTY_DETECTOR_ID, version: INCIDENT_PENALTY_DETECTOR_VERSION, schemaVersion: RACE_EVENT_SCHEMA_VERSION },
    { id: LAP_EVENT_DETECTOR_ID, version: LAP_EVENT_DETECTOR_VERSION, schemaVersion: RACE_EVENT_SCHEMA_VERSION },
    { id: PARTICIPANT_DETECTOR_ID, version: PARTICIPANT_DETECTOR_VERSION, schemaVersion: RACE_EVENT_SCHEMA_VERSION },
    { id: PIT_SERVICE_DETECTOR_ID, version: PIT_SERVICE_DETECTOR_VERSION, schemaVersion: RACE_EVENT_SCHEMA_VERSION },
    { id: SESSION_RACE_CONTROL_DETECTOR_ID, version: SESSION_RACE_CONTROL_DETECTOR_VERSION, schemaVersion: RACE_EVENT_SCHEMA_VERSION },
    { id: SOURCE_QUALITY_DETECTOR_ID, version: SOURCE_QUALITY_DETECTOR_VERSION, schemaVersion: RACE_EVENT_SCHEMA_VERSION },
    { id: "race-result", version: RACE_RESULT_PROCESSOR_ID, schemaVersion: null },
    { id: "session-runs", version: SESSION_RUN_ALGORITHM_VERSION, schemaVersion: SESSION_RUN_SCHEMA_VERSION },
    { id: "quality", version: ELIGIBILITY_POLICY_VERSION, schemaVersion: QUALITY_SCHEMA_VERSION },
  ].sort((left, right) => left.id.localeCompare(right.id));
  const effectiveConfiguration = {
    quality: {
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      policy: QUALITY_POLICY_CONFIG_V1,
    },
    sourceChannelProfile,
  };
  const configurationHash = analysisConfigurationHash(effectiveConfiguration);
  const contractHash = analysisContractHash({
    receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
    telemetryVersion,
    analysisComponents,
  });
  return {
    telemetryVersion,
    analysisComponents,
    effectiveConfiguration,
    configurationHash,
    contractHash,
  };
}
