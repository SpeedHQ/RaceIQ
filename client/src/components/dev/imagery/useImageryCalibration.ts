import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { GameId } from "../../../../../shared/games/ids";
import {
  defaultVenueImageryCalibration,
  geographicTrackImageryPoint,
  rotateTrackImageryMatrix,
  scaleTrackImageryMatrix,
  trackImageryCalibrationFromBounds,
  trackImageryGeographicBounds,
  transformTrackImageryPoint,
  translateTrackImageryMatrix,
  type TrackImageryCalibration,
  type TrackImageryCandidate,
  type TrackImageryGeographicReference,
} from "../../../../../shared/racing/tracks/imagery";
import { useLapSemanticTelemetry, useLaps } from "../../../hooks/laps";

type CalibrationDragMode = "move" | "rotate" | "scale";

interface CalibrationDrag {
  pointerId: number;
  mode: CalibrationDragMode;
  startX: number;
  startZ: number;
  centerX: number;
  centerZ: number;
  startDistance: number;
  startAngle: number;
  startMatrix: TrackImageryCalibration["imageToEnu"];
}

interface UseImageryCalibrationOptions {
  gameId: GameId;
  trackOrdinal: number;
  catalogReference: TrackImageryGeographicReference | null;
  catalogReferenceLoading?: boolean;
  initialCalibration: TrackImageryCalibration | null;
  baseUrl: string | null;
  selectedCandidate: TrackImageryCandidate | null;
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; z: number } | null {
  const inverse = svg.getScreenCTM()?.inverse();
  if (!inverse) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(inverse);
  return { x: point.x, z: point.y };
}

