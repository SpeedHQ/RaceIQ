import { fetchText, sleep } from "../../lib/http";
import { runPool } from "../../lib/pool";
import { F1LAPS, SetupRecord } from "./types";

const HEADERS = { "User-Agent": "RaceIQ-SetupScraper/1.0 (racing telemetry app)" };

function parseSetupValues(html: string, labelMap: Record<string, RegExp>): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [key, expression] of Object.entries(labelMap)) {
    const match = html.match(expression);
    result[key] = match ? parseFloat(match[1]) : null;
  }
  return result;
}

function extractUuids(html: string, slug: string): string[] {
  const expression = new RegExp(`href="/f1-25/setups/${slug}/([0-9a-f-]{36})/"`, "gi");
  const uuids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = expression.exec(html)) !== null) uuids.add(match[1]);
  return [...uuids];
}

export function parseDetail(html: string): SetupRecord {
  function val(label: string): number | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(
      escaped + `\\s*</dt>\\s*<dd[^>]*>[\\s\\S]*?</dd>\\s*<dd[^>]*>\\s*(-?\\d+\\.?\\d*)[^<]*</dd>`, "i",
    ));
    return match ? parseFloat(match[1]) : null;
  }

  const teamMatch = html.match(/<dd>((?:McLaren|Red Bull Racing|Ferrari|Mercedes|Aston Martin|Alpine|Williams|Haas F1 Team|Kick Sauber|RB|F1 Custom Team)[^<]*)<\/dd>/i);
  const authorMatch = html.match(/setup[^"]*by\s+(\w+)/i);
  const lapMatch = html.match(/(\d:\d{2}\.\d{3})/);
  const sessionType = /time.?trial/i.test(html) ? "Time Trial" : /qualifying/i.test(html) ? "Qualifying" : /\brace\b/i.test(html) ? "Race" : "Time Trial";
  const inputDevice = /&nbsp;Controller/i.test(html) ? "controller" : /&nbsp;Wheel/i.test(html) ? "wheel" : "";

  return {
    team: teamMatch?.[1]?.trim() ?? "",
    author: authorMatch?.[1] ?? "",
    lapTime: lapMatch?.[1] ?? "",
    sessionType,
    inputDevice,
    weather: /&nbsp;Wet/i.test(html) ? "Wet" : "Dry",
    setup: parseSetupValues(html, {
      frontWing: /Front Wing\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearWing: /Rear Wing\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      diffOnThrottle: /Differential Adjustment On Throttle\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      diffOffThrottle: /Differential Adjustment Off Throttle\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontCamber: /Front Camber\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearCamber: /Rear Camber\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontToe: /Front Toe\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearToe: /Rear Toe\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontSuspension: /Front Suspension\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearSuspension: /Rear Suspension\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontAntiRollBar: /Front Anti-Roll Bar\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearAntiRollBar: /Rear Anti-Roll Bar\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontRideHeight: /Front Ride Height\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearRideHeight: /Rear Ride Height\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      brakePressure: /Break Pressure\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontBrakeBias: /Front Break Bias\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontRightTyrePressure: /Front Right Tyre Pressure\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      frontLeftTyrePressure: /Front Left Tyre Pressure\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearRightTyrePressure: /Rear Right Tyre Pressure\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
      rearLeftTyrePressure: /Rear Left Tyre Pressure\s*<\/dt>[\s\S]*?<dd[^>]*>[\s\S]*?<\/dd>\s*<dd[^>]*>\s*(-?\d+\.?\d*)/i,
    }),
  };
}

export async function scrape(slug: string): Promise<SetupRecord[]> {
  const [dryHtml, wetHtml] = await Promise.all([
    fetchText(`${F1LAPS}/f1-25/setups/${slug}/`, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) }),
    fetchText(`${F1LAPS}/f1-25/setups/${slug}/wet/`, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) }).catch(() => ""),
  ]);
  const dryUuids = extractUuids(dryHtml, slug);
  const wetUuids = extractUuids(wetHtml, slug);
  const allUuids = [...new Set([...dryUuids, ...wetUuids])];
  const wetSet = new Set(wetUuids.filter(uuid => !dryUuids.includes(uuid)));
  const results: SetupRecord[] = [];
  await runPool(allUuids, 3, async uuid => {
    try {
      const url = `${F1LAPS}/f1-25/setups/${slug}/${uuid}/`;
      const parsed = parseDetail(await fetchText(url, { headers: HEADERS, retries: 3, retryDelayMs: attempt => 2000 * (attempt + 1) }));
      if (wetSet.has(uuid) && parsed.weather === "Dry") parsed.weather = "Wet";
      results.push({ ...parsed, source: url, provider: "f1laps" });
    } catch { /* preserve per-setup skip */ }
    await sleep(300);
  });
  return results;
}
