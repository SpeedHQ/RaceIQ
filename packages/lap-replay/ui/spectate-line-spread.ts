import type { ReplayLineSpread as LineSpreadTrace } from "../contracts/host"

/** Mean lateral spread over the distance covered in the trailing replay second. */
export function windowLineSpread(trace: LineSpreadTrace | null | undefined, start: number, end: number): number | null {
  if (!trace || trace.lapCount < 2 || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const { fracs, spreadM } = trace;
  if (fracs.length < 2 || fracs.length !== spreadM.length || start < fracs[0] || end > fracs[fracs.length - 1]) return null;
  let area = 0;
  for (let i = 1; i < fracs.length; i++) {
    const left = fracs[i - 1], right = fracs[i];
    if (right < start) continue;
    if (left > end) break;
    const a = Math.max(start, left), b = Math.min(end, right);
    const from = spreadM[i - 1], to = spreadM[i];
    if (!(right > left) || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) return null;
    const at = (fraction: number) => from + (to - from) * (fraction - left) / (right - left);
    if (start === end) return at(start);
    area += (at(a) + at(b)) * (b - a) / 2;
  }
  return end > start ? area / (end - start) : null;
}
