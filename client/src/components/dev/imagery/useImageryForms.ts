import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackImageryLayerKind, TrackImageryLayoutManifest, TrackImagerySource, TrackImageryVenueManifest } from "../../../../../shared/racing/tracks/imagery";

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

export const EMPTY_IMAGERY_SOURCE: TrackImagerySource = {
  name: "",
  url: "",
  capturedAt: "",
  license: "",
  attribution: "",
  provider: "manual",
};

export function normalizedImageryId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function imagerySourcePayload(source: TrackImagerySource): TrackImagerySource {
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

interface UseImageryFormsOptions {
  venue: TrackImageryVenueManifest | null;
  layout: TrackImageryLayoutManifest | null;
  assetVersion: number;
}

function useImageryBaseForm(venue: TrackImageryVenueManifest | null, assetVersion: number) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<TrackImagerySource>(EMPTY_IMAGERY_SOURCE);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [candidatePreviewUrl, setCandidatePreviewUrl] = useState<string | null>(null);
  const syncedSourceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) {
      setLocalPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setLocalPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const syncVenue = useCallback((nextVenue: TrackImageryVenueManifest | null) => {
    const sourceKey = nextVenue ? JSON.stringify(nextVenue.base.source) : null;
    if (syncedSourceKeyRef.current === sourceKey) return;
    syncedSourceKeyRef.current = sourceKey;
    setSource(nextVenue?.base.source ?? EMPTY_IMAGERY_SOURCE);
  }, []);

  useEffect(() => {
    syncVenue(venue);
  }, [syncVenue, venue]);

  const selectFile = useCallback((nextFile: File | null) => {
    setFile(nextFile);
    setCandidatePreviewUrl(null);
    if (nextFile) setSource(EMPTY_IMAGERY_SOURCE);
  }, []);

  const adoptCandidate = useCallback((nextSource: TrackImagerySource, previewUrl: string) => {
    setFile(null);
    setSource(nextSource);
    setCandidatePreviewUrl(previewUrl);
  }, []);

  const clearTransient = useCallback(() => {
    setFile(null);
    setCandidatePreviewUrl(null);
  }, []);

  const persistedPreviewUrl = venue ? `/api/dev/track-imagery/venues/texture/base?venueId=${encodeURIComponent(venue.venueId)}&v=${assetVersion}` : null;

  return {
    file,
    source,
    previewUrl: localPreviewUrl ?? candidatePreviewUrl ?? persistedPreviewUrl,
    valid: !!source.name.trim() && !!source.license.trim(),
    selectFile,
    adoptCandidate,
    setSource,
    clearTransient,
    syncVenue,
  };
}

function useImageryLayerForm(layout: TrackImageryLayoutManifest | null) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [id, setRawId] = useState("");
  const [kind, setKind] = useState<TrackImageryLayerKind>("layout");
  const [opacity, setOpacity] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<TrackImagerySource>(EMPTY_IMAGERY_SOURCE);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const syncedLayoutKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const syncLayout = useCallback((nextLayout: TrackImageryLayoutManifest | null) => {
    const layoutKey = nextLayout ? JSON.stringify(nextLayout.layers) : null;
    if (syncedLayoutKeyRef.current === layoutKey) return;
    syncedLayoutKeyRef.current = layoutKey;
    setSelectedIds(nextLayout?.layers ?? []);
  }, []);

  useEffect(() => {
    syncLayout(layout);
  }, [layout, syncLayout]);

  const setId = useCallback((value: string) => setRawId(normalizedImageryId(value)), []);
  const selectFile = useCallback((nextFile: File | null) => setFile(nextFile), []);
  const setSelected = useCallback((layerId: string, selected: boolean) => {
    setSelectedIds((current) => (selected ? (current.includes(layerId) ? current : [...current, layerId]) : current.filter((candidate) => candidate !== layerId)));
  }, []);
  const clearSavedFile = useCallback(() => setFile(null), []);

  return {
    selectedIds,
    setSelectedIds,
    setSelected,
    id,
    setId,
    kind,
    setKind,
    opacity,
    setOpacity,
    file,
    selectFile,
    source,
    setSource,
    previewUrl,
    valid: SAFE_ID.test(id) && !!file && !!source.name.trim() && !!source.license.trim(),
    syncLayout,
    clearSavedFile,
  };
}

export function useImageryForms({ venue, layout, assetVersion }: UseImageryFormsOptions) {
  const base = useImageryBaseForm(venue, assetVersion);
  const layer = useImageryLayerForm(layout);
  return { base, layer };
}

export type ImageryBaseFormModel = ReturnType<typeof useImageryForms>["base"];
export type ImageryLayerFormModel = ReturnType<typeof useImageryForms>["layer"];
