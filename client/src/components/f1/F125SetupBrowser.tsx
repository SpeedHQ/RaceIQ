import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import type { ComboOption } from "@/components/tune/browser/ComboBox";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import { client } from "@/lib/rpc";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

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
  trackOrdinal: number;
  setups: F125Setup[];
}

const SOURCES: SourceTab[] = [{ key: "all", label: "All" }];

// "1:23.456" | "83.456" -> seconds
function parseLap(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) : 0) * 60 + Number(m[2]);
}

function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function F125SettingsPanel({ settings }: { settings: Record<string, number | null> }) {
  const entries = Object.entries(settings).filter(([, v]) => v != null);
  if (entries.length === 0) return <div className="text-app-text-dim text-xs">No setup values.</div>;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-2 border-b border-app-border py-1">
          <span className="text-[12px] text-app-text-muted truncate">{humanize(k)}</span>
          <span className="text-[12px] font-mono font-semibold text-app-accent tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function F125SetupBrowser() {
  const { data: tracks = [] } = useQuery<F125TrackSetups[]>({
    queryKey: ["f125-setups", "all"],
    queryFn: () => client.api["f1-25"].setups.$get({ query: {} }).then((r) => r.json() as unknown as F125TrackSetups[]),
  });

  const { rows, carNames, trackNames } = useMemo(() => {
    const teamOrdinals = new Map<string, number>();
    const carNames: Record<number, string> = {};
    const trackNames: Record<number, string> = {};
    const rows: TuneRow[] = [];

    for (const t of tracks) {
      if (t.trackOrdinal != null) trackNames[t.trackOrdinal] = t.trackName;
      t.setups?.forEach((s, i) => {
        const team = s.team || "Unknown";
        let ord = teamOrdinals.get(team);
        if (ord == null) {
          ord = teamOrdinals.size;
          teamOrdinals.set(team, ord);
          carNames[ord] = team;
        }
        rows.push({
          key: `${t.trackSlug}-${i}`,
          id: `${t.trackSlug}-${i}`,
          dbId: null,
          name: s.author || team,
          author: s.author || s.provider || "—",
          source: "community",
          category: (s.weather || "").toLowerCase() === "wet" ? "wet" : "dry",
          carOrdinal: ord,
          trackOrdinal: t.trackOrdinal ?? null,
          lapTimeSec: parseLap(s.lapTime),
          lapTimeRaw: s.lapTime || null,
          lapTimeTrack: t.trackName,
          description: [s.sessionType, s.inputDevice, s.provider].filter(Boolean).join(" · "),
          settings: s.setup,
        });
      });
    }
    return { rows, carNames, trackNames };
  }, [tracks]);

  const trackOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) if (r.trackOrdinal != null) counts.set(r.trackOrdinal, (counts.get(r.trackOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: trackNames[ord] ?? `Track ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any track", count: rows.length }, ...opts];
  }, [rows, trackNames]);

  const carOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.carOrdinal, (counts.get(r.carOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: carNames[ord] ?? `Team ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any team", count: rows.length }, ...opts];
  }, [rows, carNames]);

  return (
    <SetupBrowser
      rows={rows}
      carNames={carNames}
      trackNames={trackNames}
      trackOptions={trackOptions}
      carOptions={carOptions}
      sources={SOURCES}
      renderSettings={(row: TuneRow) => <F125SettingsPanel settings={row.settings as Record<string, number | null>} />}
      readOnly
    />
  );
}
