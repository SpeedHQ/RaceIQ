// Only exact, reviewed venue/layout identities belong here. Shared names link
// physical track facts; they never substitute another game's road geometry.
import { findAMS2TrackByTelemetryName } from "./catalog";

export function ams2TrackNames(telemetryName: string) {
  const track=findAMS2TrackByTelemetryName(telemetryName);
  return track ? {displayName:track.name,commonTrackName:track.commonTrackName ?? undefined} : undefined;
}
