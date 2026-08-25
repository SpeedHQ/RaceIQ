import type { TuneIssue } from "@shared/racing/tuning/issues";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { Button } from "@/components/ui/button";
import type { PitLine } from "@/lib/canvas/draw-track";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { advanceLiveTrackPosition, type LiveTrackSample, liveTrackSampleFromView } from "./live-track-sample";
import { drawLiveTrack, type Point, type TrackBoundaryData } from "./draw-live-track";

interface Props {
  view: LiveTelemetryView | null;
  /** Live Tuning Dashboard issues positioned by canonical lap fraction. */
  issues?: TuneIssue[];
}

export function LiveTrackMap({ view, issues }: Props) {
  const sample = useMemo(() => (view ? liveTrackSampleFromView(view) : null), [view]);
  const gameId = sample?.simulator ?? null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [pitLines, setPitLines] = useState<PitLine[]>([]);
  const [noOutline, setNoOutline] = useState(false);
  const [isRecorded, setIsRecorded] = useState(false); // true = Forza coords, can plot directly
  const [startYaw, setStartYaw] = useState<number | null>(null); // Yaw at start/finish line
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const [boundaries, setBoundaries] = useState<TrackBoundaryData | null>(null);
  const lastTrackOrdRef = useRef<number | null>(null);

  // Distance-based position tracking
  const lapDistRef = useRef<{ startDist: number; totalDist: number; lastLap: number }>({
    startDist: 0,
    totalDist: 0,
    lastLap: -1,
  });

  // Live trace: build outline from driving data when no pre-made outline exists.
  const liveTraceRef = useRef<Point[]>([]);
  const lastTracePos = useRef<Point | null>(null);
  const deadReckonedPosRef = useRef<Point | null>(null);
  const previousSampleRef = useRef<LiveTrackSample | null>(null);
  const deadReckonedLapRef = useRef<number | null>(null);
  const traceMinDist = 3;

  // Auto-detect track changes from canonical identity and fetch outline.
  useEffect(() => {
    if (sample?.trackOrdinal === undefined) return;
    const trackOrd = sample.trackOrdinal;
    if (trackOrd === lastTrackOrdRef.current) return;
    lastTrackOrdRef.current = trackOrd;

    // Reset state for new track
    liveTraceRef.current = [];
    lastTracePos.current = null;
    deadReckonedPosRef.current = null;
    previousSampleRef.current = null;
    deadReckonedLapRef.current = null;
    lapDistRef.current = { startDist: 0, totalDist: 0, lastLap: -1 };
    setOutline(null);
    setPitLines([]);
    setNoOutline(false);
    setSectors(null);
    setBoundaries(null);

    if (!gameId) return;

    // Fetch sector boundaries
    client.api["track-sector-boundaries"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrd) }, query: { gameId: gameId! } })
      .then((r) => r.json() as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .then((data: any) => {
        if (data?.s1End) setSectors(data);
      }) // eslint-disable-line @typescript-eslint/no-explicit-any
      .catch(() => {});

    // Fetch track boundaries (edges)
    client.api["track-boundaries"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrd) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .then((data: any) => {
        if (data) setBoundaries(data);
      }) // eslint-disable-line @typescript-eslint/no-explicit-any
      .catch(() => {});

    client.api["track-outline"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrd) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .then((data: any) => {
        // eslint-disable-line @typescript-eslint/no-explicit-any
        if (data.points && Array.isArray(data.points)) {
          setOutline(data.points);
          setPitLines(Array.isArray(data.pitLines) ? data.pitLines : []);
          setIsRecorded(!!data.recorded);
          setStartYaw(data.startYaw ?? null);
        } else if (Array.isArray(data)) {
          setOutline(data);
          setPitLines([]);
          setIsRecorded(false);
          setStartYaw(null);
        } else {
          throw new Error("invalid format");
        }
        setNoOutline(false);
      })
      .catch(() => {
        setOutline(null);
        setPitLines([]);
        setIsRecorded(false);
        setStartYaw(null);
        setNoOutline(true);
      });
  }, [gameId, sample?.trackOrdinal]);

  // Re-fetch outline on lap completion if we don't have a recorded one yet.
  // The server may have just recorded the first lap trace.
  // Also re-fetch boundaries (calibration may have completed after a lap).
  useEffect(() => {
    if (!sample) return;
    const trackOrd = lastTrackOrdRef.current;
    if (trackOrd === null) return;

    if (!gameId) return;
    if (!isRecorded) {
      client.api["track-outline"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrd) }, query: { gameId: gameId ?? undefined } })
        .then((r) => r.json() as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .then((data: any) => {
          if (data?.points && Array.isArray(data.points)) {
            setOutline(data.points);
            setPitLines(Array.isArray(data.pitLines) ? data.pitLines : []);
            setIsRecorded(!!data.recorded);
            setStartYaw(data.startYaw ?? null);
            setNoOutline(false);
          }
        })
        .catch(() => {});
    }

    // Re-fetch boundaries — calibration may now provide game-space coords
    // Boundary state is intentionally not an effect dependency: a response
    // must not trigger another fetch before the next lap checks calibration.
    if (!boundaries || (boundaries.coordSystem !== "forza" && boundaries.coordSystem !== "f1-2025")) {
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrd) }, query: { gameId: gameId ?? undefined } })
        .then((r) => r.json() as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .then((data: any) => {
          if (data) setBoundaries(data);
        }) // eslint-disable-line @typescript-eslint/no-explicit-any
        .catch(() => {});
    }
  }, [gameId, isRecorded, sample?.lapNumber]);

  // Track distance at lap boundaries for position estimation
  useEffect(() => {
    if (sample?.lapNumber === undefined || sample.distanceM === undefined) return;
    const distance = lapDistRef.current;
    if (sample.lapNumber !== distance.lastLap) {
      if (distance.lastLap >= 0 && distance.startDist > 0) {
        const completedDistanceM = sample.distanceM - distance.startDist;
        if (completedDistanceM > 50) distance.totalDist = completedDistanceM;
      }
      distance.startDist = sample.distanceM;
      distance.lastLap = sample.lapNumber;
    }
  }, [sample?.distanceM, sample?.lapNumber]);

  // Build a live trace from canonical world position when available. When it is
  // unavailable, dead-reckon from canonical speed and yaw without simulator switches.
  useEffect(() => {
    if (!sample) return;
    let position = sample.positionM ?? null;
    if (!position && sample.yawRad !== undefined && sample.speedMps !== undefined) {
      const previousSample = previousSampleRef.current;
      const lapChanged = deadReckonedLapRef.current !== null && deadReckonedLapRef.current !== sample.lapNumber;
      if (!deadReckonedPosRef.current || lapChanged) {
        deadReckonedPosRef.current = { x: 0, z: 0 };
        liveTraceRef.current = [];
        lastTracePos.current = null;
      } else if (previousSample) {
        deadReckonedPosRef.current = advanceLiveTrackPosition(previousSample, sample, deadReckonedPosRef.current);
      }
      position = deadReckonedPosRef.current;
    }
    previousSampleRef.current = sample;
    deadReckonedLapRef.current = sample.lapNumber ?? null;
    if (!position) return;
    const last = lastTracePos.current;
    if (last && Math.hypot(position.x - last.x, position.z - last.z) < traceMinDist) return;
    liveTraceRef.current.push(position);
    lastTracePos.current = position;
    if (liveTraceRef.current.length > 2000) liveTraceRef.current.shift();
  }, [sample]);

  useEffect(() => {
    drawLiveTrack({ canvasRef, sample, outline, pitLines, noOutline, isRecorded, startYaw, sectors, boundaries, issues, liveTraceRef, deadReckonedPosRef, lapDistRef });
  });

  async function handleDeleteMap() {
    const trackOrd = lastTrackOrdRef.current;
    if (!trackOrd) return;
    try {
      await client.api["track-outline"][":ordinal"].$delete({ param: { ordinal: String(trackOrd) } });
      setOutline(null);
      setPitLines([]);
      setIsRecorded(false);
      setStartYaw(null);
      setNoOutline(true);
      liveTraceRef.current = [];
      lastTracePos.current = null;
      deadReckonedPosRef.current = null;
      previousSampleRef.current = null;
      deadReckonedLapRef.current = null;
    } catch {}
  }

  return (
    <div className="relative">
      <canvas ref={canvasRef} className="w-full" style={{ height: 250 }} />
      {isRecorded && (
        <Button
          type="button"
          onClick={handleDeleteMap}
          className="absolute top-2 right-2 px-2 py-1 text-xs text-app-text-secondary hover:text-status-danger rounded border border-app-border-input hover:border-status-danger/60 hover:bg-status-danger/10 transition-colors"
          title="Delete recorded track map and re-record from driving"
        >
          {m.label_reset_map()}
        </Button>
      )}
    </div>
  );
}
