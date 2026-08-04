export function meterLevel(used: number, limit: number): "ok" | "warn" | "danger" {
  if (limit <= 0) return "ok";
  const fraction = used / limit;
  if (fraction >= 0.9) return "danger";
  if (fraction >= 0.7) return "warn";
  return "ok";
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(value);
}
