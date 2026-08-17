import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { TrackConfiguration } from "../../../../shared/racing/tracks/configuration";
import {
  defaultVenueImageryCalibration,
  geographicTrackImageryPoint,
  rotateTrackImageryMatrix,
  scaleTrackImageryMatrix,
  transformTrackImageryPoint,
  translateTrackImageryMatrix,
  type TrackImageryCalibration,
  type TrackImageryLayerKind,
  type TrackImageryLayoutManifest,
  type TrackImagerySource,
  type TrackImageryVenueManifest,
} from "../../../../shared/racing/tracks/imagery";
import { useLapSemanticTelemetry, useLaps } from "../../hooks/laps";
import { useGameId, useGameStore } from "../../stores/game";
import { TrackConfigurationBrowser, type TrackConfigurationSelection } from "./TrackConfigurationBrowser";
import { Button } from "../ui/button";

const EMPTY_SOURCE: TrackImagerySource = { name: "", url: "", capturedAt: "", license: "", attribution: "" };
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const VENUE_ID = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

function normalizedId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
function normalizedVenueId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/]+/, "");
}

function sourcePayload(source: TrackImagerySource): TrackImagerySource {
  return {
    name: source.name.trim(),
    ...(source.url?.trim() ? { url: source.url.trim() } : {}),
    ...(source.capturedAt?.trim() ? { capturedAt: source.capturedAt.trim() } : {}),
    license: source.license.trim(),
    attribution: source.attribution.trim(),
  };
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; z: number } | null {
  const inverse = svg.getScreenCTM()?.inverse();
  if (!inverse) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(inverse);
  return { x: point.x, z: point.y };
}

function sourceField(source: TrackImagerySource, key: keyof TrackImagerySource): string {
  return source[key] ?? "";
}

function SourceEditor({ title, source, onChange }: { title: string; source: TrackImagerySource; onChange: (source: TrackImagerySource) => void }) {
  const update = (key: keyof TrackImagerySource, value: string) => onChange({ ...source, [key]: value });
  return (
    <fieldset className="mb-3 rounded border border-app-border p-2">
      <legend className="px-1 text-xs font-semibold text-app-text-secondary">{title}</legend>
      {(["name", "url", "capturedAt", "license", "attribution"] as const).map((key) => (
        <label key={key} className="mb-2 block text-[11px] font-medium capitalize text-app-text-muted last:mb-0">
          {key === "capturedAt" ? "Captured date" : key}
          <input
            className="mt-0.5 w-full rounded border border-app-border-input bg-app-surface px-2 py-1 text-xs text-app-text"
            type={key === "capturedAt" ? "date" : key === "url" ? "url" : "text"}
            value={sourceField(source, key)}
            onChange={(event) => update(key, event.target.value)}
            placeholder={key === "license" ? "CC BY 4.0, public domain, owned" : undefined}
          />
        </label>
      ))}
    </fieldset>
  );
}

