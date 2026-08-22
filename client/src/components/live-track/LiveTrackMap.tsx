import type { TuneIssue } from "@shared/racing/tuning/issues";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { drawLiveTrack, type Point, type TrackBoundaryData } from "./draw-live-track";

interface Props {
  view: LiveTelemetryView | null;
  /** Live Tuning Dashboard: transient issues to plot as markers along the track,
   *  positioned by their distanceFrac. Omitted/undefined elsewhere. */
  issues?: TuneIssue[];
}
type TrackSectorResponse = { s1End?: number; s2End?: number };
type TrackOutlineResponse = Point[] | { points: Point[]; recorded?: boolean; startYaw?: number | null };
function deadReckonPosition(previous: { observedAtMs: number; yaw: number; speedMps: number }, current: { observedAtMs: number; yaw: number; speedMps: number }, previousPosition: Point): Point {
  const dt = (current.observedAtMs - previous.observedAtMs) / 1000;
  if (dt <= 0 || dt > 1) return previousPosition;
  const yaw = Math.atan2(Math.sin(previous.yaw) + Math.sin(current.yaw), Math.cos(previous.yaw) + Math.cos(current.yaw));
  return { x: previousPosition.x + Math.sin(yaw) * current.speedMps * dt, z: previousPosition.z + Math.cos(yaw) * current.speedMps * dt };
}

