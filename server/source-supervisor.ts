export interface SupervisedTelemetrySource {
  start(): void;
  stop(): Promise<void>;
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function stopSource(
  source: SupervisedTelemetrySource,
  label: string,
): void {
  try {
    source.stop().catch((error) => {
      console.error(
        `[Server] ${label} source stop failed:`,
        errorMessage(error),
      );
    });
  } catch (error) {
    console.error(
      `[Server] ${label} source stop failed:`,
      errorMessage(error),
    );
  }
}

export function superviseSource<R extends SupervisedTelemetrySource>(
  running: boolean,
  label: string,
  factory: () => R,
  getCurrent: () => R | null,
  setCurrent: (source: R | null) => void,
): void {
  const current = getCurrent();
  if (running && !current) {
    console.log(
      `[Server] ${label} process detected — starting telemetry source`,
    );
    let source: R | null = null;
    try {
      source = factory();
      source.start();
      setCurrent(source);
    } catch (error) {
      console.error(
        `[Server] ${label} source start failed:`,
        errorMessage(error),
      );
      setCurrent(null);
      if (source) stopSource(source, label);
    }
  } else if (!running && current) {
    console.log(
      `[Server] ${label} process lost — stopping telemetry source`,
    );
    setCurrent(null);
    stopSource(current, label);
  }
}
