// Only exact, reviewed venue/layout identities belong here. Shared names link
// physical track facts; they never substitute another game's road geometry.
const names: Readonly<Record<string, { displayName: string; commonTrackName: string }>> = {
  "brandshatch - brandshatch_indy": { displayName: "Brands Hatch Indy", commonTrackName: "brands-hatch-indy" },
};

export function ams2TrackNames(telemetryName: string) {
  const key = telemetryName.trim().toLowerCase();
  return Object.hasOwn(names, key) ? names[key] : undefined;
}
