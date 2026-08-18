import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { TrackImageryCandidate, TrackImageryGeographicBounds, TrackImagerySourceSearchResult } from "../../../../shared/racing/tracks/imagery";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

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

interface TrackImagerySourceListProps {
  sources: TrackImagerySourceSearchResult["sources"];
  selectedCandidateId: string | null;
  onSelect: (candidate: TrackImageryCandidate) => void;
}

export function TrackImagerySourceList({ sources, selectedCandidateId, onSelect }: TrackImagerySourceListProps) {
  return (
    <div className="flex flex-col gap-1">
      {sources.map((source) => (
        <Collapsible key={source.id} defaultOpen={source.candidates.some((candidate) => candidate.id === selectedCandidateId)} className="overflow-hidden rounded">
          <CollapsibleTrigger render={<Button variant="default" size="content" className="group/source w-full justify-between px-2 py-2 text-left" />}>
            <span className="min-w-0 truncate font-semibold text-app-text">{source.name}</span>
            <span className="flex shrink-0 items-center gap-1">
              <Badge size="compact">
                {source.candidates.length} {source.candidates.length === 1 ? "image" : "images"}
              </Badge>
              <ChevronDownIcon data-icon="inline-end" className="transition-transform group-data-[state=open]/source:rotate-180" />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-1 rounded-b border-x border-b border-app-border bg-app-surface-alt p-1">
              {source.candidates.map((candidate) => {
                const selected = candidate.id === selectedCandidateId;
                const isHq = candidate.quality === "hq";
                return (
                  <Button key={candidate.id} variant={selected ? "imagery-option-selected" : "imagery-option"} size="content" aria-pressed={selected} onClick={() => onSelect(candidate)}>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-semibold text-app-text">{capturedAtLabel(candidate.capturedAt)}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {selected && (
                          <Badge variant="info" size="compact">
                            Selected
                          </Badge>
                        )}
                        <Badge variant={isHq ? "success" : "warning"} size="compact">
                          {isHq ? "HQ" : "Context"}
                        </Badge>
                      </span>
                    </span>
                    <span className="w-full truncate text-app-micro text-app-text-muted" title={candidate.title}>
                      {candidate.title}
                    </span>
                    <span className="w-full text-app-micro text-app-text-muted">
                      {candidate.sourceResolutionM.toFixed(candidate.sourceResolutionM < 1 ? 2 : 1)} m · {candidate.coverage} coverage ·{" "}
                      {candidate.cloudCoverPercent === undefined ? "cloud unknown" : `${candidate.cloudCoverPercent.toFixed(0)}% cloud`}
                    </span>
                  </Button>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
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
      {result && result.sources.length === 0 && <p className="text-[11px] text-severity-caution">No reusable imagery covers this GPS footprint.</p>}
      {result && result.sources.length > 0 && (
        <div className="mt-2">
          <TrackImagerySourceList
            sources={result.sources}
            selectedCandidateId={selectedCandidateId}
            onSelect={(candidate) => bounds && gameId && trackOrdinal != null && onSelect(candidate, openTrackImageryPreviewUrl(candidate.id, bounds, gameId, trackOrdinal))}
          />
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
