let configuredResolver: (() => string) | undefined;

export function configureOnlineRuntime(options: { resolveDataDir: () => string }): void {
  configuredResolver = options.resolveDataDir;
}

export function resolveOnlineDataDir(): string {
  const configuredDataDir = process.env.DATA_DIR;
  if (configuredDataDir) return configuredDataDir;
  if (configuredResolver) return configuredResolver();
  throw new Error("Online runtime data directory has not been configured");
}
