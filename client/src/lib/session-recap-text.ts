import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

function formatRecapDelta(seconds: number): string {
  return `${seconds >= 0 ? "-" : "+"}${Math.abs(seconds).toFixed(3)}`;
}

function formatRecapDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatRecapDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

export function buildRecapText(recap: SessionRecap): string {
  const lines: string[] = [`RaceIQ — ${recap.trackName} · ${recap.carName}`];
  const best = recap.bestLapSec;
  const personalBest = recap.personalBest;
  const bestPart = best != null ? `${m.recap_text_best()} ${formatLapTime(best)}` : null;
  const personalBestPart = personalBest?.isNew !== true ? null : personalBest.previousBestSec != null && best != null ? `${m.recap_new_pb()}, ${formatRecapDelta(personalBest.previousBestSec - best)}` : `${m.recap_new_pb()}, ${m.recap_new_pb_first_ever()}`;
  const lapsLine = [`${recap.lapsValid} ${m.recap_text_laps()}`, bestPart ? (personalBestPart ? `${bestPart} (${personalBestPart})` : bestPart) : null].filter(Boolean).join(" · ");
  if (lapsLine) lines.push(lapsLine);
  if (recap.theoretical != null) lines.push(`${m.recap_text_theoretical()} ${formatLapTime(recap.theoretical.sumSec)} (${recap.theoretical.deltaToBestSec.toFixed(1)}s ${m.recap_left_on_table()})`);
  const tailParts: string[] = [];
  if (recap.consistency != null) tailParts.push(`${m.recap_text_consistency()} ${recap.consistency.rating}★`);
  if (recap.distanceM != null) tailParts.push(formatRecapDistance(recap.distanceM));
  tailParts.push(`${formatRecapDuration(recap.timeOnTrackSec)} ${m.recap_text_on_track()}`);
  if (tailParts.length > 0) lines.push(tailParts.join(" · "));
  return lines.join("\n");
}
