import { useEffect, useState } from "react";
import type { TrackImageryCandidate, TrackImageryGeographicBounds, TrackImagerySourceSearchResult } from "../../../../shared/racing/tracks/imagery";
import { Button } from "../ui/button";

interface OpenTrackImageryPickerProps {
  bounds: TrackImageryGeographicBounds | null;
  selectedCandidateId: string | null;
  onSelect: (candidate: TrackImageryCandidate, previewUrl: string) => void;
}

export function openTrackImageryPreviewUrl(candidateId: string, bounds: TrackImageryGeographicBounds): string {
  const query = new URLSearchParams({
    candidateId,
    west: String(bounds.west),
    south: String(bounds.south),
    east: String(bounds.east),
    north: String(bounds.north),
  });
  return `/api/dev/track-imagery/sources/preview?${query}`;
}

export function OpenTrackImageryPicker({ bounds, selectedCandidateId, onSelect }: OpenTrackImageryPickerProps) {
  const [result, setResult] = useState<TrackImagerySourceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [bounds]);

  const search = async () => {
    if (!bounds) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dev/track-imagery/sources/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bounds }),
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

  const hqCandidates = result?.candidates.filter((candidate) => candidate.quality === "hq") ?? [];
  return (
    <div className="mb-3 rounded border border-app-border bg-app-surface-alt p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-app-text-secondary">Open aerial imagery</div>
          <div className="text-[10px] text-app-text-muted">HQ imagery: USGS NAIP or OpenAerialMap, stored at source resolution.</div>
        </div>
        <Button type="button" onClick={() => void search()} disabled={!bounds || loading}>
          {loading ? "Searching…" : "Find imagery"}
        </Button>
      </div>
      {!bounds && <p className="text-[11px] text-severity-caution">Select a lap containing GPS coordinates.</p>}
      {result && hqCandidates.length === 0 && <p className="mb-1 text-[11px] text-severity-caution">No free HQ image fully covers this track.</p>}
      {result?.candidates.length === 0 && <p className="text-[11px] text-severity-caution">No reusable open imagery covers this GPS footprint.</p>}
      {hqCandidates.length > 0 && (
        <div className="mt-2 space-y-1">
          {hqCandidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={`w-full rounded border px-2 py-1.5 text-left text-[11px] ${
                selectedCandidateId === candidate.id ? "border-app-accent bg-app-accent/10 text-app-text" : "border-app-border bg-app-surface text-app-text-secondary hover:border-app-border-input"
              }`}
              onClick={() => bounds && onSelect(candidate, openTrackImageryPreviewUrl(candidate.id, bounds))}
            >
              <span className="mr-2 inline-flex rounded bg-severity-nominal/15 px-1 font-mono text-[9px] font-semibold uppercase text-severity-nominal">HQ</span>
              <span>{candidate.title}</span>
              {candidate.resolutionM && <span className="ml-2 text-app-text-muted">{candidate.resolutionM.toFixed(candidate.resolutionM < 1 ? 1 : 0)} m</span>}
            </button>
          ))}
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
