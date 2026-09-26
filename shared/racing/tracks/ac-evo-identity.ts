export function encodeAcEvoTrackId(track: string, configuration: string): string {
  return JSON.stringify([track, configuration]);
}

export function decodeAcEvoTrackId(trackId: string): [string, string] | null {
  try {
    const pair: unknown = JSON.parse(trackId);
    if (Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string")) {
      return [pair[0], pair[1]];
    }
  } catch {}
  return null;
}
