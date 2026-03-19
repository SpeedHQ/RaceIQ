import type { TelemetryPacket } from "../../shared/types";
import { generateExport } from "../export";
import { getCarName, getTrackName } from "../../shared/car-data";
import { buildCornerData } from "./corner-data";

interface CornerDef {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
}

const SYSTEM_PROMPT = `You are an expert Forza Motorsport racing engineer and driving coach. Analyse the telemetry data provided and give specific, actionable feedback.

Your response MUST follow this exact structure using markdown headers:

## Performance Summary
2-3 sentences assessing the overall lap quality — pace, consistency, and where the biggest time gains are hiding.

## Strengths
3-5 bullet points of what the driver did well. Reference specific telemetry values (speeds, percentages, corner names).

## Weaknesses
3-5 bullet points of areas for improvement. Be specific — cite corner names, speeds, brake/throttle percentages.

## Problem Corners
For each of the top 3-5 corners where time is being lost:
- **Corner name**: What's wrong and how to fix it (braking point, line, gear choice, exit speed).

## Driving Technique
3-5 actionable tips based on the telemetry patterns (trail braking, throttle modulation, racing line, gear selection, etc.).

## Tuning Recommendations
3-5 specific tuning changes based on the telemetry data (suspension, aero, gearing, differential, tire pressure). Explain the symptom you see in the data and the tuning change that addresses it.

RULES:
- Reference specific numbers from the data — don't be vague
- Be specific and actionable, not generic
- Keep total output under 800 words
- Use markdown formatting
- Address the driver as "you"`;

export function buildAnalystPrompt(
  lap: {
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    carOrdinal?: number;
    trackOrdinal?: number;
  },
  packets: TelemetryPacket[],
  corners: CornerDef[]
): string {
  const carName = getCarName(lap.carOrdinal ?? packets[0]?.CarOrdinal ?? 0);
  const trackName = getTrackName(lap.trackOrdinal ?? 0);

  const exportText = generateExport(lap, packets);
  const cornerData = buildCornerData(packets, corners);

  const context = `Car: ${carName}
Track: ${trackName}

${exportText}
${cornerData}`;

  return `${SYSTEM_PROMPT}

--- TELEMETRY DATA ---

${context}`;
}
