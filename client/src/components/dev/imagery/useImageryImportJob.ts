import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameId } from "../../../../../shared/games/ids";
import type {
  TrackImageryCalibration,
  TrackImageryCandidate,
  TrackImageryGeographicBounds,
  TrackImageryOutputBudget,
  TrackImagerySource,
  TrackImageryVenueManifest,
} from "../../../../../shared/racing/tracks/imagery";
import { estimateImageryCandidate, imageryWorkbenchQueryKeys, importImageryCandidate } from "./imagery-api";

interface UseImageryImportJobOptions {
  gameId: GameId;
  trackOrdinal: number;
  venueId: string;
  bounds: TrackImageryGeographicBounds | null;
}

function candidateSource(candidate: TrackImageryCandidate): TrackImagerySource {
  return {
    name: candidate.title,
    url: candidate.sourceUrl,
    ...(candidate.capturedAt ? { capturedAt: candidate.capturedAt } : {}),
    license: candidate.license,
    attribution: candidate.attribution,
    provider: candidate.provider,
    quality: candidate.quality,
    coverage: candidate.coverage,
    sourceResolutionM: candidate.sourceResolutionM,
    storedResolutionM: Math.max(candidate.sourceResolutionM, 0.1),
    geographicReliability: candidate.geographicReliability,
    ...(candidate.cloudCoverPercent === undefined ? {} : { cloudCoverPercent: candidate.cloudCoverPercent }),
    providerStability: candidate.providerStability,
    redistribution: candidate.redistribution,
  };
}

export function useImageryImportJob({ gameId, trackOrdinal, venueId, bounds }: UseImageryImportJobOptions) {
  const queryClient = useQueryClient();
  const [selectedCandidate, setSelectedCandidate] = useState<TrackImageryCandidate | null>(null);
  const [budget, setBudget] = useState<TrackImageryOutputBudget | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const estimateRequestRef = useRef(0);

  const clear = useCallback(() => {
    estimateRequestRef.current += 1;
    setSelectedCandidate(null);
    setBudget(null);
    setPreviewUrl(null);
    setEstimating(false);
    setStatus(null);
    setError(null);
  }, []);

  useEffect(() => {
    clear();
    setImporting(false);
  }, [bounds, clear, gameId, trackOrdinal, venueId]);

  const selectCandidate = useCallback(
    async (candidate: TrackImageryCandidate, candidatePreviewUrl: string): Promise<{ candidate: TrackImageryCandidate; source: TrackImagerySource } | null> => {
      if (!bounds || !venueId) {
        setError("Calibration reference needs at least two valid GPS positions and an assigned venue.");
        return null;
      }
      const requestId = estimateRequestRef.current + 1;
      estimateRequestRef.current = requestId;
      setSelectedCandidate(null);
      setPreviewUrl(null);
      setBudget(null);
      setEstimating(true);
      setError(null);
      setStatus("Calculating complete output budget…");
      try {
        const result = await estimateImageryCandidate({ candidateId: candidate.id, bounds, venueId, gameId, trackOrdinal });
        if (estimateRequestRef.current !== requestId) return null;
        setBudget(result.budget);
        if (!result.budget.safe) {
          setStatus(null);
          setError(`Import rejected before source download: ${result.budget.problems.join("; ")}`);
          return null;
        }
        setSelectedCandidate(result.candidate);
        setPreviewUrl(candidatePreviewUrl);
        setStatus(`${result.candidate.quality === "hq" ? "HQ" : "Context fallback"} imagery selected. Inspect reference alignment, then import.`);
        return { candidate: result.candidate, source: candidateSource(result.candidate) };
      } catch (estimateError) {
        if (estimateRequestRef.current === requestId) {
          setStatus(null);
          setError(estimateError instanceof Error ? estimateError.message : "Unable to estimate open imagery output");
        }
        return null;
      } finally {
        if (estimateRequestRef.current === requestId) setEstimating(false);
      }
    },
    [bounds, gameId, trackOrdinal, venueId],
  );

  const importSelected = useCallback(
    async (calibration: TrackImageryCalibration): Promise<TrackImageryVenueManifest | null> => {
      if (!selectedCandidate || !bounds || !venueId) return null;
      setImporting(true);
      setError(null);
      try {
        const savedVenue = await importImageryCandidate(venueId, {
          candidateId: selectedCandidate.id,
          bounds,
          calibration,
          gameId,
          trackOrdinal,
        });
        queryClient.setQueryData(imageryWorkbenchQueryKeys.venue(venueId), savedVenue);
        return savedVenue;
      } catch (importError) {
        setError(importError instanceof Error ? importError.message : "Unable to save venue base");
        return null;
      } finally {
        setImporting(false);
      }
    },
    [bounds, gameId, queryClient, selectedCandidate, trackOrdinal, venueId],
  );

  const source = useMemo(() => (selectedCandidate ? candidateSource(selectedCandidate) : null), [selectedCandidate]);

  return {
    selectedCandidate,
    budget,
    previewUrl,
    source,
    estimating,
    importing,
    pending: estimating || importing,
    status,
    error,
    selectCandidate,
    importSelected,
    clear,
  };
}
