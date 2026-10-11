export function acEvoCarId(name: string): string {
  return name.trim();
}

export function acEvoTrackId(name: string, configuration: string): string {
  return JSON.stringify([name.trim(), configuration.trim()]);
}

export function parseAcEvoTrackId(id: string): { trackName: string; trackConfiguration: string } | undefined {
  try {
    const value: unknown = JSON.parse(id);
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") return undefined;
    return { trackName: value[0], trackConfiguration: value[1] };
  } catch {
    return undefined;
  }
}
