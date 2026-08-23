import { numberCorner, unnumberCorner } from "@shared/racing/tracks/curation/join";
import { logicalSegmentCounts } from "@shared/racing/tracks/segment-label";
import { getGame } from "@shared/games/registry";
import type { GameId } from "@shared/games/ids";
import type { TrackImagery, TrackImageryGeographicPoint } from "@shared/racing/tracks/imagery";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorFromResponse } from "@/lib/rpc-error";
import { client } from "@/lib/rpc";
import { queryKeys } from "@/hooks/query-keys";
import {
  useTrackBoundaries,
  useTrackCurbs,
  useTrackImagery,
  useTrackOutline,
  useTrackImageryReference,
  useTrackSectorBoundaries,
  useTrackSectors,
  useTrackTimingSectorLayout,
} from "@/hooks/track-queries";
import type { TrackTimingSectorLayout } from "@/hooks/track-queries";
import { isDevelopment } from "@/lib/env";
import type { PitLine } from "@/lib/canvas/draw-track";
import type { TrackInfo, TrackSectors, TrackSegment, Point, TrackBoundaries, TrackCurb } from "../types";

export interface TrackGeometryEditorModel {
  gameId: GameId | null;
  track: TrackInfo;
  outline: Point[] | null;
  labels: { text: string; x: number; z: number }[];
  pitLines: PitLine[];
  flipX: boolean;
  sectors: TrackSectors | null;
  segmentSource: string;
  boundaries: TrackBoundaries | null;
  curbs: TrackCurb[] | null;
  imagery: TrackImagery | null;
  imageryGeographicPositions: readonly (TrackImageryGeographicPoint | null)[] | null;
  outlineLoading: boolean;
  dataErrors: string[];
  cornerCount: number;
  straightCount: number;
  timingSectors: TrackTimingSectorLayout;
  timingSectorsLoading: boolean;
  timingSectorsError: Error | null;
  sectorBounds: { s1End: number; s2End: number } | null;
  editing: boolean;
  editSegments: TrackSegment[];
  saving: boolean;
  saveError: string | null;
  generatingSegments: boolean;
  generateSegmentsError: string | null;
  editingSectors: boolean;
  editS1: number;
  editS2: number;
  savingSectors: boolean;
  sectorSaveError: string | null;
  startEditing: () => void;
  cancelEditing: () => void;
  updateSegFrac: (index: number, field: "startFrac" | "endFrac", value: number) => void;
  toggleSegType: (index: number) => void;
  addSegment: (afterIndex: number) => void;
  removeSegment: (index: number) => void;
  saveSegments: () => Promise<void>;
  generateSegments: () => Promise<void>;
  startEditingSectors: () => void;
  cancelEditingSectors: () => void;
  setEditS1: (value: number) => void;
  setEditS2: (value: number) => void;
  saveSectorBounds: () => Promise<void>;
  setEditing: (value: boolean) => void;
  setEditingSectors: (value: boolean) => void;
}

function outlineParts(data: unknown): { outline: Point[] | null; labels: { text: string; x: number; z: number }[]; pitLines: PitLine[]; flipX: boolean } {
  if (Array.isArray(data)) return { outline: data as Point[], labels: [], pitLines: [], flipX: false };
  if (!data || typeof data !== "object") return { outline: null, labels: [], pitLines: [], flipX: false };
  const value = data as { points?: Point[]; labels?: { text: string; x: number; z: number }[]; pitLines?: PitLine[]; flipX?: boolean };
  return {
    outline: Array.isArray(value.points) ? value.points : null,
    labels: Array.isArray(value.labels) ? value.labels : [],
    pitLines: Array.isArray(value.pitLines) ? value.pitLines : [],
    flipX: value.flipX ?? false,
  };
}

function segmentCopy(sectors: TrackSectors | null): TrackSegment[] {
  if (!sectors?.segments) return [];
  let next = sectors.segments.map((segment) => ({ ...segment }));
  for (const segment of next) {
    if (segment.type !== "corner" || segment.number != null) continue;
    const token = /^T(\d+)$/.exec((segment.name ?? "").trim());
    if (token) segment.number = Number(token[1]);
  }
  for (let index = 0; index < next.length; index++) {
    if (next[index].type === "corner" && next[index].number == null) next = numberCorner(next, index);
  }
  return next;
}

