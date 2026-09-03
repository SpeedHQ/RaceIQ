const LOAD_ARGS = ["--context-length", "131072", "--parallel", "4", "--yes"] as const;

export function candidateLifecycleCommands(modelIds: readonly string[], activeModel: string): string[][] {
  return [
    ...modelIds.filter((modelId) => modelId !== activeModel).map((modelId) => ["lms", "unload", modelId]),
    ["lms", "load", activeModel, ...LOAD_ARGS],
  ];
}