export function useImageryCalibration({
  gameId,
  trackOrdinal,
  catalogReference,
  catalogReferenceLoading = false,
  initialCalibration,
  baseUrl,
  selectedCandidate,
}: UseImageryCalibrationOptions) {
  const { data: laps = [] } = useLaps();
  const eligibleLaps = useMemo(() => laps.filter((lap) => lap.trackOrdinal != null && lap.lapTime > 0), [laps]);
  const selectableLaps = useMemo(() => eligibleLaps.filter((lap) => lap.trackOrdinal === trackOrdinal), [eligibleLaps, trackOrdinal]);
  const [lapId, setLapId] = useState<number | null>(null);
  const { data: replay, isLoading: replayLoading } = useLapSemanticTelemetry(lapId);
  const geographicPositions = lapId === null ? (catalogReference?.geographicPositions ?? []) : (replay?.geographicPositions ?? []);
  const bounds = useMemo(() => trackImageryGeographicBounds(geographicPositions), [geographicPositions]);
  const referenceLoading = lapId === null ? catalogReferenceLoading : replayLoading;
  const [calibration, setCalibration] = useState<TrackImageryCalibration | null>(initialCalibration);
  const [baseAspectRatio, setBaseAspectRatio] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<CalibrationDrag | null>(null);
  const initialCalibrationKey = initialCalibration ? JSON.stringify(initialCalibration) : null;
  const initialCalibrationRef = useRef<{ identity: string; key: string | null }>({
    identity: `${gameId}:${trackOrdinal}`,
    key: initialCalibrationKey,
  });

  useEffect(() => {
    if (lapId !== null && !selectableLaps.some((lap) => lap.id === lapId)) setLapId(null);
  }, [lapId, selectableLaps]);

  useEffect(() => {
    const identity = `${gameId}:${trackOrdinal}`;
    const previous = initialCalibrationRef.current;
    if (previous.identity !== identity) {
      initialCalibrationRef.current = { identity, key: initialCalibrationKey };
      dragRef.current = null;
      setLapId(null);
      setCalibration(initialCalibration);
      setBaseAspectRatio(1);
      setError(null);
      return;
    }
    if (previous.key !== initialCalibrationKey) {
      initialCalibrationRef.current = { identity, key: initialCalibrationKey };
      setCalibration(initialCalibration);
    }
  }, [gameId, initialCalibration, initialCalibrationKey, trackOrdinal]);

  useEffect(() => {
    if (!baseUrl) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const aspectRatio = image.naturalWidth / image.naturalHeight || 1;
      setBaseAspectRatio(aspectRatio);
      setCalibration((current) => current ?? defaultVenueImageryCalibration(geographicPositions, aspectRatio));
    };
    image.onerror = () => {
      if (!cancelled) setError("Unable to load selected imagery preview.");
    };
    image.src = baseUrl;
    return () => {
      cancelled = true;
    };
  }, [baseUrl, geographicPositions]);

  const gpsPath = useMemo(() => {
    if (!calibration) return [];
    const valid = geographicPositions.filter(
      (point): point is NonNullable<typeof point> => !!point && Number.isFinite(point.latitudeDeg) && Number.isFinite(point.longitudeDeg),
    );
    const stride = Math.max(1, Math.ceil(valid.length / 2_000));
    return valid.filter((_, index) => index % stride === 0).map((point) => geographicTrackImageryPoint(point, calibration));
  }, [calibration, geographicPositions]);

  const imageCorners = useMemo(
    () =>
      calibration
        ? [
            transformTrackImageryPoint(calibration.imageToEnu, 0, 0),
            transformTrackImageryPoint(calibration.imageToEnu, 1, 0),
            transformTrackImageryPoint(calibration.imageToEnu, 1, 1),
            transformTrackImageryPoint(calibration.imageToEnu, 0, 1),
          ]
        : [],
    [calibration],
  );

  const viewBounds = useMemo(() => {
    if (gpsPath.length < 2) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of gpsPath) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    const padding = Math.max(maxX - minX, maxZ - minZ) * 0.75 || 10;
    return { minX: minX - padding, minZ: minZ - padding, width: maxX - minX + padding * 2, height: maxZ - minZ + padding * 2 };
  }, [gpsPath]);

  const handles = useMemo(() => {
    if (!viewBounds || imageCorners.length !== 4) return null;
    const center = {
      x: (imageCorners[0].x + imageCorners[2].x) / 2,
      z: (imageCorners[0].z + imageCorners[2].z) / 2,
    };
    const top = {
      x: (imageCorners[0].x + imageCorners[1].x) / 2,
      z: (imageCorners[0].z + imageCorners[1].z) / 2,
    };
    const directionX = top.x - center.x;
    const directionZ = top.z - center.z;
    const directionLength = Math.hypot(directionX, directionZ) || 1;
    const offset = Math.max(viewBounds.width, viewBounds.height) * 0.075;
    return {
      center,
      top,
      rotate: {
        x: top.x + (directionX / directionLength) * offset,
        z: top.z + (directionZ / directionLength) * offset,
      },
      radius: Math.max(viewBounds.width, viewBounds.height) * 0.012,
    };
  }, [imageCorners, viewBounds]);

  const fitToBounds = useCallback(
    (candidateFit = selectedCandidate !== null) => {
      const next = candidateFit && bounds ? trackImageryCalibrationFromBounds(geographicPositions, bounds) : defaultVenueImageryCalibration(geographicPositions, baseAspectRatio);
      if (next) setCalibration(next);
      return next;
    },
    [baseAspectRatio, bounds, geographicPositions, selectedCandidate],
  );

  const startDrag = useCallback(
    (mode: CalibrationDragMode, event: ReactPointerEvent<SVGElement>) => {
      if (!calibration || event.button !== 0) return;
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg) return;
      const point = svgPoint(svg, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      svg.setPointerCapture(event.pointerId);
      const center = transformTrackImageryPoint(calibration.imageToEnu, 0.5, 0.5);
      dragRef.current = {
        pointerId: event.pointerId,
        mode,
        startX: point.x,
        startZ: point.z,
        centerX: center.x,
        centerZ: center.z,
        startDistance: Math.hypot(point.x - center.x, point.z - center.z),
        startAngle: Math.atan2(point.z - center.z, point.x - center.x),
        startMatrix: calibration.imageToEnu,
      };
    },
    [calibration],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    let matrix = drag.startMatrix;
    if (drag.mode === "move") {
      matrix = translateTrackImageryMatrix(matrix, point.x - drag.startX, point.z - drag.startZ);
    } else if (drag.mode === "scale") {
      const distance = Math.hypot(point.x - drag.centerX, point.z - drag.centerZ);
      const factor = Math.max(0.05, Math.min(20, distance / Math.max(drag.startDistance, Number.EPSILON)));
      matrix = scaleTrackImageryMatrix(matrix, factor);
    } else {
      const angle = Math.atan2(point.z - drag.centerZ, point.x - drag.centerX);
      const delta = Math.atan2(Math.sin(angle - drag.startAngle), Math.cos(angle - drag.startAngle));
      matrix = rotateTrackImageryMatrix(matrix, delta);
    }
    setCalibration((current) => (current ? { ...current, imageToEnu: matrix } : current));
  }, []);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return {
    lapId,
    setLapId,
    selectableLaps,
    replay,
    catalogReference,
    geographicPositions,
    bounds,
    referenceLoading,
    calibration,
    setCalibration,
    fitToBounds,
    viewBounds,
    imageCorners,
    handles,
    imageTransform: calibration ? `matrix(${calibration.imageToEnu.join(" ")})` : undefined,
    gpsPolyline: gpsPath.map((point) => `${point.x},${point.z}`).join(" "),
    startDrag,
    handlePointerMove,
    handlePointerEnd,
    error,
  };
}

export type ImageryCalibrationModel = ReturnType<typeof useImageryCalibration>;
