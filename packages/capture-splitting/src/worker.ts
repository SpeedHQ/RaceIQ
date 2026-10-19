import { Effect, Schema } from "effect";
import { splitCapturePromise, verifyManifest } from "./index";
import { SplitRequestSchema, type SplitRequest, type WorkerMessage } from "./protocol";
type WorkerPayload =
  | Omit<Extract<WorkerMessage, { type: "progress" }>, "jobId" | "attemptId" | "sequence">
  | Omit<Extract<WorkerMessage, { type: "complete" }>, "jobId" | "attemptId" | "sequence">
  | Omit<Extract<WorkerMessage, { type: "failure" }>, "jobId" | "attemptId" | "sequence">;

interface SplitWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerMessage): void;
}
const scope = self as unknown as SplitWorkerScope;
scope.onmessage = (event: MessageEvent<unknown>) => {
  let request: SplitRequest;
  try {
    request = Schema.decodeUnknownSync(SplitRequestSchema)(event.data);
  } catch (error) {
    scope.postMessage({
      jobId: "invalid",
      attemptId: "invalid",
      sequence: 0,
      type: "failure",
      code: "PROTOCOL",
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerMessage);
    return;
  }
  if (request.source.revision !== request.sourceRevision) {
    scope.postMessage({
      jobId: request.jobId,
      attemptId: request.attemptId,
      sequence: 0,
      type: "failure",
      code: "SOURCE_REVISION",
      message: "Source descriptor revision does not match request revision",
    } satisfies WorkerMessage);
    return;
  }

  let sequence = 0;
  const send = (message: WorkerPayload) => {
    scope.postMessage({ ...message, jobId: request.jobId, attemptId: request.attemptId, sequence: sequence++ } satisfies WorkerMessage);
  };
  const run = async () => {
    try {
      const manifest = request.operation === "verify"
        ? await Bun.file(`${request.outputDirectory}/manifest.json`).json().then((value) =>
          Effect.runPromise(verifyManifest(request.source.path, request.outputDirectory, value, { sourceRevision: request.sourceRevision, gameId: request.gameId })),
        )
        : await splitCapturePromise({
          sourcePath: request.source.path,
          outputDirectory: request.outputDirectory,
          gameId: request.gameId,
          sourceRevision: request.sourceRevision,
          lapWindows: request.lapWindows,
          onProgress(progress) {
            send({ type: "progress", progress });
          },
        });
      send({ type: "complete", manifest });
    } catch (error) {
      const candidate = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
      const codes = ["IO", "FORMAT", "VERIFY", "GAME", "SOURCE_REVISION", "PROTOCOL", "UNKNOWN"] as const;
      send({
        type: "failure",
        code: codes.includes(candidate as typeof codes[number]) ? candidate : "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  void run();
};
