import { deadReckonIRacingPosition } from "@shared/racing/tracks/path";
import type { TuneIssue } from "@shared/racing/tuning/issues";
import type { TelemetryPacket } from "@shared/telemetry/types";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PitLine } from "@/lib/canvas/draw-track";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useGameId } from "@/stores/game";
import { drawLiveTrack, type Point, type TrackBoundaryData } from "./draw-live-track";

interface Props {
  packet: TelemetryPacket | null;
  /** Live Tuning Dashboard: transient issues to plot as markers along the track,
   *  positioned by their distanceFrac. Omitted/undefined elsewhere. */
  issues?: TuneIssue[];
}

export function LiveTrackMap({ packet, issues }: Props) {
  const gameId = useGameId();
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
  const deadReckonedPacketRef = useRef<TelemetryPacket | null>(null);
  const deadReckonedLapRef = useRef<number | null>(null);
  const traceMinDist = 3;

  // Auto-detect track changes from packet.TrackOrdinal and fetch outline
  useEffect(() => {
    if (!packet?.TrackOrdinal) return;
    const trackOrd = packet.TrackOrdinal;
    if (trackOrd === lastTrackOrdRef.current) return;
    lastTrackOrdRef.current = trackOrd;

    // Reset state for new track
    liveTraceRef.current = [];
    lastTracePos.current = null;
    deadReckonedPosRef.current = null;
    deadReckonedPacketRef.current = null;
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
  }, [packet?.TrackOrdinal, gameId]);

  // Re-fetch outline on lap completion if we don't have a recorded one yet.
  // The server may have just recorded the first lap trace.
  // Also re-fetch boundaries (calibration may have completed after a lap).
  useEffect(() => {
    if (!packet) return;
    const trackOrd = lastTrackOrdRef.current;
    if (!trackOrd) return;

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
    if (!boundaries || (boundaries.coordSystem !== "forza" && boundaries.coordSystem !== "f1-2025")) {
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrd) }, query: { gameId: gameId ?? undefined } })
        .then((r) => r.json() as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .then((data: any) => {
          if (data) setBoundaries(data);
        }) // eslint-disable-line @typescript-eslint/no-explicit-any
        .catch(() => {});
    }
  }, [packet?.LapNumber, gameId]);

  // Track distance at lap boundaries for position estimation
  useEffect(() => {
    if (!packet) return;
    const d = lapDistRef.current;
    if (packet.LapNumber !== d.lastLap) {
      // Lap boundary: record total distance of completed lap, reset start
      if (d.lastLap >= 0 && d.startDist > 0) {
        const completedDist = packet.DistanceTraveled - d.startDist;
        if (completedDist > 50) {
          d.totalDist = completedDist;
        }
      }
      d.startDist = packet.DistanceTraveled;
      d.lastLap = packet.LapNumber;
    }
  }, [packet?.LapNumber, packet?.DistanceTraveled]);

  // Collect real positions when available. iRacing deliberately publishes no
  // world position, so dead-reckon speed along heading while the first lap is
  // being built. Once an outline exists, native LapDistPct takes over.
  useEffect(() => {
    if (!packet) return;
    let pos: Point | null = null;
    if (packet.PositionX !== 0 || packet.PositionZ !== 0) {
      pos = { x: packet.PositionX, z: packet.PositionZ };
    } else if (packet.gameId === "iracing") {
      const previousPacket = deadReckonedPacketRef.current;
      const lapChanged = deadReckonedLapRef.current != null && deadReckonedLapRef.current !== packet.LapNumber;
      if (!deadReckonedPosRef.current || lapChanged) {
        deadReckonedPosRef.current = { x: 0, z: 0 };
        liveTraceRef.current = [];
        lastTracePos.current = null;
      } else if (previousPacket) {
        deadReckonedPosRef.current = deadReckonIRacingPosition(previousPacket, packet, deadReckonedPosRef.current);
      }
      deadReckonedPacketRef.current = packet;
      deadReckonedLapRef.current = packet.LapNumber;
      pos = deadReckonedPosRef.current;
    }
    if (!pos) return;
    const last = lastTracePos.current;

    if (last) {
      const dx = pos.x - last.x;
      const dz = pos.z - last.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < traceMinDist) return;
    }

    liveTraceRef.current.push(pos);
    lastTracePos.current = pos;

    // Cap at 2000 points (enough for most tracks)
    if (liveTraceRef.current.length > 2000) {
      liveTraceRef.current.shift();
    }
  }, [packet]);

  useEffect(() => {
    drawLiveTrack({ canvasRef, packet, outline, pitLines, noOutline, isRecorded, startYaw, sectors, boundaries, issues, liveTraceRef, deadReckonedPosRef, lapDistRef });
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
      deadReckonedPacketRef.current = null;
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
