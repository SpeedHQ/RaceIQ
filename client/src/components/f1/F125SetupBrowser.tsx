import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { F125SetupValues } from "@/components/f1/f125-setup-groups";
import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useUiStore } from "@/stores/ui";

interface F125Setup {
  team: string;
  author: string;
  lapTime: string;
  sessionType: string;
  inputDevice: string;
  weather: string;
  provider: string;
  setup: Record<string, number | null>;
}

interface F125TrackSetups {
  trackSlug: string;
  trackName: string;
  trackId: string;
  setups: F125Setup[];
}

const SOURCE_KEYS: Pick<SourceTab, "key">[] = [{ key: "all" }];

const SOURCE_LABELS: Record<string, () => string> = {
  all: m.browser_all,
};

// "1:23.456" | "83.456" -> seconds
function parseLap(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) : 0) * 60 + Number(m[2]);
}

export function F125SetupBrowser() {
  const uiLocale = useUiStore((s) => s.uiLocale);
  const { data: tracks = [] } = useQuery<F125TrackSetups[]>({
    queryKey: ["f125-setups", "all"],
    queryFn: () => client.api["f1-25"].setups.$get({ query: {} }).then((r) => r.json() as unknown as F125TrackSetups[]),
  });

  const { rows, carNames, trackNames } = useMemo(() => {
    const carNames: Record<string, string> = {};
    const trackNames: Record<string, string> = {};
    const rows: TuneRow[] = [];
    for (const t of tracks) {
      trackNames[t.trackId] = t.trackName;
      t.setups?.forEach((s, i) => {
        const team = s.team || "Unknown";
        carNames[team] = team;
        rows.push({
          key: `${t.trackSlug}-${i}`,
          id: `${t.trackSlug}-${i}`,
          dbId: null,
          name: s.author || team,
          author: s.author || s.provider || "—",
          source: "community",
          category: (s.weather || "").toLowerCase() === "wet" ? "wet" : "dry",
          carId: team,
          trackId: t.trackId,
          lapTimeSec: parseLap(s.lapTime),
          lapTimeRaw: s.lapTime || null,
          lapTimeTrack: t.trackName,
          description: [s.inputDevice, s.provider].filter(Boolean).join(" · "),
          sessionType: s.sessionType,
          settings: s.setup,
        });
      });
    }
    return { rows, carNames, trackNames };
  }, [tracks]);

  const trackOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.trackId != null) counts.set(row.trackId, (counts.get(row.trackId) ?? 0) + 1);
    const options = [...counts.entries()].map(([id, count]) => ({ value: id, label: trackNames[id] ?? id, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: m.setup_any_track(), count: rows.length }, ...options];
  }, [rows, trackNames, uiLocale]);

  const carOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.carId, (counts.get(row.carId) ?? 0) + 1);
    const options = [...counts.entries()].map(([id, count]) => ({ value: id, label: carNames[id] ?? id, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: m.setup_any_car(), count: rows.length }, ...options];
  }, [rows, carNames, uiLocale]);

  const sources: SourceTab[] = useMemo(() => SOURCE_KEYS.map((s) => ({ ...s, label: SOURCE_LABELS[s.key]() })), [uiLocale]);

  return (
    <SetupBrowser
      rows={rows}
      carNames={carNames}
      trackNames={trackNames}
      trackOptions={trackOptions}
      carOptions={carOptions}
      sources={sources}
      renderSettings={(row: TuneRow) => <F125SetupValues setup={row.settings as Record<string, number | null>} />}
      readOnly
    />
  );
}
