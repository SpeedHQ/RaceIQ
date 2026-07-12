import { AppInput } from "@/components/ui/AppInput";
import { useCatalogTunes, useLaptimes, useResolveNames } from "@/hooks/queries";
import { useMemo, useState } from "react";

// Loose match: lowercase, collapse whitespace, drop trailing "*" (the
// community leaderboard sheet marks short/reverse variants this way).
function normalizeTrack(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/\*$/, "").trim();
}

export function TrackTunes({ trackName, trackVariant }: { trackName: string; trackVariant: string }) {
  const fullName = trackVariant ? `${trackName} ${trackVariant}`.trim() : trackName;
  const nameLower = fullName.toLowerCase();
  const trackNameLower = trackName.toLowerCase();
  const [carSearch, setCarSearch] = useState("");
  const [expandedTune, setExpandedTune] = useState<string | null>(null);

  const { data: catalog = [] } = useCatalogTunes();
  const { data: laptimes = [] } = useLaptimes();

  const allTunes = catalog.filter(
    (t) =>
      t.bestTracks?.some((bt) => {
        const btl = bt.toLowerCase();
        return btl.includes(nameLower) || nameLower.includes(btl) || btl.includes(trackNameLower) || trackNameLower.includes(btl);
      }) || t.category === "track-specific",
  );

  const carOrdinals = useMemo(() => [...new Set(allTunes.map((t) => t.carOrdinal))], [allTunes]);
  const { data: names } = useResolveNames([], carOrdinals);
  const carName = (ordinal: number) => names?.carNames[String(ordinal)] ?? `Car ${ordinal}`;

  const carQuery = carSearch.toLowerCase();
  const tunes = carQuery ? allTunes.filter((t) => carName(t.carOrdinal).toLowerCase().includes(carQuery)) : allTunes;

  // Reference-only leaderboard for this track — never joined onto a specific
  // tune, just shown alongside for context (car/track matching between the
  // scraped tune data and the leaderboard sheet isn't reliable enough for
  // a per-tune attribution).
  const trackNorm = normalizeTrack(fullName);
  const trackNorm2 = normalizeTrack(trackName);
  const leaderboard = laptimes.filter((e) => {
    const t = normalizeTrack(e.track);
    return t.includes(trackNorm) || trackNorm.includes(t) || t.includes(trackNorm2) || trackNorm2.includes(t);
  });
  const leaderboardRows = carQuery ? leaderboard.filter((e) => e.car.toLowerCase().includes(carQuery)) : leaderboard;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="text-app-label text-app-text-muted uppercase tracking-wider whitespace-nowrap">Tunes ({tunes.length})</div>
        <AppInput value={carSearch} onChange={(e) => setCarSearch(e.target.value)} placeholder="Search cars..." className="w-full max-w-xs" />
      </div>

      {tunes.length === 0 ? (
        <div className="text-center py-12 text-app-text-dim text-app-subtext">No tunes found{carSearch ? ` matching "${carSearch}"` : " for this track"}.</div>
      ) : (
        <div className="space-y-2">
          {tunes.map((tune) => {
            const isExpanded = expandedTune === tune.id;
            return (
              <div key={tune.id} className="rounded-lg bg-app-surface border border-app-border overflow-hidden">
                <button type="button" onClick={() => setExpandedTune(isExpanded ? null : tune.id)} className="w-full text-left p-3 hover:bg-app-surface-alt/30 transition-colors">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-app-heading text-app-text">{tune.name}</span>
                    <span
                      className={`text-app-unit font-semibold uppercase px-1.5 py-0.5 rounded ${
                        tune.category === "circuit"
                          ? "bg-blue-500/20 text-blue-400"
                          : tune.category === "wet"
                            ? "bg-cyan-500/20 text-cyan-400"
                            : tune.category === "low-drag"
                              ? "bg-red-500/20 text-red-400"
                              : tune.category === "stable"
                                ? "bg-green-500/20 text-green-400"
                                : "bg-orange-500/20 text-orange-400"
                      }`}
                    >
                      {tune.category}
                    </span>
                    <svg
                      className={`w-3.5 h-3.5 text-app-text-muted ml-auto shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      role="img"
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  <p className={`text-app-subtext text-app-text-secondary mt-1 ${isExpanded ? "" : "line-clamp-1"}`}>{tune.description}</p>
                </button>

                {isExpanded && (
                  <div className="px-3 pb-3 space-y-3 border-t border-app-border">
                    {/* Strengths & Weaknesses */}
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      <div>
                        <h4 className="text-app-label font-semibold uppercase tracking-wider text-green-400 mb-1">Strengths</h4>
                        <ul className="space-y-0.5">
                          {tune.strengths.map((s) => (
                            <li key={s} className="text-app-body text-app-text-secondary flex items-start gap-1.5">
                              <span className="text-green-400 mt-0.5">+</span> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h4 className="text-app-label font-semibold uppercase tracking-wider text-red-400 mb-1">Weaknesses</h4>
                        <ul className="space-y-0.5">
                          {tune.weaknesses.map((w) => (
                            <li key={w} className="text-app-body text-app-text-secondary flex items-start gap-1.5">
                              <span className="text-red-400 mt-0.5">-</span> {w}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    {/* Best Tracks */}
                    {tune.bestTracks && tune.bestTracks.length > 0 && (
                      <div>
                        <h4 className="text-app-label font-semibold uppercase tracking-wider text-app-text-muted mb-1">Best Tracks</h4>
                        <div className="flex flex-wrap gap-1">
                          {tune.bestTracks.map((bt) => (
                            <span key={bt} className="text-app-label px-2 py-0.5 rounded-full bg-app-surface-alt text-app-text-secondary border border-app-border">
                              {bt}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Tune Settings */}
                    <div>
                      <h4 className="text-app-label font-semibold uppercase tracking-wider text-app-text-muted mb-1">Settings</h4>
                      <div className="grid grid-cols-[1fr_auto_1fr_auto] gap-x-3 gap-y-1 text-app-body items-baseline">
                        <span className="text-app-text-muted">Front Pressure</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.tires.frontPressure.toFixed(2)} bar</span>
                        <span className="text-app-text-muted">Rear Pressure</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.tires.rearPressure.toFixed(2)} bar</span>
                        <span className="text-app-text-muted">Final Drive</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.gearing.finalDrive.toFixed(2)}</span>
                        <span className="text-app-text-muted">Front Camber</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.alignment.frontCamber.toFixed(1)}&deg;</span>
                        <span className="text-app-text-muted">Rear Camber</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.alignment.rearCamber.toFixed(1)}&deg;</span>
                        <span className="text-app-text-muted">Front ARB</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.antiRollBars.front.toFixed(1)}</span>
                        <span className="text-app-text-muted">Rear ARB</span>
                        <span className="font-mono text-app-text text-right">{tune.settings.antiRollBars.rear.toFixed(1)}</span>
                      </div>
                    </div>

                    <div className="text-app-label text-app-text-dim">by {tune.author}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {leaderboardRows.length > 0 && (
        <div className="mt-6">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Community Leaderboard ({leaderboardRows.length})</div>
          <div className="rounded-lg bg-app-surface border border-app-border overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 text-app-label text-app-text-dim uppercase tracking-wider border-b border-app-border">
              <span>Car</span>
              <span>Driver</span>
              <span className="text-right">Time</span>
            </div>
            {leaderboardRows.map((e, i) => (
              <div key={`${e.car}-${e.driver}-${e.laptime}-${i}`} className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 text-app-body border-b border-app-border last:border-b-0 even:bg-app-surface-alt">
                <span className="min-w-0 truncate text-app-text-secondary">{e.car}</span>
                <span className="text-app-text-muted">{e.driver || "—"}</span>
                <span className="font-mono text-amber-400 text-right">{e.laptime}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