export function LiveTrackMap({ view, issues }: Props) {
  const gameId = view?.simulator;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [noOutline, setNoOutline] = useState(false);
  const [isRecorded, setIsRecorded] = useState(false); // true = Forza coords, can plot directly
  const [startYaw, setStartYaw] = useState<number | null>(null); // Yaw at start/finish line
  const [sectors, setSectors] = useState<{ s1End: number; s2End: number } | null>(null);
  const [boundaries, setBoundaries] = useState<TrackBoundaryData | null>(null);
  const lastTrackOrdRef = useRef<number | null>(null);
  const lastTrackKeyRef = useRef("");

  // Distance-based position tracking
  const lapDistRef = useRef<{ startDist: number; totalDist: number; lastLap: number }>({
    startDist: 0,
    totalDist: 0,
    lastLap: -1,
  });
  const liveTraceRef = useRef<Point[]>([]);
  const lastTracePos = useRef<Point | null>(null);
  const deadReckonedPosRef = useRef<Point | null>(null);
  const deadReckonedSampleRef = useRef<{ observedAtMs: number; yaw: number; speedMps: number } | null>(null);
  const deadReckonedLapRef = useRef<number | null>(null);
  const traceMinDist = 3;
  // Auto-detect track changes from semantic track identity and fetch outline
  useEffect(() => {
    const trackOrd = view?.identity.trackOrdinal;
    if (!trackOrd || !gameId) return;
    const trackKey = `${gameId}:${trackOrd}`;
    if (trackKey === lastTrackKeyRef.current) return;
    lastTrackKeyRef.current = trackKey;
    lastTrackOrdRef.current = trackOrd;

    liveTraceRef.current = [];
    lastTracePos.current = null;
    deadReckonedPosRef.current = null;
    deadReckonedSampleRef.current = null;
    deadReckonedLapRef.current = null;
    lapDistRef.current = { startDist: 0, totalDist: 0, lastLap: -1 };
    setOutline(null);
    setNoOutline(false);
    setSectors(null);
    setBoundaries(null);

    let active = true;

    client.api["track-sector-boundaries"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrd) }, query: { gameId } })
      .then((r) => r.json() as Promise<TrackSectorResponse>)
      .then((data) => {
        if (!active) return;
        if (typeof data.s1End === "number" && typeof data.s2End === "number") setSectors({ s1End: data.s1End, s2End: data.s2End });
      })
      .catch(() => {});

    client.api["track-boundaries"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrd) }, query: { gameId } })
      .then((r) => r.json() as Promise<TrackBoundaryData>)
      .then((data) => {
        if (!active) return;
        if (data) setBoundaries(data);
      })
      .catch(() => {});

    client.api["track-outline"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrd) }, query: { gameId } })
      .then((r) => r.json() as Promise<TrackOutlineResponse>)
      .then((data) => {
        if (!active) return;
        if (!Array.isArray(data) && data.points.length > 0) {
          setOutline(data.points);
          setIsRecorded(!!data.recorded);
          setStartYaw(data.startYaw ?? null);
        } else if (Array.isArray(data)) {
          setOutline(data);
          setIsRecorded(false);
          setStartYaw(null);
        } else {
          throw new Error("invalid format");
        }
        setNoOutline(false);
      })
      .catch(() => {
        if (!active) return;
        setOutline(null);
        setIsRecorded(false);
        setStartYaw(null);
        setNoOutline(true);
      });
    return () => {
      active = false;
    };
  }, [view?.identity.trackOrdinal, gameId]);

  // Re-fetch outline on lap completion if we don't have a recorded one yet.
  useEffect(() => {
    if (!view) return;
    const trackOrd = lastTrackOrdRef.current;
    if (!trackOrd || !gameId) return;
    let active = true;

    if (!isRecorded) {
      client.api["track-outline"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrd) }, query: { gameId } })
        .then((r) => r.json() as Promise<TrackOutlineResponse>)
        .then((data) => {
          if (!active) return;
          if (!Array.isArray(data) && data.points.length > 0) {
            setOutline(data.points);
            setIsRecorded(!!data.recorded);
            setStartYaw(data.startYaw ?? null);
            setNoOutline(false);
          }
        })
        .catch(() => {});
    }

    if (!boundaries || (boundaries.coordSystem !== "forza" && boundaries.coordSystem !== "f1-2025")) {
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrd) }, query: { gameId } })
        .then((r) => r.json() as Promise<TrackBoundaryData>)
        .then((data) => {
          if (!active) return;
          if (data) setBoundaries(data);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [view?.timing.lapNumber, gameId, isRecorded, boundaries]);

  // Track distance at lap boundaries for position estimation
  useEffect(() => {
    const lapNumber = view?.timing.lapNumber;
    const distanceM = view?.motion.distanceM;
    if (lapNumber === undefined || distanceM === undefined) return;
    const d = lapDistRef.current;
    if (lapNumber !== d.lastLap) {
      if (d.lastLap >= 0 && d.startDist > 0) {
        const completedDist = distanceM - d.startDist;
        if (completedDist > 50) d.totalDist = completedDist;
      }
      d.startDist = distanceM;
      d.lastLap = lapNumber;
    }
  }, [view?.timing.lapNumber, view?.motion.distanceM]);

  // Collect semantic positions; iRacing has no world position, so dead-reckon
  // speed along heading while first lap outline builds.
  useEffect(() => {
    if (!view) return;
    let pos: Point | null = null;
    const position = view.motion.position;
    if (position && (position.x !== 0 || position.z !== 0)) {
      pos = position;
    } else if (view.simulator === "iracing") {
      const yaw = view.motion.attitude?.yaw;
      const speedMps = view.motion.speedMps;
      if (yaw === undefined || speedMps === undefined) return;
      const currentSample = { observedAtMs: view.observedAtMs, yaw, speedMps };
      const previousSample = deadReckonedSampleRef.current;
      const lapChanged = deadReckonedLapRef.current != null && deadReckonedLapRef.current !== (view.timing.lapNumber ?? null);
      if (!deadReckonedPosRef.current || lapChanged) {
        deadReckonedPosRef.current = { x: 0, z: 0 };
        liveTraceRef.current = [];
        lastTracePos.current = null;
      } else if (previousSample) {
        deadReckonedPosRef.current = deadReckonPosition(previousSample, currentSample, deadReckonedPosRef.current);
      }
      deadReckonedSampleRef.current = currentSample;
      deadReckonedLapRef.current = view.timing.lapNumber ?? null;
      pos = deadReckonedPosRef.current;
    }
    if (!pos) return;
    const last = lastTracePos.current;
    if (last) {
      const dx = pos.x - last.x;
      const dz = pos.z - last.z;
      if (Math.sqrt(dx * dx + dz * dz) < traceMinDist) return;
    }
    liveTraceRef.current.push(pos);
    lastTracePos.current = pos;
    if (liveTraceRef.current.length > 2000) liveTraceRef.current.shift();
  }, [view]);

  useEffect(() => {
    drawLiveTrack({ canvasRef, view, outline, noOutline, isRecorded, startYaw, sectors, boundaries, issues, liveTraceRef, deadReckonedPosRef, lapDistRef });
  });

  async function handleDeleteMap() {
    const trackOrd = lastTrackOrdRef.current;
    if (!trackOrd) return;
    try {
      await client.api["track-outline"][":ordinal"].$delete({ param: { ordinal: String(trackOrd) } });
      setOutline(null);
      setIsRecorded(false);
      setStartYaw(null);
      setNoOutline(true);
      liveTraceRef.current = [];
      lastTracePos.current = null;
      deadReckonedPosRef.current = null;
      deadReckonedSampleRef.current = null;
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
