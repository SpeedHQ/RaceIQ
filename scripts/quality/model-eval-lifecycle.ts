const LOAD_ARGS = ["--context-length", "131072", "--parallel", "1", "--yes"] as const;

export function candidateLifecycleCommands(_modelIds: readonly string[], activeModel: string): string[][] {
  return [
    ["lms", "unload", "--all"],
    ["lms", "load", activeModel, ...LOAD_ARGS],
  ];
}
