import { ChevronDownIcon } from "lucide-react";
import type { GameId } from "../../../../../shared/games/ids";
import type { TrackImageryCandidate, TrackImageryGeographicBounds, TrackImagerySourceSearchResult } from "../../../../../shared/racing/tracks/imagery";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui/collapsible";
import { useImageryCandidates } from "./useImageryCandidates";

interface ImageryCandidatePanelProps {
  bounds: TrackImageryGeographicBounds | null;
  gameId: GameId | null;
  trackOrdinal: number | null;
  selectedCandidateId: string | null;
  onSelect: (candidate: TrackImageryCandidate, previewUrl: string) => void;
}

function capturedAtLabel(value: string | undefined): string {
  if (!value) return "date unknown";
  const dates = value.split("/").map((part) => {
    const parsed = new Date(part);
    return Number.isNaN(parsed.valueOf()) ? part : parsed.toLocaleDateString();
  });
  return dates.join(" – ");
}

interface ImageryCandidateListProps {
  sources: TrackImagerySourceSearchResult["sources"];
  selectedCandidateId: string | null;
  onSelect: (candidate: TrackImageryCandidate) => void;
}

export function ImageryCandidateList({ sources, selectedCandidateId, onSelect }: ImageryCandidateListProps) {
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
                  <Button
                    key={candidate.id}
                    variant={selected ? "app-primary" : "app-outline"}
                    size="content"
                    className="w-full flex-col items-stretch gap-1 px-2 py-2 text-left"
                    aria-pressed={selected}
                    onClick={() => onSelect(candidate)}
                  >
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

export function ImageryCandidatePanel({ bounds, gameId, trackOrdinal, selectedCandidateId, onSelect }: ImageryCandidatePanelProps) {
  const candidates = useImageryCandidates({ bounds, gameId, trackOrdinal });

  return (
    <div className="mb-3 rounded border border-app-border bg-app-surface-alt p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-app-text-secondary">Open aerial imagery</div>
          <div className="text-app-caption text-app-text-muted">Ranked reusable imagery. HQ package sources preferred; context fallback remains manually selectable.</div>
        </div>
        <Button type="button" onClick={() => void candidates.search()} disabled={!bounds || !gameId || trackOrdinal == null || candidates.loading}>
          {candidates.loading ? "Searching…" : "Find imagery"}
        </Button>
      </div>
      {!gameId || trackOrdinal == null ? (
        <p className="text-app-compact text-severity-caution">Select game and track before searching.</p>
      ) : !bounds ? (
        <p className="text-app-compact text-severity-caution">Select a lap containing GPS coordinates.</p>
      ) : null}
      {candidates.result && candidates.result.sources.length === 0 && <p className="text-app-compact text-severity-caution">No reusable imagery covers this GPS footprint.</p>}
      {candidates.result && candidates.result.sources.length > 0 && (
        <div className="mt-2">
          <ImageryCandidateList
            sources={candidates.result.sources}
            selectedCandidateId={selectedCandidateId}
            onSelect={(candidate) => {
              const previewUrl = candidates.previewUrl(candidate.id);
              if (previewUrl) onSelect(candidate, previewUrl);
            }}
          />
        </div>
      )}
      {candidates.result?.notices.map((notice) => (
        <p key={notice} className="mt-1 text-app-caption text-app-text-muted">
          {notice}
        </p>
      ))}
      {candidates.error && <p className="mt-1 text-app-compact text-severity-critical">{candidates.error}</p>}
    </div>
  );
}