export function TrackImageryCalibrationPanel() {
  const storeGameId = useGameId();
  const queryClient = useQueryClient();
  const { data: laps = [] } = useLaps();
  const eligibleLaps = useMemo(() => laps.filter((lap) => lap.trackOrdinal != null && lap.lapTime > 0), [laps]);
  const [selectedTrack, setSelectedTrack] = useState<TrackConfigurationSelection | null>(null);
  const gameId = selectedTrack?.gameId ?? storeGameId;
  const calibrationLaps = useMemo(() => (selectedTrack ? eligibleLaps.filter((lap) => lap.trackOrdinal === selectedTrack.trackOrdinal) : eligibleLaps), [eligibleLaps, selectedTrack]);
  const [lapId, setLapId] = useState<number | null>(null);
  useEffect(() => {
    if (!calibrationLaps.some((lap) => lap.id === lapId)) setLapId(calibrationLaps[0]?.id ?? null);
  }, [calibrationLaps, lapId]);
  const selectedLap = calibrationLaps.find((lap) => lap.id === lapId) ?? null;
  const trackOrdinal = selectedTrack?.trackOrdinal ?? selectedLap?.trackOrdinal ?? null;
  const { data: replay, isLoading: replayLoading } = useLapSemanticTelemetry(lapId);
  const geographicPositions = replay?.geographicPositions ?? [];

  const [configuration, setConfiguration] = useState<TrackConfiguration | null>(null);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [venueId, setVenueId] = useState("");
  const [venue, setVenue] = useState<TrackImageryVenueManifest | null>(null);
  const [, setLayout] = useState<TrackImageryLayoutManifest | null>(null);
  const [calibration, setCalibration] = useState<TrackImageryCalibration | null>(null);
  const [baseFile, setBaseFile] = useState<File | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [baseAspectRatio, setBaseAspectRatio] = useState(1);
  const [baseSource, setBaseSource] = useState<TrackImagerySource>(EMPTY_SOURCE);
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
  const dragRef = useRef<{ pointerId: number; x: number; z: number } | null>(null);

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
        setVenueId(nextConfiguration?.venueId ?? "");
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load track configuration");
      });
    return () => {
      cancelled = true;
    };
  }, [configurationRevision, gameId, trackOrdinal]);

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
    if (configuration || venueId || !replay) return;
    const suggested = normalizedId(replay.georeference?.canonicalSlug ?? (trackOrdinal == null ? "" : `track-${trackOrdinal}`));
    if (suggested) setVenueId(suggested);
  }, [configuration, replay, trackOrdinal, venueId]);

  useEffect(() => {
    if (!VENUE_ID.test(venueId)) {
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
    setBaseUrl(venue ? `/api/dev/track-imagery/venues/texture/base?venueId=${encodeURIComponent(venue.venueId)}&v=${assetVersion}` : null);
  }, [assetVersion, baseFile, venue]);

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
    const points = [...gpsPath, ...imageCorners];
    if (points.length < 2) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    const padding = Math.max(maxX - minX, maxZ - minZ) * 0.1 || 10;
    return { minX: minX - padding, minZ: minZ - padding, width: maxX - minX + padding * 2, height: maxZ - minZ + padding * 2 };
  }, [gpsPath, imageCorners]);
  const imageTransform = calibration ? `matrix(${calibration.imageToEnu.join(" ")})` : undefined;
  const gpsPolyline = gpsPath.map((point) => `${point.x},${point.z}`).join(" ");
  const displayedLayers = venue?.layers.filter((candidate) => selectedLayers.includes(candidate.id)) ?? [];
  const baseSourceValid = !!baseSource.name.trim() && !!baseSource.license.trim();
  const canSaveBase = !!gameId && trackOrdinal != null && VENUE_ID.test(venueId) && !!calibration && baseSourceValid && (!!baseFile || !!venue);
  const layerSourceValid = !!layerSource.name.trim() && !!layerSource.license.trim();
  const canSaveLayer = !!venue && SAFE_ID.test(layerId) && !!layerFile && layerSourceValid;

  const updateCalibrationMatrix = (updater: (matrix: TrackImageryCalibration["imageToEnu"]) => TrackImageryCalibration["imageToEnu"]) => {
    setCalibration((current) => (current ? { ...current, imageToEnu: updater(current.imageToEnu) } : current));
  };
  const resetGpsFit = () => {
    const next = defaultVenueImageryCalibration(geographicPositions, baseAspectRatio);
    if (next) setCalibration(next);
  };
  const adjustScale = (factor: number) => updateCalibrationMatrix((matrix) => scaleTrackImageryMatrix(matrix, factor));
  const adjustRotation = (degrees: number) => updateCalibrationMatrix((matrix) => rotateTrackImageryMatrix(matrix, (degrees * Math.PI) / 180));

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!calibration || event.button !== 0) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, ...point };
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    updateCalibrationMatrix((matrix) => translateTrackImageryMatrix(matrix, point.x - drag.x, point.z - drag.z));
    drag.x = point.x;
    drag.z = point.z;
  };
  const handlePointerEnd = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    if (!calibration) return;
    event.preventDefault();
    if (event.shiftKey) adjustRotation(event.deltaY * 0.01);
    else adjustScale(Math.exp(-event.deltaY * 0.001));
  };

  const saveTrackConfiguration = async (nextVenueId: string) => {
    if (!gameId || trackOrdinal == null) throw new Error("Select a catalog track");
    if (configuration?.venueId === nextVenueId) return configuration;
    const response = await fetch(`/api/dev/track-configurations/${trackOrdinal}?gameId=${encodeURIComponent(gameId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, gameId, trackOrdinal, venueId: nextVenueId, confirmation: null }),
    });
    const result = (await response.json()) as TrackConfiguration | { error?: string };
    if (!response.ok) throw new Error((result as { error?: string }).error ?? "Unable to save track venue");
    const saved = result as TrackConfiguration;
    setConfiguration(saved);
    setConfigurationRevision((revision) => revision + 1);
    await queryClient.invalidateQueries({ queryKey: ["track-configurations"] });
    return saved;
  };

  const saveLayout = async (layers = selectedLayers) => {
    if (!gameId || trackOrdinal == null) throw new Error("Select a catalog track");
    const payload: TrackImageryLayoutManifest = { version: 1, gameId, trackOrdinal, layers };
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
      version: 1,
      venueId,
      calibration,
      base: { image: venue?.base.image ?? baseFile?.name ?? "base.webp", source: sourcePayload(baseSource) },
      layers: venue?.layers ?? [],
    };
    try {
      let response: Response;
      if (baseFile) {
        const body = new FormData();
        body.set("file", baseFile);
        body.set("manifest", JSON.stringify(manifest));
        response = await fetch(`/api/dev/track-imagery/venues/base?venueId=${encodeURIComponent(venueId)}`, { method: "POST", body });
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
      await saveTrackConfiguration(savedVenue.venueId);
      await saveLayout(selectedLayers.filter((id) => savedVenue.layers.some((layer) => layer.id === id)));
      setAssetVersion((version) => version + 1);
      setStatus("Opaque venue base and layout assignment saved.");
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
  const handleSelectTrack = (selection: TrackConfigurationSelection) => {
    useGameStore.getState().setGameId(selection.gameId);
    setSelectedTrack(selection);
    setLapId(null);
    setBaseFile(null);
    setLayerFile(null);
    setCalibration(null);
    setStatus(null);
    setError(null);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(25rem,32rem)_minmax(19rem,25rem)_1fr] bg-app-bg">
      <TrackConfigurationBrowser selection={selectedTrack} onSelect={handleSelectTrack} onConfigurationChange={() => setConfigurationRevision((revision) => revision + 1)} />
      <aside className="overflow-y-auto border-r border-app-border p-4">
        <h1 className="mb-1 text-lg font-semibold text-app-text">Texture calibration</h1>
        <p className="mb-4 text-xs text-app-text-muted">One opaque venue base; reusable transparent game, layout, and correction layers.</p>

        <label className="mb-3 block text-xs font-medium text-app-text-secondary">
          Calibration lap
          <select
            className="mt-1 w-full rounded border border-app-border-input bg-app-surface px-2 py-1.5 text-sm text-app-text"
            value={lapId ?? ""}
            onChange={(event) => setLapId(event.target.value ? Number(event.target.value) : null)}
          >
            {calibrationLaps.length === 0 && <option value="">No recorded laps for selected track</option>}
            {calibrationLaps.map((lap) => (
              <option key={lap.id} value={lap.id}>
                Lap {lap.lapNumber} · {(lap.lapTime / 1000).toFixed(3)}s
              </option>
            ))}
          </select>
        </label>

        <label className="mb-3 block text-xs font-medium text-app-text-secondary">
          Hierarchical venue path
          <input
            className="mt-1 w-full rounded border border-app-border-input bg-app-surface px-2 py-1.5 font-mono text-sm text-app-text"
            value={venueId}
            onChange={(event) => setVenueId(normalizedVenueId(event.target.value))}
            placeholder="daytona/historical/2011/road-course"
          />
        </label>

        <section className="mb-4 rounded border border-app-border p-3">
          <h2 className="mb-2 text-sm font-semibold text-app-text">Opaque venue base</h2>
          <input className="mb-2 block w-full text-xs text-app-text-muted" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setBaseFile(event.target.files?.[0] ?? null)} />
          <div className="mb-2 grid grid-cols-3 gap-1">
            <Button type="button" onClick={() => adjustScale(1 / 1.02)} disabled={!calibration}>
              Scale −
            </Button>
            <Button type="button" onClick={resetGpsFit} disabled={!baseUrl || geographicPositions.length < 2}>
              GPS fit
            </Button>
            <Button type="button" onClick={() => adjustScale(1.02)} disabled={!calibration}>
              Scale +
            </Button>
            <Button type="button" onClick={() => adjustRotation(-0.5)} disabled={!calibration}>
              Rotate −
            </Button>
            <span className="self-center text-center text-[10px] text-app-text-muted">100% fill</span>
            <Button type="button" onClick={() => adjustRotation(0.5)} disabled={!calibration}>
              Rotate +
            </Button>
          </div>
          <SourceEditor title="Base provenance" source={baseSource} onChange={setBaseSource} />
          <Button type="button" onClick={() => void saveBase()} disabled={!canSaveBase || saving}>
            {saving ? "Saving…" : venue ? "Update base" : "Save base"}
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

        {replay?.georeference ? (
          <p className="text-xs text-app-text-muted">
            GPS: {replay.georeference.kind}, RMSE {replay.georeference.quality.rmseM.toFixed(2)} m
          </p>
        ) : (
          <p className="text-xs text-severity-caution">Calibration lap needs GPS georeference.</p>
        )}
        {status && <p className="mt-2 text-xs text-severity-nominal">{status}</p>}
        {error && <p className="mt-2 text-xs text-severity-critical">{error}</p>}
      </aside>

      <main className="relative min-h-0 overflow-hidden p-4">
        {replayLoading && <div className="grid h-full place-items-center text-sm text-app-text-muted">Loading GPS path…</div>}
        {!replayLoading && (!viewBounds || !calibration) && <div className="grid h-full place-items-center text-sm text-app-text-muted">Upload a base image and select a GPS lap.</div>}
        {!replayLoading && viewBounds && calibration && (
          <svg
            className="h-full w-full cursor-move touch-none rounded border border-app-border bg-app-surface"
            viewBox={`${viewBounds.minX} ${viewBounds.minZ} ${viewBounds.width} ${viewBounds.height}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onWheel={handleWheel}
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
            />
            <polyline
              points={gpsPolyline}
              fill="none"
              stroke="var(--track-outline-strong)"
              strokeWidth={viewBounds.width / 350}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded bg-app-bg/80 px-2 py-1 text-[10px] text-app-text-muted">
          Base: 100% · Wheel: scale · Shift+wheel: rotate · Drag: move
        </div>
      </main>
    </div>
  );
}
