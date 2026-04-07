/** Map a temperature value to a color using the provided thresholds. */
export function getTireColor(temp: number, thresholds: { cold: number; warm: number; hot: number }): string {
  if (temp < thresholds.cold) return "#3b82f6";  // blue — cold
  if (temp < thresholds.warm) return "#34d399";  // green — optimal
  return "#ef4444";                              // red — hot
}

/** Get a human-readable temp condition label + color. */
export function getTireTempLabel(temp: number, thresholds: { cold: number; warm: number; hot: number }): { label: string; color: string } {
  if (temp < thresholds.cold) return { label: "COLD", color: "#3b82f6" };
  if (temp < thresholds.warm) return { label: "OPT", color: "#34d399" };
  return { label: "HOT", color: "#ef4444" };
}
