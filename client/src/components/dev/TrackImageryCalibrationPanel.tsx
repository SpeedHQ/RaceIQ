import { useEffect, useMemo, useRef, useState } from "react";
import {
  TRACK_IMAGERY_MANIFEST_VERSION,
  type TrackImageryCandidate,
  type TrackImageryVenueManifest,
} from "../../../../shared/racing/tracks/imagery";
import type { TrackConfigurationSelection } from "./TrackConfigurationBrowser";
import { ImageryBaseEditor, ImageryCalibrationEditor, ImageryLayersEditor, ImageryPackStatus } from "./imagery/ImageryEditors";
import { ImageryPreview } from "./imagery/ImageryPreview";
import { imagerySourcePayload, useImageryForms } from "./imagery/useImageryForms";
import { useImageryCalibration } from "./imagery/useImageryCalibration";
import { useImageryImportJob } from "./imagery/useImageryImportJob";
import { useImageryPackMutations } from "./imagery/useImageryPackMutations";
import { useImageryPackStatus } from "./imagery/useImageryPackStatus";

export function TrackImageryCalibrationPanel({ selection, configurationRevision }: { selection: TrackConfigurationSelection; configurationRevision: number }) {
  const { gameId, trackOrdinal } = selection;
  const pack = useImageryPackStatus({ gameId, trackOrdinal, configurationRevision });
  const mutations = useImageryPackMutations({ gameId, trackOrdinal, venueId: pack.venueId });
  const forms = useImageryForms({ venue: pack.venue, layout: pack.layout, assetVersion: mutations.assetVersion });
  const calibration = useImageryCalibration({
    gameId,
    trackOrdinal,
    catalogReference: pack.catalogReference,
    catalogReferenceLoading: pack.catalogReferenceLoading,
    initialCalibration: pack.venue?.calibration ?? null,
    baseUrl: forms.base.previewUrl,
    selectedCandidate: null,
  });
  const importJob = useImageryImportJob({ gameId, trackOrdinal, venueId: pack.venueId, bounds: calibration.bounds });
  const [status, setStatus] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const hadCandidateRef = useRef(false);

  useEffect(() => {
    if (hadCandidateRef.current && !importJob.selectedCandidate) forms.base.clearTransient();
    hadCandidateRef.current = importJob.selectedCandidate !== null;
  }, [forms.base.clearTransient, importJob.selectedCandidate]);

  useEffect(() => {
    setStatus(null);
    setOperationError(null);
  }, [gameId, trackOrdinal]);

  const displayedLayers = useMemo(
    () => pack.venue?.layers.filter((layer) => forms.layer.selectedIds.includes(layer.id)) ?? [],
    [forms.layer.selectedIds, pack.venue],
  );
  const baseBounds = calibration.bounds ?? pack.venue?.base.bounds ?? null;
  const saving = mutations.pending || importJob.importing;
  const canSaveBase =
    !!pack.configuration &&
    !!pack.venueId &&
    !!calibration.calibration &&
    !!baseBounds &&
    forms.base.valid &&
    (!!forms.base.file || (!!importJob.selectedCandidate && importJob.budget?.safe === true) || !!pack.venue) &&
    !importJob.estimating &&
    importJob.budget?.safe !== false;

  const handleCandidateSelect = async (candidate: TrackImageryCandidate, previewUrl: string) => {
    setStatus(null);
    setOperationError(null);
    const selected = await importJob.selectCandidate(candidate, previewUrl);
    if (!selected) return;
    forms.base.selectFile(null);
    forms.base.adoptCandidate(selected.source, previewUrl);
    calibration.fitToBounds(true);
  };

  const handleBaseFile = (file: File | null) => {
    forms.base.selectFile(file);
    importJob.clear();
  };

  const saveBase = async () => {
    if (!calibration.calibration || !baseBounds || !canSaveBase) return;
    setStatus(null);
    setOperationError(null);
    const selectedCandidate = importJob.selectedCandidate;
    const manifest: TrackImageryVenueManifest = {
      version: TRACK_IMAGERY_MANIFEST_VERSION,
      venueId: pack.venueId,
      calibration: calibration.calibration,
      base: {
        pack: "imagery.rqi",
        tileSize: 512,
        bounds: baseBounds,
        source: { ...imagerySourcePayload(forms.base.source), provider: forms.base.source.provider ?? "manual" },
      },
      layers: pack.venue?.layers ?? [],
    };

    try {
      let savedVenue: TrackImageryVenueManifest | null;
      if (forms.base.file) {
        savedVenue = await mutations.saveManualBase(forms.base.file, manifest);
      } else if (selectedCandidate && calibration.bounds) {
        savedVenue = await importJob.importSelected(calibration.calibration);
      } else {
        savedVenue = await mutations.saveManifest(manifest);
      }
      if (!savedVenue) return;
      const selectedLayers = forms.layer.selectedIds.filter((id) => savedVenue.layers.some((layer) => layer.id === id));
      forms.layer.setSelectedIds(selectedLayers);
      await mutations.saveLayout(selectedLayers);
      await mutations.invalidateRuntime();
      mutations.markAssetChanged();
      forms.base.clearTransient();
      importJob.clear();
      setStatus(
        selectedCandidate
          ? `${selectedCandidate.quality === "hq" ? "HQ" : "Context fallback"} open imagery imported and assigned.`
          : "Opaque venue base and layout assignment saved.",
      );
    } catch (saveError) {
      setOperationError(saveError instanceof Error ? saveError.message : "Unable to save venue base");
    }
  };

  const saveLayer = async () => {
    if (!pack.venue || !forms.layer.file || !forms.layer.valid) return;
    setStatus(null);
    setOperationError(null);
    const layerId = forms.layer.id;
    try {
      await mutations.saveLayer(forms.layer.file, {
        id: layerId,
        image: forms.layer.file.name,
        kind: forms.layer.kind,
        opacity: forms.layer.opacity,
        source: imagerySourcePayload(forms.layer.source),
      });
      const nextLayers = forms.layer.selectedIds.includes(layerId) ? forms.layer.selectedIds : [...forms.layer.selectedIds, layerId];
      forms.layer.setSelectedIds(nextLayers);
      await mutations.saveLayout(nextLayers);
      await mutations.invalidateRuntime();
      mutations.markAssetChanged();
      forms.layer.clearSavedFile();
      setStatus(`Layer ${layerId} saved and assigned to this layout.`);
    } catch (saveError) {
      setOperationError(saveError instanceof Error ? saveError.message : "Unable to save overlay layer");
    }
  };

  const saveLayerStack = async () => {
    setStatus(null);
    setOperationError(null);
    try {
      await mutations.saveLayout(forms.layer.selectedIds);
      await mutations.invalidateRuntime();
      setStatus("Layout layer stack saved.");
    } catch (saveError) {
      setOperationError(saveError instanceof Error ? saveError.message : "Unable to save layer stack");
    }
  };

  const error = operationError ?? importJob.error ?? mutations.error ?? calibration.error ?? pack.error;
  const visibleStatus = status ?? importJob.status;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 bg-app-bg @7xl/workspace:grid-cols-[minmax(19rem,25rem)_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-r border-app-border p-4">
        <h1 className="mb-1 text-lg font-semibold text-app-text">Imagery calibration</h1>
        <p className="mb-4 text-xs text-app-text-muted">One HQ venue package; reusable transparent game, layout, and correction layers.</p>

        <ImageryCalibrationEditor model={calibration} />
        <ImageryPackStatus configuration={pack.configuration} venueId={pack.venueId} calibration={calibration} status={visibleStatus} error={error}>
          <ImageryBaseEditor
            gameId={gameId}
            trackOrdinal={trackOrdinal}
            boundsEnabled={!!pack.configuration}
            calibration={calibration}
            form={forms.base}
            selectedCandidate={importJob.selectedCandidate}
            budget={importJob.budget}
            estimating={importJob.estimating}
            saving={saving}
            canSave={canSaveBase}
            venueExists={!!pack.venue}
            onSelectCandidate={(candidate, previewUrl) => void handleCandidateSelect(candidate, previewUrl)}
            onSelectFile={handleBaseFile}
            onResetGpsFit={() => calibration.fitToBounds(importJob.selectedCandidate !== null)}
            onSave={() => void saveBase()}
          />
          {pack.venue && (
            <ImageryLayersEditor
              venue={pack.venue}
              form={forms.layer}
              saving={saving}
              onSaveStack={() => void saveLayerStack()}
              onSaveLayer={() => void saveLayer()}
            />
          )}
        </ImageryPackStatus>
      </aside>

      <ImageryPreview
        calibration={calibration}
        baseUrl={forms.base.previewUrl}
        displayedLayers={displayedLayers}
        layerPreviewUrl={forms.layer.previewUrl}
        layerOpacity={forms.layer.opacity}
        venueId={pack.venueId}
        assetVersion={mutations.assetVersion}
      />
    </div>
  );
}
