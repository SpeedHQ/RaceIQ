import { logicalSegmentCounts, segmentDisplayNames } from "@shared/racing/tracks/segment-label";
import type { TrackMapLayerKey, TrackMapLayerState } from "@/components/track-map/types";
import { TrackMapCanvas } from "@/components/track-map/TrackMapCanvas";
import { TrackMapLayerCheckboxes, type TrackMapLayerMenuItem } from "@/components/track-map/TrackMapLayerMenu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { TrackDebugPanel } from "../debug/TrackDebugPanel";
import { TrackDebugSidebar } from "./TrackDebugSidebar";
import type { TrackGeometryEditorModel } from "./useTrackGeometryEditor";

export interface TrackGeometryWorkspaceProps {
  model: TrackGeometryEditorModel;
  mode: "turns" | "sectors";
  layers: TrackMapLayerState;
  onLayerChange: (key: TrackMapLayerKey, checked: boolean) => void;
  editorScope: "all" | "active";
}

const layerLabels: Record<TrackMapLayerKey, string> = {
  imagery: "Imagery",
  boundaries: "Boundaries",
  pitLane: "Pit lane",
  outline: "Outline",
  racingLine: "Racing line",
  segments: "Segments",
  sectors: "Sectors",
  curbs: "Curbs",
  trace: "Trace",
  inputs: "Inputs",
  highlights: "Highlights",
  car: "Car",
};

export function TrackGeometryWorkspace({ model, mode, layers, onLayerChange, editorScope }: TrackGeometryWorkspaceProps) {
  const showSegmentsEditor = editorScope === "all" || mode === "turns";
  const showSectorsEditor = editorScope === "all" || mode === "sectors";
  const segments = model.editing && model.editSegments.length > 0 ? model.editSegments : model.sectors?.segments ?? null;
  const starts = model.timingSectors.starts;
  const layerItems: TrackMapLayerMenuItem[] = (Object.keys(layerLabels) as TrackMapLayerKey[]).map((key) => {
    const available =
      key === "outline"
        ? !!model.outline
        : key === "boundaries"
          ? !!model.boundaries?.leftEdge.length && !!model.boundaries.rightEdge.length
          : key === "pitLane"
            ? model.pitLines.length > 0 || !!model.boundaries?.pitLane?.length
            : key === "racingLine"
              ? !!model.boundaries?.raceLine && model.boundaries.raceLine.length > 1
              : key === "curbs"
                ? !!model.curbs?.length
                : key === "imagery"
                  ? !!model.imagery && !!model.imageryGeographicPositions?.length
                  : key === "segments"
                    ? !!segments?.length
                    : key === "sectors"
                      ? !!starts?.length
                      : false;
    const unavailableReason = model.outlineLoading && key === "outline" ? "Loading" : available ? undefined : "No data";
    return { key, label: layerLabels[key], available, unavailableReason };
  });
  const mapBoundaries = model.boundaries
    ? {
        leftEdge: model.boundaries.leftEdge,
        rightEdge: model.boundaries.rightEdge,
        centerLine: model.boundaries.centerLine ?? [],
        pitLane: model.boundaries.pitLane,
        coordSystem: model.boundaries.coordSystem,
        raceLine: model.boundaries.raceLine,
      }
    : null;
  const mapSectors = starts ? { sectorStarts: starts, sectorCount: starts.length } : null;
  const { corners, straights } = logicalSegmentCounts(segments ?? []);
  const names = segmentDisplayNames(segments ?? []);

  return (
    <div data-geometry-mode={mode} className="flex min-h-0 flex-col gap-3 @7xl/workspace:grid @7xl/workspace:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-h-0 flex-col gap-3">
        {model.dataErrors.map((message) => (
          <Alert key={message} variant="destructive">
            <AlertTitle>Geometry data unavailable</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ))}
        <TrackMapLayerCheckboxes layers={layers} items={layerItems} onLayerChange={onLayerChange} />
        <div className="min-h-[320px] flex-1 overflow-hidden rounded-lg border border-app-border bg-app-surface">
          {model.outlineLoading ? (
            <Skeleton className="h-full min-h-[320px] w-full" />
          ) : model.outline ? (
            <TrackMapCanvas
              gameId={model.gameId ?? undefined}
              telemetry={[]}
              cursorIdx={0}
              outline={model.outline}
              mapLabels={model.labels}
              pitLines={model.pitLines}
              imagery={model.imagery}
              geographicPositions={model.imageryGeographicPositions ?? undefined}
              boundaries={mapBoundaries}
              sectors={mapSectors}
              segments={segments}
              curbs={model.curbs}
              layers={layers}
              rotateWithCar={false}
            />
          ) : (
            <Empty className="min-h-[320px]">
              <EmptyHeader>
                <EmptyTitle>Track outline missing</EmptyTitle>
                <EmptyDescription>Import or record track geometry before using map tools.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <TrackDebugPanel
          trackOrdinal={model.track.ordinal}
          outline={model.outline}
          displaySectors={segments ? { segments, totalDist: model.sectors?.totalDist ?? 0 } : null}
          sectorBounds={model.sectorBounds}
          editingSegments={model.editing}
          editingSectors={model.editingSectors}
          trackLengthKm={model.track.lengthKm}
          trackCreatedAt={model.track.createdAt ?? undefined}
          corners={corners}
          straights={straights}
        />
      </div>
      <TrackDebugSidebar
        track={model.track}
        gameId={model.gameId}
        displaySectors={segments ? { segments, totalDist: model.sectors?.totalDist ?? 0 } : null}
        segSource={model.segmentSource}
        showSegments={showSegmentsEditor}
        showSectors={showSectorsEditor}
        editing={model.editing}
        editSegments={model.editSegments}
        saving={model.saving}
        saveError={model.saveError}
        generatingSegments={model.generatingSegments}
        generateSegmentsError={model.generateSegmentsError}
        sectorBounds={model.sectorBounds}
        timingSectors={model.timingSectors}
        timingSectorsLoading={model.timingSectorsLoading}
        timingSectorsError={model.timingSectorsError}
        sectorSaveError={model.sectorSaveError}
        editingSectors={model.editingSectors}
        editS1={model.editS1}
        editS2={model.editS2}
        savingSectors={model.savingSectors}
        segDisplayNames={names}
        startEditing={model.startEditing}
        saveSegments={model.saveSegments}
        generateSegments={model.generateSegments}
        toggleSegType={model.toggleSegType}
        addSegment={model.addSegment}
        removeSegment={model.removeSegment}
        updateSegFrac={model.updateSegFrac}
        cancelEditing={model.cancelEditing}
        startEditingSectors={model.startEditingSectors}
        saveSectorBounds={model.saveSectorBounds}
        setEditingSectors={model.setEditingSectors}
        setEditS1={model.setEditS1}
        setEditS2={model.setEditS2}
      />
    </div>
  );
}
