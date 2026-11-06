/** Existing RaceIQ AMS2 identity: exact UTF-8 telemetry name, without case folding. */
export function ams2IdentityId(name: string): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(name)) hash = Math.imul(hash ^ byte, 16777619);
  return String((hash >>> 0) & 0x7fffffff || 1);
}
