import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { trackConfigurationVenueId, type TrackConfiguration } from "../../../../shared/racing/tracks/configuration";
import {
  TRACK_IMAGERY_MANIFEST_VERSION,
  TrackImageryOutputBudgetResultSchema,
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
  type TrackImageryLayerKind,
  type TrackImageryLayoutManifest,
  type TrackImagerySource,
  type TrackImageryOutputBudget,
  type TrackImageryVenueManifest,
} from "../../../../shared/racing/tracks/imagery";
import { useLapSemanticTelemetry, useLaps } from "../../hooks/laps";
import type { TrackConfigurationSelection } from "./TrackConfigurationBrowser";
import { OpenTrackImageryPicker } from "./OpenTrackImageryPicker";
import { Button } from "../ui/button";
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const EMPTY_SOURCE: TrackImagerySource = { name: "", url: "", capturedAt: "", license: "", attribution: "", provider: "manual" };

function normalizedId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sourcePayload(source: TrackImagerySource): TrackImagerySource {
  return {
    name: source.name.trim(),
    ...(source.url?.trim() ? { url: source.url.trim() } : {}),
    ...(source.capturedAt?.trim() ? { capturedAt: source.capturedAt.trim() } : {}),
    license: source.license.trim(),
    attribution: source.attribution.trim(),
    provider: source.provider,
    ...(source.quality ? { quality: source.quality } : {}),
    ...(source.coverage ? { coverage: source.coverage } : {}),
    ...(source.sourceResolutionM ? { sourceResolutionM: source.sourceResolutionM } : {}),
    ...(source.storedResolutionM ? { storedResolutionM: source.storedResolutionM } : {}),
    ...(source.geographicReliability ? { geographicReliability: source.geographicReliability } : {}),
    ...(source.cloudCoverPercent === undefined ? {} : { cloudCoverPercent: source.cloudCoverPercent }),
    ...(source.providerStability ? { providerStability: source.providerStability } : {}),
    ...(source.redistribution ? { redistribution: source.redistribution } : {}),
  };
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; z: number } | null {
  const inverse = svg.getScreenCTM()?.inverse();
  if (!inverse) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(inverse);
  return { x: point.x, z: point.y };
}

type SourceTextField = "name" | "url" | "capturedAt" | "license" | "attribution";
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

function sourceField(source: TrackImagerySource, key: SourceTextField): string {
  return source[key] ?? "";
}

function SourceEditor({ title, source, onChange, readOnly = false }: { title: string; source: TrackImagerySource; onChange: (source: TrackImagerySource) => void; readOnly?: boolean }) {
  const update = (key: SourceTextField, value: string) => onChange({ ...source, [key]: value });
  return (
    <fieldset className="mb-3 rounded border border-app-border p-2">
      <legend className="px-1 text-xs font-semibold text-app-text-secondary">{title}</legend>
      {(["name", "url", "capturedAt", "license", "attribution"] as const).map((key) => (
        <label key={key} className="mb-2 block text-[11px] font-medium capitalize text-app-text-muted last:mb-0">
          {key === "capturedAt" ? "Captured date" : key}
          <input
            className="mt-0.5 w-full rounded border border-app-border-input bg-app-surface px-2 py-1 text-xs text-app-text"
            type={key === "capturedAt" ? "date" : key === "url" ? "url" : "text"}
            disabled={readOnly}
            value={sourceField(source, key)}
            onChange={(event) => update(key, event.target.value)}
            placeholder={key === "license" ? "CC BY 4.0, public domain, owned" : undefined}
          />
        </label>
      ))}
    </fieldset>
  );
}

function formatBudgetBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 1 : 2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 100_000_000 ? 0 : 1)} MB`;
  return `${Math.ceil(bytes / 1_000).toLocaleString()} KB`;
}

export function TrackImageryOutputBudgetSummary({ budget }: { budget: TrackImageryOutputBudget }) {
  return (
    <div
      role="status"
      className={`mb-2 rounded border p-2 text-[11px] ${budget.safe ? "border-app-border bg-app-surface-alt text-app-text-muted" : "border-severity-critical text-severity-critical"}`}
    >
      <div className="font-semibold text-app-text">
        Estimated output: {budget.totalTiles.toLocaleString()} tiles, approximately {formatBudgetBytes(budget.estimatedPackBytes.minimum)}–{formatBudgetBytes(budget.estimatedPackBytes.maximum)}
      </div>
      <div>
        {budget.width.toLocaleString()} × {budget.height.toLocaleString()} px · {budget.totalPixels.toLocaleString()} pixels · {budget.columns.toLocaleString()} × {budget.rows.toLocaleString()} tile
        grid
      </div>
      <div>
        Uncompressed work {formatBudgetBytes(budget.estimatedUncompressedBytes)} · disk available {budget.availableDiskBytes === null ? "unknown" : formatBudgetBytes(budget.availableDiskBytes)}
      </div>
      <div>
        Job limit {Math.round(budget.maximumJobDurationMs / 60_000)} min · {budget.maximumConcurrency} concurrent import
      </div>
      {budget.problems.length > 0 && <div className="mt-1">{budget.overrideActive ? `Development override active: ${budget.problems.join("; ")}` : budget.problems.join("; ")}</div>}
    </div>
  );
}

export function TrackImageryCalibrationPanel({ selection, configurationRevision }: { selection: TrackConfigurationSelection; configurationRevision: number }) {
  const queryClient = useQueryClient();
  const { data: laps = [] } = useLaps();
  const gameId = selection.gameId;
  const trackOrdinal = selection.trackOrdinal;
  const eligibleLaps = useMemo(() => laps.filter((lap) => lap.trackOrdinal != null && lap.lapTime > 0), [laps]);
  const calibrationLaps = useMemo(() => eligibleLaps.filter((lap) => lap.trackOrdinal === trackOrdinal), [eligibleLaps, trackOrdinal]);
  const [lapId, setLapId] = useState<number | null>(null);
  useEffect(() => {
    if (lapId !== null && !calibrationLaps.some((lap) => lap.id === lapId)) setLapId(null);
  }, [calibrationLaps, lapId]);
  const [catalogReference, setCatalogReference] = useState<TrackImageryGeographicReference | null>(null);
  const [catalogReferenceLoading, setCatalogReferenceLoading] = useState(false);
  const { data: replay, isLoading: replayLoading } = useLapSemanticTelemetry(lapId);
  const geographicPositions = lapId === null ? (catalogReference?.geographicPositions ?? []) : (replay?.geographicPositions ?? []);
  const openImageryBounds = useMemo(() => trackImageryGeographicBounds(geographicPositions), [geographicPositions]);
  const calibrationReferenceLoading = lapId === null ? catalogReferenceLoading : replayLoading;

  const [configuration, setConfiguration] = useState<TrackConfiguration | null>(null);
  const [venueId, setVenueId] = useState("");
  const [venue, setVenue] = useState<TrackImageryVenueManifest | null>(null);
  const [, setLayout] = useState<TrackImageryLayoutManifest | null>(null);
  const [calibration, setCalibration] = useState<TrackImageryCalibration | null>(null);
  const [baseFile, setBaseFile] = useState<File | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [baseAspectRatio, setBaseAspectRatio] = useState(1);
  const [baseSource, setBaseSource] = useState<TrackImagerySource>(EMPTY_SOURCE);
  const [selectedImageryCandidate, setSelectedImageryCandidate] = useState<TrackImageryCandidate | null>(null);
  const [openImageryPreviewUrl, setOpenImageryPreviewUrl] = useState<string | null>(null);
  const [outputBudget, setOutputBudget] = useState<TrackImageryOutputBudget | null>(null);
  const [estimatingOutput, setEstimatingOutput] = useState(false);
  const [selectedLayers, setSelectedLayers] = useState<string[]>([]);
  const [layerId, setLayerId] = useState("");
  const [layerKind, setLayerKind] = useState<TrackImageryLayerKind>("layout");
  const [layerOpacity, setLayerOpacity] = useState(1);
  const [layerFile, setLayerFile] = useState<File | null>(null);
  const [layerSource, setLayerSource] = useState<TrackImagerySource>(EMPTY_SOURCE);
  const [layerPreviewUrl, setLayerPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const dragRef = useRef<CalibrationDrag | null>(null);
  const budgetRequestRef = useRef(0);

  useEffect(() => {
    setLapId(null);
    setCatalogReference(null);
    setBaseFile(null);
    setSelectedImageryCandidate(null);
    setOpenImageryPreviewUrl(null);
    setLayerFile(null);
    setOutputBudget(null);
    setEstimatingOutput(false);
    setLayerId("");
    setLayerSource(EMPTY_SOURCE);
    setSelectedLayers([]);
    setCalibration(null);
    setConfiguration(null);
    setVenueId("");
    setVenue(null);
    setBaseUrl(null);
    setStatus(null);
    setError(null);
  }, [gameId, trackOrdinal]);

  useEffect(() => {
    budgetRequestRef.current += 1;
    setSelectedImageryCandidate(null);
    setOpenImageryPreviewUrl(null);
    setOutputBudget(null);
    setEstimatingOutput(false);
  }, [openImageryBounds]);

  useEffect(() => {
    if (!gameId || trackOrdinal == null) {
      setConfiguration(null);
      setVenueId("");
      return;
    }
    let cancelled = false;
    setConfiguration(null);
    setVenueId("");
    void fetch(`/api/dev/track-configurations/${trackOrdinal}?gameId=${encodeURIComponent(gameId)}`)
      .then(async (response) => {
        const result = (await response.json()) as TrackConfiguration | { error?: string } | null;
        if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to load track configuration");
        if (cancelled) return;
        const nextConfiguration = result as TrackConfiguration | null;
        setConfiguration(nextConfiguration);
        setVenueId(nextConfiguration ? trackConfigurationVenueId(nextConfiguration) : "");
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load track configuration");
      });
    return () => {
      cancelled = true;
    };
  }, [configurationRevision, gameId, trackOrdinal]);

  useEffect(() => {
    if (!configuration || !gameId || trackOrdinal == null) {
      setCatalogReference(null);
      setCatalogReferenceLoading(false);
      return;
    }
    let cancelled = false;
    setCatalogReference(null);
    setCatalogReferenceLoading(true);
    void fetch(`/api/dev/track-imagery/reference/${trackOrdinal}?gameId=${encodeURIComponent(gameId)}`)
      .then(async (response) => {
        const result = (await response.json()) as TrackImageryGeographicReference | { error?: string } | null;
        if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to load catalog GPS reference");
        if (!cancelled) setCatalogReference(result as TrackImageryGeographicReference | null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load catalog GPS reference");
      })
      .finally(() => {
        if (!cancelled) setCatalogReferenceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configuration, gameId, trackOrdinal]);

  useEffect(() => {
    if (!gameId || trackOrdinal == null) {
      setLayout(null);
      setSelectedLayers([]);
      return;
    }
    let cancelled = false;
    setLayout(null);
    setSelectedLayers([]);
    void fetch(`/api/dev/track-imagery/layouts/${trackOrdinal}?gameId=${encodeURIComponent(gameId)}`)
      .then(async (response) => {
        const result = (await response.json()) as TrackImageryLayoutManifest | { error?: string } | null;
        if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to load layout imagery");
        if (cancelled) return;
        const nextLayout = result as TrackImageryLayoutManifest | null;
        setLayout(nextLayout);
        setSelectedLayers(nextLayout?.layers ?? []);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load imagery layout");
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, trackOrdinal]);

  useEffect(() => {
    if (!configuration || !venueId) {
      setVenue(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/dev/track-imagery/venues/manifest?venueId=${encodeURIComponent(venueId)}`)
      .then(async (response) => {
        const result = (await response.json()) as TrackImageryVenueManifest | { error?: string } | null;
        if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to load imagery venue");
        if (cancelled) return;
        const nextVenue = result as TrackImageryVenueManifest | null;
        setVenue(nextVenue);
        setCalibration(nextVenue?.calibration ?? null);
        setBaseSource(nextVenue?.base.source ?? EMPTY_SOURCE);
        setSelectedImageryCandidate(null);
        setOpenImageryPreviewUrl(null);
        setOutputBudget(null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load imagery venue");
      });
    return () => {
      cancelled = true;
    };
  }, [venueId, assetVersion]);

  useEffect(() => {
    if (baseFile) {
      const objectUrl = URL.createObjectURL(baseFile);
      setBaseUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
    if (openImageryPreviewUrl) {
      setBaseUrl(openImageryPreviewUrl);
      return;
    }
    setBaseUrl(venue ? `/api/dev/track-imagery/venues/texture/base?venueId=${encodeURIComponent(venue.venueId)}&v=${assetVersion}` : null);
  }, [assetVersion, baseFile, openImageryPreviewUrl, venue]);

  useEffect(() => {
    if (!layerFile) {
      setLayerPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(layerFile);
    setLayerPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [layerFile]);

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
    const valid = geographicPositions.filter((point): point is NonNullable<typeof point> => !!point && Number.isFinite(point.latitudeDeg) && Number.isFinite(point.longitudeDeg));
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
  const calibrationHandles = useMemo(() => {
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
  const imageTransform = calibration ? `matrix(${calibration.imageToEnu.join(" ")})` : undefined;
  const gpsPolyline = gpsPath.map((point) => `${point.x},${point.z}`).join(" ");
  const displayedLayers = venue?.layers.filter((candidate) => selectedLayers.includes(candidate.id)) ?? [];
  const baseSourceValid = !!baseSource.name.trim() && !!baseSource.license.trim();
  const baseBounds = openImageryBounds ?? venue?.base.bounds ?? null;
  const canSaveBase =
    !!gameId &&
    trackOrdinal != null &&
    !!configuration &&
    !!calibration &&
    !!baseBounds &&
    baseSourceValid &&
    (!!baseFile || (!!selectedImageryCandidate && outputBudget?.safe === true) || !!venue) &&
    !estimatingOutput;
  const layerSourceValid = !!layerSource.name.trim() && !!layerSource.license.trim();
  const canSaveLayer = !!venue && SAFE_ID.test(layerId) && !!layerFile && layerSourceValid;

  const resetGpsFit = () => {
    const next =
      selectedImageryCandidate && openImageryBounds ? trackImageryCalibrationFromBounds(geographicPositions, openImageryBounds) : defaultVenueImageryCalibration(geographicPositions, baseAspectRatio);
    if (next) setCalibration(next);
  };

  const startCalibrationDrag = (mode: CalibrationDragMode, event: ReactPointerEvent<SVGElement>) => {
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
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
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
  };
  const handlePointerEnd = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const saveLayout = async (layers = selectedLayers) => {
    if (!gameId || trackOrdinal == null) throw new Error("Select a catalog track");
    const payload: TrackImageryLayoutManifest = { version: TRACK_IMAGERY_MANIFEST_VERSION, gameId, trackOrdinal, layers };
    const response = await fetch(`/api/dev/track-imagery/layouts/${trackOrdinal}?gameId=${encodeURIComponent(gameId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = (await response.json()) as TrackImageryLayoutManifest | { error?: string };
    if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to save layout imagery");
    setLayout(result as TrackImageryLayoutManifest);
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["track-imagery", trackOrdinal, gameId] }), queryClient.invalidateQueries({ queryKey: ["track-imagery-configurations"] })]);
  };

  const saveBase = async () => {
    if (!calibration || !canSaveBase) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    const manifest: TrackImageryVenueManifest = {
      version: TRACK_IMAGERY_MANIFEST_VERSION,
      venueId,
      calibration,
      base: { pack: "imagery.rqi", tileSize: 512, bounds: baseBounds, source: { ...sourcePayload(baseSource), provider: baseSource.provider ?? "manual" } },
      layers: venue?.layers ?? [],
    };
    try {
      let response: Response;
      if (baseFile) {
        const body = new FormData();
        body.set("file", baseFile);
        body.set("manifest", JSON.stringify(manifest));
        response = await fetch(`/api/dev/track-imagery/venues/base?venueId=${encodeURIComponent(venueId)}`, { method: "POST", body });
      } else if (selectedImageryCandidate && openImageryBounds) {
        response = await fetch(`/api/dev/track-imagery/venues/base/source?venueId=${encodeURIComponent(venueId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId: selectedImageryCandidate.id, bounds: openImageryBounds, calibration, gameId, trackOrdinal }),
        });
      } else {
        response = await fetch(`/api/dev/track-imagery/venues/manifest?venueId=${encodeURIComponent(venueId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(manifest),
        });
      }
      const result = (await response.json()) as TrackImageryVenueManifest | { error?: string };
      if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to save venue base");
      const savedVenue = result as TrackImageryVenueManifest;
      setVenue(savedVenue);
      setBaseFile(null);
      setSelectedImageryCandidate(null);
      setOpenImageryPreviewUrl(null);
      await saveLayout(selectedLayers.filter((id) => savedVenue.layers.some((layer) => layer.id === id)));
      setAssetVersion((version) => version + 1);
      setStatus(
        selectedImageryCandidate ? `${selectedImageryCandidate.quality === "hq" ? "HQ" : "Context fallback"} open imagery imported and assigned.` : "Opaque venue base and layout assignment saved.",
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save venue base");
    } finally {
      setSaving(false);
    }
  };

  const saveLayer = async () => {
    if (!venue || !layerFile || !canSaveLayer) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const body = new FormData();
      body.set("file", layerFile);
      body.set("layer", JSON.stringify({ id: layerId, image: layerFile.name, kind: layerKind, opacity: layerOpacity, source: sourcePayload(layerSource) }));
      const response = await fetch(`/api/dev/track-imagery/venues/layers/${encodeURIComponent(layerId)}?venueId=${encodeURIComponent(venue.venueId)}`, { method: "POST", body });
      const result = (await response.json()) as TrackImageryVenueManifest | { error?: string };
      if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to save overlay layer");
      const savedVenue = result as TrackImageryVenueManifest;
      const nextLayers = selectedLayers.includes(layerId) ? selectedLayers : [...selectedLayers, layerId];
      setVenue(savedVenue);
      setSelectedLayers(nextLayers);
      setLayerFile(null);
      await saveLayout(nextLayers);
      setAssetVersion((version) => version + 1);
      setStatus(`Layer ${layerId} saved and assigned to this layout.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save overlay layer");
    } finally {
      setSaving(false);
    }
  };

  const persistLayerSelection = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveLayout();
      setStatus("Layout layer stack saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save layer stack");
    } finally {
      setSaving(false);
    }
  };
  const handleOpenImagerySelect = async (candidate: TrackImageryCandidate, previewUrl: string) => {
    const nextCalibration = openImageryBounds ? trackImageryCalibrationFromBounds(geographicPositions, openImageryBounds) : null;
    if (!nextCalibration || !gameId || trackOrdinal == null || !venueId || !openImageryBounds) {
      setError("Calibration reference needs at least two valid GPS positions and an assigned venue.");
      return;
    }
    const requestId = budgetRequestRef.current + 1;
    budgetRequestRef.current = requestId;
    setSelectedImageryCandidate(null);
    setOpenImageryPreviewUrl(null);
    setOutputBudget(null);
    setEstimatingOutput(true);
    setError(null);
    setStatus("Calculating complete output budget…");
    try {
      const response = await fetch("/api/dev/track-imagery/sources/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id, bounds: openImageryBounds, venueId, gameId, trackOrdinal }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "Unable to estimate open imagery output";
        throw new Error(message);
      }
      const result = TrackImageryOutputBudgetResultSchema.parse(payload);
      if (budgetRequestRef.current !== requestId) return;
      const { candidate: resolvedCandidate, budget } = result;
      setOutputBudget(budget);
      if (!budget.safe) {
        setStatus(null);
        setError(`Import rejected before source download: ${budget.problems.join("; ")}`);
        return;
      }
      setBaseFile(null);
      setSelectedImageryCandidate(resolvedCandidate);
      setOpenImageryPreviewUrl(previewUrl);
      setBaseSource({
        name: resolvedCandidate.title,
        url: resolvedCandidate.sourceUrl,
        ...(resolvedCandidate.capturedAt ? { capturedAt: resolvedCandidate.capturedAt } : {}),
        license: resolvedCandidate.license,
        attribution: resolvedCandidate.attribution,
        provider: resolvedCandidate.provider,
        quality: resolvedCandidate.quality,
        coverage: resolvedCandidate.coverage,
        sourceResolutionM: resolvedCandidate.sourceResolutionM,
        storedResolutionM: Math.max(resolvedCandidate.sourceResolutionM, 0.1),
        geographicReliability: resolvedCandidate.geographicReliability,
        ...(resolvedCandidate.cloudCoverPercent === undefined ? {} : { cloudCoverPercent: resolvedCandidate.cloudCoverPercent }),
        providerStability: resolvedCandidate.providerStability,
        redistribution: resolvedCandidate.redistribution,
      });
      setCalibration(nextCalibration);
      setStatus(`${resolvedCandidate.quality === "hq" ? "HQ" : "Context fallback"} imagery selected. Inspect reference alignment, then import.`);
    } catch (estimateError) {
      if (budgetRequestRef.current === requestId) {
        setStatus(null);
        setError(estimateError instanceof Error ? estimateError.message : "Unable to estimate open imagery output");
      }
    } finally {
      if (budgetRequestRef.current === requestId) setEstimatingOutput(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 bg-app-bg @7xl/workspace:grid-cols-[minmax(19rem,25rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-app-border p-4">
        <h1 className="mb-1 text-lg font-semibold text-app-text">Imagery calibration</h1>
        <p className="mb-4 text-xs text-app-text-muted">One HQ venue package; reusable transparent game, layout, and correction layers.</p>

        <label className="mb-3 block text-xs font-medium text-app-text-secondary">
          Calibration reference
          <select
            className="mt-1 w-full rounded border border-app-border-input bg-app-surface px-2 py-1.5 text-sm text-app-text"
            value={lapId ?? ""}
            onChange={(event) => setLapId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">
              {catalogReferenceLoading ? "Loading catalog GPS…" : catalogReference ? `Catalog · ${catalogReference.sourceName} (#${catalogReference.sourceTrackOrdinal})` : "Catalog GPS unavailable"}
            </option>
            {calibrationLaps.length === 0 && <option disabled>No recorded laps for selected track</option>}
            {calibrationLaps.map((lap) => (
              <option key={lap.id} value={lap.id}>
                Recorded lap {lap.lapNumber} · {(lap.lapTime / 1000).toFixed(3)}s
              </option>
            ))}
          </select>
        </label>

        <div className="mb-3 rounded border border-app-border bg-app-surface-alt p-2">
          <div className="text-[10px] uppercase tracking-wide text-app-text-muted">Assigned venue</div>
          {configuration ? (
            <>
              <div className="mt-1 text-xs text-app-text">{[configuration.venue.name, ...configuration.subVenues.map((entry) => entry.name)].join(" / ")}</div>
              <div className="font-mono text-[10px] text-app-text-muted">{venueId}</div>
            </>
          ) : (
            <div className="mt-1 text-xs text-severity-caution">Assign track from catalog list before calibrating imagery.</div>
          )}
        </div>

        <section className="mb-4 rounded border border-app-border p-3">
          <h2 className="mb-2 text-sm font-semibold text-app-text">Opaque venue base</h2>
          <OpenTrackImageryPicker
            bounds={configuration ? openImageryBounds : null}
            gameId={gameId}
            trackOrdinal={trackOrdinal}
            selectedCandidateId={selectedImageryCandidate?.id ?? null}
            onSelect={handleOpenImagerySelect}
          />
          {estimatingOutput && <p className="mb-2 text-[11px] text-app-text-muted">Calculating width, pixels, tiles, work, pack size, disk, duration, and concurrency…</p>}
          {outputBudget && <TrackImageryOutputBudgetSummary budget={outputBudget} />}
          <input
            className="mb-2 block w-full text-xs text-app-text-muted"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setBaseFile(file);
              setSelectedImageryCandidate(null);
              setOpenImageryPreviewUrl(null);
              budgetRequestRef.current += 1;
              setEstimatingOutput(false);
              setOutputBudget(null);
              if (file) setBaseSource(EMPTY_SOURCE);
            }}
          />
          <Button type="button" className="mb-2 w-full" onClick={resetGpsFit} disabled={!baseUrl || geographicPositions.length < 2}>
            Reset to GPS fit
          </Button>
          <SourceEditor title="Base provenance" source={baseSource} onChange={setBaseSource} readOnly={!!selectedImageryCandidate} />
          <Button type="button" onClick={() => void saveBase()} disabled={!canSaveBase || saving}>
            {saving ? "Saving…" : selectedImageryCandidate ? `Import ${selectedImageryCandidate.quality === "hq" ? "HQ" : "context fallback"} image` : venue ? "Update base" : "Save base"}
          </Button>
        </section>

        {venue && (
          <section className="mb-4 rounded border border-app-border p-3">
            <h2 className="mb-2 text-sm font-semibold text-app-text">Layout layer stack</h2>
            {venue.layers.length === 0 && <p className="mb-2 text-xs text-app-text-muted">No reusable layers yet.</p>}
            {venue.layers.map((layer) => (
              <label key={layer.id} className="mb-1 flex items-center gap-2 text-xs text-app-text-secondary">
                <input
                  type="checkbox"
                  checked={selectedLayers.includes(layer.id)}
                  onChange={(event) => setSelectedLayers((current) => (event.target.checked ? [...current, layer.id] : current.filter((id) => id !== layer.id)))}
                />
                <span className="font-mono">{layer.id}</span>
                <span className="text-app-text-muted">{layer.kind}</span>
              </label>
            ))}
            <Button type="button" onClick={() => void persistLayerSelection()} disabled={saving}>
              Save layer stack
            </Button>
          </section>
        )}

        {venue && (
          <section className="mb-4 rounded border border-app-border p-3">
            <h2 className="mb-2 text-sm font-semibold text-app-text">Add transparent layer</h2>
            <input
              className="mb-2 w-full rounded border border-app-border-input bg-app-surface px-2 py-1 font-mono text-xs text-app-text"
              value={layerId}
              onChange={(event) => setLayerId(normalizedId(event.target.value))}
              placeholder="road-course"
            />
            <div className="mb-2 grid grid-cols-2 gap-2">
              <select
                className="rounded border border-app-border-input bg-app-surface px-2 py-1 text-xs text-app-text"
                value={layerKind}
                onChange={(event) => setLayerKind(event.target.value as TrackImageryLayerKind)}
              >
                <option value="game">Game layer</option>
                <option value="layout">Layout layer</option>
                <option value="correction">Correction layer</option>
              </select>
              <label className="text-[11px] text-app-text-muted">
                Opacity {Math.round(layerOpacity * 100)}%
                <input className="block w-full accent-app-accent" type="range" min="0.05" max="1" step="0.01" value={layerOpacity} onChange={(event) => setLayerOpacity(Number(event.target.value))} />
              </label>
            </div>
            <input className="mb-2 block w-full text-xs text-app-text-muted" type="file" accept="image/png,image/webp" onChange={(event) => setLayerFile(event.target.files?.[0] ?? null)} />
            <SourceEditor title="Layer provenance" source={layerSource} onChange={setLayerSource} />
            <Button type="button" onClick={() => void saveLayer()} disabled={!canSaveLayer || saving}>
              Save and assign layer
            </Button>
          </section>
        )}

        {lapId !== null && replay?.georeference ? (
          <p className="text-xs text-app-text-muted">
            GPS: recorded lap, {replay.georeference.kind}, RMSE {replay.georeference.quality.rmseM.toFixed(2)} m
          </p>
        ) : lapId === null && catalogReference ? (
          <p className="text-xs text-app-text-muted">GPS: exact-layout iRacing catalog match · {catalogReference.outlineSource} outline</p>
        ) : (
          <p className="text-xs text-severity-caution">Assign an exact-layout iRacing peer or choose a recorded GPS lap.</p>
        )}
        {status && <p className="mt-2 text-xs text-severity-nominal">{status}</p>}
        {error && <p className="mt-2 text-xs text-severity-critical">{error}</p>}
      </aside>

      <main className="relative min-h-[24rem] overflow-hidden p-4 @7xl/workspace:min-h-0">
        {calibrationReferenceLoading && <div className="grid h-full place-items-center text-sm text-app-text-muted">Loading calibration reference…</div>}
        {!calibrationReferenceLoading && (!viewBounds || !calibration) && (
          <div className="grid h-full place-items-center text-sm text-app-text-muted">Select open imagery or upload a base image after resolving catalog GPS or choosing a recorded lap.</div>
        )}
        {!calibrationReferenceLoading && viewBounds && calibration && (
          <svg
            className="h-full w-full cursor-default touch-none rounded border border-app-border bg-app-surface"
            viewBox={`${viewBounds.minX} ${viewBounds.minZ} ${viewBounds.width} ${viewBounds.height}`}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            aria-label="Track texture calibration preview"
          >
            {baseUrl && <image href={baseUrl} x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform={imageTransform} opacity="1" />}
            {displayedLayers.map((layer) => (
              <image
                key={layer.id}
                href={`/api/dev/track-imagery/venues/texture/${encodeURIComponent(layer.id)}?venueId=${encodeURIComponent(venue!.venueId)}&v=${assetVersion}`}
                x="0"
                y="0"
                width="1"
                height="1"
                preserveAspectRatio="none"
                transform={imageTransform}
                opacity={layer.opacity}
              />
            ))}
            {layerPreviewUrl && <image href={layerPreviewUrl} x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform={imageTransform} opacity={layerOpacity} />}
            <polygon
              points={imageCorners.map((point) => `${point.x},${point.z}`).join(" ")}
              fill="none"
              stroke="var(--app-accent)"
              strokeWidth={viewBounds.width / 600}
              strokeDasharray={`${viewBounds.width / 150} ${viewBounds.width / 150}`}
              pointerEvents="none"
            />
            <polyline
              points={gpsPolyline}
              fill="none"
              stroke="var(--track-outline-strong)"
              strokeWidth={viewBounds.width / 350}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            {calibrationHandles && (
              <g>
                <line
                  x1={calibrationHandles.top.x}
                  y1={calibrationHandles.top.z}
                  x2={calibrationHandles.rotate.x}
                  y2={calibrationHandles.rotate.z}
                  stroke="var(--app-accent)"
                  strokeWidth={calibrationHandles.radius * 0.35}
                  pointerEvents="none"
                />
                {imageCorners.map((point, index) => (
                  <rect
                    key={index}
                    data-calibration-handle="scale"
                    className="cursor-nwse-resize"
                    x={point.x - calibrationHandles.radius}
                    y={point.z - calibrationHandles.radius}
                    width={calibrationHandles.radius * 2}
                    height={calibrationHandles.radius * 2}
                    rx={calibrationHandles.radius * 0.2}
                    fill="var(--app-accent)"
                    stroke="var(--app-bg)"
                    strokeWidth={calibrationHandles.radius * 0.35}
                    onPointerDown={(event) => startCalibrationDrag("scale", event)}
                  >
                    <title>Drag to scale texture</title>
                  </rect>
                ))}
                <circle
                  data-calibration-handle="move"
                  className="cursor-move"
                  cx={calibrationHandles.center.x}
                  cy={calibrationHandles.center.z}
                  r={calibrationHandles.radius * 1.25}
                  fill="var(--app-accent)"
                  stroke="var(--app-bg)"
                  strokeWidth={calibrationHandles.radius * 0.35}
                  onPointerDown={(event) => startCalibrationDrag("move", event)}
                >
                  <title>Drag to move texture</title>
                </circle>
                <line
                  x1={calibrationHandles.center.x - calibrationHandles.radius * 0.65}
                  y1={calibrationHandles.center.z}
                  x2={calibrationHandles.center.x + calibrationHandles.radius * 0.65}
                  y2={calibrationHandles.center.z}
                  stroke="var(--app-bg)"
                  strokeWidth={calibrationHandles.radius * 0.25}
                  pointerEvents="none"
                />
                <line
                  x1={calibrationHandles.center.x}
                  y1={calibrationHandles.center.z - calibrationHandles.radius * 0.65}
                  x2={calibrationHandles.center.x}
                  y2={calibrationHandles.center.z + calibrationHandles.radius * 0.65}
                  stroke="var(--app-bg)"
                  strokeWidth={calibrationHandles.radius * 0.25}
                  pointerEvents="none"
                />
                <circle
                  data-calibration-handle="rotate"
                  className="cursor-grab"
                  cx={calibrationHandles.rotate.x}
                  cy={calibrationHandles.rotate.z}
                  r={calibrationHandles.radius * 1.25}
                  fill="var(--app-accent)"
                  stroke="var(--app-bg)"
                  strokeWidth={calibrationHandles.radius * 0.35}
                  onPointerDown={(event) => startCalibrationDrag("rotate", event)}
                >
                  <title>Drag to rotate texture</title>
                </circle>
                <text
                  x={calibrationHandles.rotate.x}
                  y={calibrationHandles.rotate.z}
                  dy="0.35em"
                  fill="var(--app-bg)"
                  fontSize={calibrationHandles.radius * 1.4}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  ↻
                </text>
              </g>
            )}
          </svg>
        )}
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded bg-app-bg/80 px-2 py-1 text-[10px] text-app-text-muted">
          Handles: center moves · corners scale · round handle rotates
        </div>
      </main>
    </div>
  );
}
