import type { TrackInfo } from "@/components/track/types";

export interface BaseTrack {
  key: string;
  name: string;
  layouts: TrackInfo[];
  primaryLayout: TrackInfo;
  baseImageUrl: string | null;
  lapCount: number;
  hasMap: boolean;
}

export function baseTrackKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function primaryLayoutScore(track: TrackInfo): number {
  const variant = track.variant.trim().toLocaleLowerCase();
  const name = track.name.trim().toLocaleLowerCase();
  const mainVariant = variant === name || /^(full( circuit| course)?|grand prix|gp|international|road course)$/.test(variant);
  return (track.hasOutline || track.hasMap ? 1_000_000 : 0) + (mainVariant ? 100_000 : 0) + Math.max(track.lengthKm, 0) * 1_000 - track.ordinal / 1_000_000;
}

export function groupBaseTracks(tracks: TrackInfo[]): BaseTrack[] {
  const grouped = new Map<string, TrackInfo[]>();

  for (const track of tracks) {
    const key = baseTrackKey(track.name) || `track-${track.ordinal}`;
    const layouts = grouped.get(key);
    if (layouts) layouts.push(track);
    else grouped.set(key, [track]);
  }

  return Array.from(grouped, ([key, unsortedLayouts]) => {
    const layouts = [...unsortedLayouts].sort((a, b) => a.variant.localeCompare(b.variant) || a.ordinal - b.ordinal);
    const primaryLayout = layouts.reduce((best, candidate) => (primaryLayoutScore(candidate) > primaryLayoutScore(best) ? candidate : best));
    const baseImageUrl = layouts.find((layout) => layout.baseImageUrl)?.baseImageUrl ?? null;

    return {
      key,
      name: primaryLayout.name,
      layouts,
      primaryLayout,
      baseImageUrl,
      lapCount: layouts.reduce((total, layout) => total + (layout.lapCount ?? 0), 0),
      hasMap: !!baseImageUrl || layouts.some((layout) => layout.hasOutline || layout.hasMap),
    };
  });
}
