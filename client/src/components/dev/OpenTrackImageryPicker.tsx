import { useEffect, useState } from "react";
import type { TrackImageryCandidate, TrackImageryGeographicBounds, TrackImagerySourceSearchResult } from "../../../../shared/racing/tracks/imagery";
import { Button } from "../ui/button";

interface OpenTrackImageryPickerProps {
  bounds: TrackImageryGeographicBounds | null;
  gameId: string | null;
  trackOrdinal: number | null;
  selectedCandidateId: string | null;
  onSelect: (candidate: TrackImageryCandidate, previewUrl: string) => void;
}

export function openTrackImageryPreviewUrl(candidateId: string, bounds: TrackImageryGeographicBounds, gameId: string, trackOrdinal: number): string {
  const query = new URLSearchParams({
    candidateId,
    gameId,
    trackOrdinal: String(trackOrdinal),
    west: String(bounds.west),
    south: String(bounds.south),
    east: String(bounds.east),
    north: String(bounds.north),
  });
  return `/api/dev/track-imagery/sources/preview?${query}`;
}

function capturedAtLabel(value: string | undefined): string {
  if (!value) return "date unknown";
  const dates = value.split("/").map((part) => {
    const parsed = new Date(part);
    return Number.isNaN(parsed.valueOf()) ? part : parsed.toLocaleDateString();
  });
  return dates.join(" – ");
}

export function OpenTrackImageryPicker({ bounds, gameId, trackOrdinal, selectedCandidateId, onSelect }: OpenTrackImageryPickerProps) {
  const [result, setResult] = useState<TrackImagerySourceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [bounds, gameId, trackOrdinal]);

  const search = async () => {
    if (!bounds || !gameId || trackOrdinal == null) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dev/track-imagery/sources/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bounds, gameId, trackOrdinal }),
      });
      const payload = (await response.json()) as TrackImagerySourceSearchResult | { error?: string };
      if (!response.ok) throw new Error((payload as { error?: string }).error ?? "Unable to search open imagery");
      setResult(payload as TrackImagerySourceSearchResult);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Unable to search open imagery");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mb-3 rounded border border-app-border bg-app-surface-alt p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-app-text-secondary">Open aerial imagery</div>
          <div className="text-[10px] text-app-text-muted">Ranked reusable imagery. HQ package sources preferred; context fallback remains manually selectable.</div>
        </div>
        <Button type="button" onClick={() => void search()} disabled={!bounds || !gameId || trackOrdinal == null || loading}>
          {loading ? "Searching…" : "Find imagery"}
        </Button>
      </div>
      {!gameId || trackOrdinal == null ? (
        <p className="text-[11px] text-severity-caution">Select game and track before searching.</p>
      ) : !bounds ? (
        <p className="text-[11px] text-severity-caution">Select a lap containing GPS coordinates.</p>
      ) : null}
      {result && result.candidates.length === 0 && <p className="text-[11px] text-severity-caution">No reusable imagery covers this GPS footprint.</p>}
      {result && result.candidates.length > 0 && (
        <div className="mt-2 space-y-1">
          {result.candidates.map((candidate) => {
            const isHq = candidate.quality === "hq";
            return (
              <button
                key={candidate.id}
                type="button"
                className={`w-full rounded border px-2 py-1.5 text-left text-[11px] ${
                  selectedCandidateId === candidate.id ? "border-app-accent bg-app-accent/10 text-app-text" : "border-app-border bg-app-surface text-app-text-secondary hover:border-app-border-input"
                }`}
                onClick={() => bounds && gameId && trackOrdinal != null && onSelect(candidate, openTrackImageryPreviewUrl(candidate.id, bounds, gameId, trackOrdinal))}
              >
                <span
                  className={`mr-2 inline-flex rounded px-1 font-mono text-[9px] font-semibold uppercase ${isHq ? "bg-severity-nominal/15 text-severity-nominal" : "bg-severity-caution/20 text-severity-caution"}`}
                >
                  {isHq ? "HQ" : "Context fallback"}
                </span>
                <span>{candidate.title}</span>
                <span className="ml-2 text-app-text-muted">{candidate.provider}</span>
                <div className="mt-1 text-[10px] text-app-text-muted">
                  {candidate.sourceResolutionM.toFixed(candidate.sourceResolutionM < 1 ? 2 : 1)} m · {candidate.coverage} coverage · {capturedAtLabel(candidate.capturedAt)} ·{" "}
                  {candidate.cloudCoverPercent === undefined ? "cloud unknown" : `${candidate.cloudCoverPercent.toFixed(0)}% cloud`}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {result?.notices.map((notice) => (
        <p key={notice} className="mt-1 text-[10px] text-app-text-muted">
          {notice}
        </p>
      ))}
      {error && <p className="mt-1 text-[11px] text-severity-critical">{error}</p>}
    </div>
  );
}
