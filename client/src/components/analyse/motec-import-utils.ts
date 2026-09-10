export function formatMotecLapTime(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "—";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${remainingSeconds}`;
}

export function hasCompleteMotecSource(
  ld: File | null,
  ldx: File | null,
  stagedToken?: string,
): boolean {
  return Boolean(
    stagedToken ||
    (ld && (ld.name.toLowerCase().endsWith(".zip") || ldx)),
  );
}