export function useTrackGeometryEditor({ gameId, track }: { gameId: GameId | null; track: TrackInfo }): TrackGeometryEditorModel {
  const queryClient = useQueryClient();
  const nativeSectors = gameId ? getGame(gameId).nativeSectors : false;
  const outlineQuery = useTrackOutline(track.ordinal, gameId);
  const sectorsQuery = useTrackSectors(track.ordinal, gameId);
  const boundaryQuery = useTrackSectorBoundaries(track.ordinal, gameId, !nativeSectors);
  const boundariesQuery = useTrackBoundaries(track.ordinal, gameId);
  const curbsQuery = useTrackCurbs(track.ordinal, gameId);
  const imageryQuery = useTrackImagery(track.ordinal, gameId);
  const imageryReferenceQuery = useTrackImageryReference(track.ordinal, gameId, isDevelopment);
  const timingQuery = useTrackTimingSectorLayout({ gameId, trackOrdinal: track.ordinal });
  const [editing, setEditing] = useState(false);
  const [editSegments, setEditSegments] = useState<TrackSegment[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generatedSectors, setGeneratedSectors] = useState<(TrackSectors & { source?: string }) | null>(null);
  const [generatingSegments, setGeneratingSegments] = useState(false);
  const [generateSegmentsError, setGenerateSegmentsError] = useState<string | null>(null);
  const [editingSectors, setEditingSectors] = useState(false);
  const [editS1, setEditS1] = useState(33.3);
  const [editS2, setEditS2] = useState(66.6);
  const [savingSectors, setSavingSectors] = useState(false);
  const [sectorSaveError, setSectorSaveError] = useState<string | null>(null);
  const parts = useMemo(() => outlineParts(outlineQuery.data), [outlineQuery.data]);
  const queriedSectors = (sectorsQuery.data as (TrackSectors & { source?: string }) | null | undefined) ?? null;
  const sectors = generatedSectors ?? queriedSectors;
  const sectorBounds = (boundaryQuery.data as { s1End: number; s2End: number } | null | undefined) ?? null;
  const counts = logicalSegmentCounts(sectors?.segments ?? []);
  const dataErrors = [
    ["Outline", outlineQuery.error],
    ["Segments", sectorsQuery.error],
    ["Timing sectors", timingQuery.error],
    ["Boundaries", boundariesQuery.error],
    ["Curbs", curbsQuery.error],
    ["Imagery", imageryQuery.error],
    ["Imagery reference", imageryReferenceQuery.error],
  ].flatMap(([label, error]) => (error ? [`${label}: ${error instanceof Error ? error.message : String(error)}`] : []));

  useEffect(() => {
    setGeneratedSectors(null);
    setGenerateSegmentsError(null);
    setEditing(false);
  }, [gameId, track.ordinal]);

  const generateSegments = useCallback(async () => {
    if (!gameId) return;
    setGeneratingSegments(true);
    setGenerateSegmentsError(null);
    try {
      const response = await client.api.tracks[":trackOrdinal"].segments.generate.$post({
        param: { trackOrdinal: String(track.ordinal) },
        query: { gameId },
      } as never);
      if (!response.ok) throw await errorFromResponse(response);
      const generated = (await response.json()) as TrackSectors & { source?: string };
      if (generated.segments.length === 0) throw new Error("No segments could be generated from this track outline");
      setGeneratedSectors(generated);
      setEditSegments(segmentCopy(generated));
      setEditing(true);
    } catch (error) {
      setGenerateSegmentsError(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingSegments(false);
    }
  }, [gameId, track.ordinal]);

  const startEditing = useCallback(() => {
    setEditSegments(segmentCopy(sectors));
    setSaveError(null);
    setEditing(true);
  }, [sectors]);
  const cancelEditing = useCallback(() => {
    setEditing(false);
    setGeneratedSectors(null);
    setSaveError(null);
  }, []);
  const updateSegFrac = useCallback((index: number, field: "startFrac" | "endFrac", value: number) => {
    setEditSegments((previous) => {
      const next = previous.map((segment) => ({ ...segment }));
      if (!next[index]) return previous;
      next[index][field] = value;
      if (field === "endFrac" && next[index + 1]) next[index + 1].startFrac = value;
      if (field === "startFrac" && next[index - 1]) next[index - 1].endFrac = value;
      return next;
    });
  }, []);
  const toggleSegType = useCallback((index: number) => {
    setEditSegments((previous) => {
      if (!previous[index]) return previous;
      const next = previous.map((segment) => ({ ...segment }));
      const becomingCorner = next[index].type !== "corner";
      next[index].type = becomingCorner ? "corner" : "straight";
      next[index].name = "";
      return becomingCorner ? numberCorner(next, index) : unnumberCorner(next, index);
    });
  }, []);
  const addSegment = useCallback((afterIndex: number) => {
    setEditSegments((previous) => {
      const current = previous[afterIndex];
      if (!current) return previous;
      const next = [...previous];
      const midFrac = (current.startFrac + current.endFrac) / 2;
      const newType = current.type === "corner" ? "straight" : "corner";
      next[afterIndex] = { ...current, endFrac: midFrac };
      next.splice(afterIndex + 1, 0, { type: newType, name: "", startFrac: midFrac, endFrac: current.endFrac, startIdx: 0, endIdx: 0 });
      return newType === "corner" ? numberCorner(next, afterIndex + 1) : next;
    });
  }, []);
  const removeSegment = useCallback((index: number) => {
    setEditSegments((previous) => {
      if (previous.length <= 1 || !previous[index]) return previous;
      const next = [...previous];
      const removed = next.splice(index, 1)[0];
      if (index > 0) next[index - 1] = { ...next[index - 1], endFrac: removed.endFrac };
      else next[0] = { ...next[0], startFrac: removed.startFrac };
      return next;
    });
  }, []);
  const saveSegments = useCallback(async () => {
    if (!gameId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await client.api.tracks[":trackOrdinal"].segments.$put({
        param: { trackOrdinal: String(track.ordinal) },
        query: { gameId },
        json: { segments: editSegments },
      } as never);
      if (!response.ok) throw await errorFromResponse(response);
      await queryClient.invalidateQueries({ queryKey: queryKeys.trackSectors(track.ordinal) });
      setGeneratedSectors(null);
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [editSegments, gameId, queryClient, track.ordinal]);
  const startEditingSectors = useCallback(() => {
    if (!sectorBounds || !timingQuery.data.editable) return;
    setEditS1(Math.round(sectorBounds.s1End * 1000) / 10);
    setEditS2(Math.round(sectorBounds.s2End * 1000) / 10);
    setSectorSaveError(null);
    setEditingSectors(true);
  }, [sectorBounds, timingQuery.data.editable]);
  const cancelEditingSectors = useCallback(() => {
    setEditingSectors(false);
    setSectorSaveError(null);
  }, []);
  const saveSectorBounds = useCallback(async () => {
    if (!gameId || !timingQuery.data.editable) return;
    if (!(Number.isFinite(editS1) && Number.isFinite(editS2) && 0 < editS1 && editS1 < editS2 && editS2 < 100)) {
      setSectorSaveError("Sector boundaries must satisfy 0 < S1 < S2 < 100");
      return;
    }
    setSavingSectors(true);
    setSectorSaveError(null);
    try {
      const response = await client.api["track-sector-boundaries"][":ordinal"].$put({
        param: { ordinal: String(track.ordinal) },
        query: { gameId },
        json: { s1End: editS1 / 100, s2End: editS2 / 100 },
      } as never);
      if (!response.ok) throw await errorFromResponse(response);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.trackSectorBoundaries(track.ordinal) }),
        queryClient.invalidateQueries({ queryKey: ["track-native-sector-layout", gameId, track.ordinal] }),
      ]);
      setEditingSectors(false);
    } catch (error) {
      setSectorSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingSectors(false);
    }
  }, [editS1, editS2, gameId, queryClient, timingQuery.data.editable, track.ordinal]);

  return {
    gameId,
    track,
    outline: parts.outline,
    labels: parts.labels,
    pitLines: parts.pitLines,
    flipX: parts.flipX,
    sectors,
    segmentSource: generatedSectors?.source ?? queriedSectors?.source ?? "",
    boundaries: (boundariesQuery.data as TrackBoundaries | null | undefined) ?? null,
    curbs: (curbsQuery.data as TrackCurb[] | null | undefined) ?? null,
    imagery: imageryQuery.data ?? null,
    imageryGeographicPositions: imageryReferenceQuery.data?.geographicPositions ?? null,
    outlineLoading: outlineQuery.isLoading,
    dataErrors,
    cornerCount: counts.corners,
    straightCount: counts.straights,
    timingSectors: timingQuery.data,
    timingSectorsLoading: timingQuery.isLoading,
    timingSectorsError: timingQuery.error instanceof Error ? timingQuery.error : null,
    sectorBounds,
    editing,
    editSegments,
    saving,
    saveError,
    generatingSegments,
    generateSegmentsError,
    editingSectors,
    editS1,
    editS2,
    savingSectors,
    sectorSaveError,
    startEditing,
    cancelEditing,
    updateSegFrac,
    toggleSegType,
    addSegment,
    removeSegment,
    saveSegments,
    generateSegments,
    startEditingSectors,
    cancelEditingSectors,
    setEditS1,
    setEditS2,
    saveSectorBounds,
    setEditing,
    setEditingSectors,
  };
}
