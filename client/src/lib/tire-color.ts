/** Map a temperature value to a color using the provided thresholds. */
export function getTireColor(temp: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (temp < thresholds.cold) return "#3b82f6";  // blue — cold
  if (temp < thresholds.warm) return "#34d399";  // green — optimal
  return "#ef4444";                              // red — hot
}
