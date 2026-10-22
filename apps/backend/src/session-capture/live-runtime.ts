import { createLiveCaptureWorker } from "./live-worker-factory";
import { configureLiveCaptureWorkerFactory } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { registerLiveCaptureRecoveryReplay } from "@raceiq/backend-core/session-capture/live-recovery";
import { replayLiveCaptureTail } from "./live-recovery";

/** Bind host codecs before telemetry ingress or startup capture recovery begins. */
export function configureLiveCaptureRuntime(): void {
  configureLiveCaptureWorkerFactory(createLiveCaptureWorker);
  registerLiveCaptureRecoveryReplay(replayLiveCaptureTail);
}
