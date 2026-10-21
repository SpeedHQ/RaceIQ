// CLI argument parsing shared by catalog entrypoint.

export function baselineArgument(args: readonly string[]): string | undefined {
  const indexes = args.flatMap((argument, index) =>
    argument === "--baseline" ? [index] : [],
  );
  if (indexes.length > 1) {
    throw new Error("--baseline may only be specified once");
  }
  const index = indexes[0];
  if (index === undefined) return undefined;
  const path = args[index + 1];
  if (!path || path.startsWith("--")) {
    throw new Error("--baseline requires a telemetry catalog JSON path");
  }
  return path;
}
