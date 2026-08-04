import { numberCorner, unnumberCorner } from "@shared/racing/tracks/curation/join";
import { useCallback } from "react";
import { client } from "@/lib/rpc";
import type { TrackSectors, TrackSegment } from "../types";

type Bounds = { s1End: number; s2End: number };
interface SegmentEditorOptions {
  trackOrdinal: number;
  gameId?: string;
  sectors: TrackSectors | null;
  setSectors: (value: TrackSectors | null) => void;
  sectorBounds: Bounds | null;
  setSectorBounds: (value: Bounds | null) => void;
  editSegments: TrackSegment[];
  setEditSegments: (value: TrackSegment[] | ((previous: TrackSegment[]) => TrackSegment[])) => void;
  setEditing: (value: boolean) => void;
  setSaving: (value: boolean) => void;
  editS1: number;
  editS2: number;
  setEditS1: (value: number) => void;
  setEditS2: (value: number) => void;
  setEditingSectors: (value: boolean) => void;
  setSavingSectors: (value: boolean) => void;
}

export function useTrackSegmentEditor(options: SegmentEditorOptions) {
  const {
    trackOrdinal,
    gameId,
    sectors,
    setSectors,
    sectorBounds,
    setSectorBounds,
    editSegments,
    setEditSegments,
    setEditing,
    setSaving,
    editS1,
    editS2,
    setEditS1,
    setEditS2,
    setEditingSectors,
    setSavingSectors,
  } = options;
  const startEditing = useCallback(() => {
    if (!sectors?.segments) return;
    let next = sectors.segments.map((s) => ({ ...s }));
    for (const s of next) {
      if (s.type !== "corner" || s.number != null) continue;
      const token = /^T(\d+)$/.exec((s.name ?? "").trim());
      if (token) s.number = Number(token[1]);
    }
    for (let i = 0; i < next.length; i++) if (next[i].type === "corner" && next[i].number == null) next = numberCorner(next, i);
    setEditSegments(next);
    setEditing(true);
  }, [sectors, setEditSegments, setEditing]);
  const updateSegFrac = useCallback(
    (idx: number, field: "startFrac" | "endFrac", value: number) => {
      setEditSegments((prev) => {
        const next = prev.map((s) => ({ ...s }));
        next[idx][field] = value;
        if (field === "endFrac" && idx + 1 < next.length) next[idx + 1].startFrac = value;
        if (field === "startFrac" && idx > 0) next[idx - 1].endFrac = value;
        return next;
      });
    },
    [setEditSegments],
  );
  const toggleSegType = useCallback(
    (idx: number) => {
      setEditSegments((prev) => {
        const next = prev.map((s) => ({ ...s }));
        const becomingCorner = next[idx].type !== "corner";
        next[idx].type = becomingCorner ? "corner" : "straight";
        next[idx].name = "";
        return becomingCorner ? numberCorner(next, idx) : unnumberCorner(next, idx);
      });
    },
    [setEditSegments],
  );
  const addSegment = useCallback(
    (afterIdx: number) => {
      setEditSegments((prev) => {
        const next = [...prev];
        const current = next[afterIdx];
        const midFrac = (current.startFrac + current.endFrac) / 2;
        const newType = current.type === "corner" ? "straight" : "corner";
        next[afterIdx] = { ...current, endFrac: midFrac };
        next.splice(afterIdx + 1, 0, { type: newType, name: "", startFrac: midFrac, endFrac: current.endFrac, startIdx: 0, endIdx: 0 });
        return newType === "corner" ? numberCorner(next, afterIdx + 1) : next;
      });
    },
    [setEditSegments],
  );
  const removeSegment = useCallback(
    (idx: number) => {
      setEditSegments((prev) => {
        if (prev.length <= 1) return prev;
        const next = [...prev];
        const removed = next.splice(idx, 1)[0];
        if (idx > 0) next[idx - 1] = { ...next[idx - 1], endFrac: removed.endFrac };
        else if (next.length > 0) next[0] = { ...next[0], startFrac: removed.startFrac };
        return next;
      });
    },
    [setEditSegments],
  );
  const saveSegments = useCallback(async () => {
    setSaving(true);
    try {
      const res = await client.api.tracks[":trackOrdinal"].segments.$put({ param: { trackOrdinal: String(trackOrdinal) }, query: { gameId }, json: { segments: editSegments } } as never);
      if (res.ok) {
        setSectors({ segments: editSegments, totalDist: sectors?.totalDist ?? 0 });
        setEditing(false);
      }
    } catch {}
    setSaving(false);
  }, [editSegments, gameId, sectors, setEditing, setSaving, setSectors, trackOrdinal]);
  const startEditingSectors = useCallback(() => {
    if (sectorBounds) {
      setEditS1(Math.round(sectorBounds.s1End * 1000) / 10);
      setEditS2(Math.round(sectorBounds.s2End * 1000) / 10);
    }
    setEditingSectors(true);
  }, [sectorBounds, setEditS1, setEditS2, setEditingSectors]);
  const saveSectorBounds = useCallback(async () => {
    setSavingSectors(true);
    try {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$put({
        param: { ordinal: String(trackOrdinal) },
        query: { gameId },
        json: { s1End: editS1 / 100, s2End: editS2 / 100 },
      } as never);
      if (res.ok) {
        setSectorBounds({ s1End: editS1 / 100, s2End: editS2 / 100 });
        setEditingSectors(false);
      }
    } catch {}
    setSavingSectors(false);
  }, [editS1, editS2, gameId, setEditingSectors, setSavingSectors, setSectorBounds, trackOrdinal]);
  return { startEditing, updateSegFrac, toggleSegType, addSegment, removeSegment, saveSegments, startEditingSectors, saveSectorBounds };
}
