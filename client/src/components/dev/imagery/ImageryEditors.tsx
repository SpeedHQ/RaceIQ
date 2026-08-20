import type { ReactNode } from "react";
import type { GameId } from "../../../../../shared/games/ids";
import type { TrackConfiguration } from "../../../../../shared/racing/tracks/configuration";
import type { TrackImageryCandidate, TrackImageryGeographicReference, TrackImagerySource, TrackImageryVenueManifest } from "../../../../../shared/racing/tracks/imagery";
import { formatLapTime } from "@/lib/format";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../ui/field";
import { Input } from "../../ui/input";
import { ImageryCandidatePanel } from "./ImageryCandidatePanel";
import { ImageryImportEstimate } from "./ImageryImportEstimate";
import type { ImageryCalibrationModel } from "./useImageryCalibration";
import type { ImageryBaseFormModel, ImageryLayerFormModel } from "./useImageryForms";

type SourceTextField = "name" | "url" | "capturedAt" | "license" | "attribution";

function sourceField(source: TrackImagerySource, key: SourceTextField): string {
  return source[key] ?? "";
}

function catalogReferenceMatchLabel(match: TrackImageryGeographicReference["match"]): string {
  switch (match) {
    case "game-id":
      return "direct iRacing catalog";
    case "assigned-identity":
      return "exact-layout iRacing catalog";
    case "venue-identity":
      return "same-venue iRacing catalog";
    case "shared-name":
      return "shared-name iRacing catalog";
  }
}

function SourceEditor({ title, source, onChange, readOnly = false }: { title: string; source: TrackImagerySource; onChange: (source: TrackImagerySource) => void; readOnly?: boolean }) {
  const update = (key: SourceTextField, value: string) => onChange({ ...source, [key]: value });
  return (
    <FieldSet className="mb-3 rounded border border-app-border p-2">
      <FieldLegend className="px-1 text-xs font-semibold text-app-text-secondary">{title}</FieldLegend>
      <FieldGroup className="gap-2">
        {(["name", "url", "capturedAt", "license", "attribution"] as const).map((key) => (
          <Field key={key} className="gap-0.5">
            <FieldLabel className="text-[11px] font-medium capitalize text-app-text-muted" htmlFor={`${title}-${key}`}>
              {key === "capturedAt" ? "Captured date" : key}
            </FieldLabel>
            <Input
              id={`${title}-${key}`}
              className="h-auto px-2 py-1 text-xs"
              type={key === "capturedAt" ? "date" : key === "url" ? "url" : "text"}
              disabled={readOnly}
              value={sourceField(source, key)}
              onChange={(event) => update(key, event.target.value)}
              placeholder={key === "license" ? "CC BY 4.0, public domain, owned" : undefined}
            />
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}

export function ImageryCalibrationEditor({ model }: { model: ImageryCalibrationModel }) {
  return (
    <label className="mb-3 block text-xs font-medium text-app-text-secondary">
      Calibration reference
      <select
        className="mt-1 w-full rounded border border-app-border-input bg-app-surface px-2 py-1.5 text-sm text-app-text"
        value={model.lapId ?? ""}
        onChange={(event) => model.setLapId(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">
          {model.referenceLoading && model.lapId === null
            ? "Loading catalog GPS…"
            : model.catalogReference
              ? `Catalog · ${model.catalogReference.sourceName} (#${model.catalogReference.sourceTrackOrdinal})${model.catalogReference.alignmentRmseM !== null ? ` · auto-aligned, RMSE ${model.catalogReference.alignmentRmseM.toFixed(2)} m` : ""}`
              : "Catalog GPS unavailable"}
        </option>
        {model.selectableLaps.length === 0 && <option disabled>No recorded laps for selected track</option>}
        {model.selectableLaps.map((lap) => (
          <option key={lap.id} value={lap.id}>
            Recorded lap {lap.lapNumber} · {formatLapTime(lap.lapTime)}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ImageryBaseEditorProps {
  gameId: GameId;
  trackOrdinal: number;
  boundsEnabled: boolean;
  calibration: ImageryCalibrationModel;
  form: ImageryBaseFormModel;
  selectedCandidate: TrackImageryCandidate | null;
  budget: Parameters<typeof ImageryImportEstimate>[0]["budget"] | null;
  estimating: boolean;
  saving: boolean;
  canSave: boolean;
  venueExists: boolean;
  onSelectCandidate: (candidate: TrackImageryCandidate, previewUrl: string) => void;
  onSelectFile: (file: File | null) => void;
  onResetGpsFit: () => void;
  onSave: () => void;
}

export function ImageryBaseEditor({
  gameId,
  trackOrdinal,
  boundsEnabled,
  calibration,
  form,
  selectedCandidate,
  budget,
  estimating,
  saving,
  canSave,
  venueExists,
  onSelectCandidate,
  onSelectFile,
  onResetGpsFit,
  onSave,
}: ImageryBaseEditorProps) {
  return (
    <section className="mb-4 rounded border border-app-border p-3">
      <h2 className="mb-2 text-sm font-semibold text-app-text">Opaque venue base</h2>
      <ImageryCandidatePanel
        bounds={boundsEnabled ? calibration.bounds : null}
        gameId={gameId}
        trackOrdinal={trackOrdinal}
        selectedCandidateId={selectedCandidate?.id ?? null}
        onSelect={onSelectCandidate}
      />
      {estimating && <p className="mb-2 text-[11px] text-app-text-muted">Calculating width, pixels, tiles, work, pack size, disk, duration, and concurrency…</p>}
      {budget && <ImageryImportEstimate budget={budget} />}
      <Input
        className="mb-2 block h-auto w-full border-0 bg-transparent px-0 py-0 text-xs text-app-text-muted shadow-none"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => onSelectFile(event.target.files?.[0] ?? null)}
      />
      <Button type="button" className="mb-2 w-full" onClick={onResetGpsFit} disabled={!form.previewUrl || calibration.geographicPositions.length < 2}>
        Reset to GPS fit
      </Button>
      <SourceEditor title="Base provenance" source={form.source} onChange={form.setSource} readOnly={!!selectedCandidate} />
      <Button type="button" onClick={onSave} disabled={!canSave || saving}>
        {saving ? "Saving…" : selectedCandidate ? `Import ${selectedCandidate.quality === "hq" ? "HQ" : "context fallback"} image` : venueExists ? "Update base" : "Save base"}
      </Button>
    </section>
  );
}

interface ImageryLayersEditorProps {
  venue: TrackImageryVenueManifest;
  form: ImageryLayerFormModel;
  saving: boolean;
  onSaveStack: () => void;
  onSaveLayer: () => void;
}

export function ImageryLayersEditor({ venue, form, saving, onSaveStack, onSaveLayer }: ImageryLayersEditorProps) {
  return (
    <>
      <section className="mb-4 rounded border border-app-border p-3">
        <h2 className="mb-2 text-sm font-semibold text-app-text">Layout layer stack</h2>
        {venue.layers.length === 0 && <p className="mb-2 text-xs text-app-text-muted">No reusable layers yet.</p>}
        <FieldGroup className="mb-2 gap-1">
          {venue.layers.map((layer) => (
            <Field key={layer.id} orientation="horizontal" className="gap-2 text-xs text-app-text-secondary">
              <Checkbox id={`imagery-layer-${layer.id}`} checked={form.selectedIds.includes(layer.id)} onCheckedChange={(checked) => form.setSelected(layer.id, checked === true)} />
              <FieldLabel htmlFor={`imagery-layer-${layer.id}`} className="gap-2 text-xs font-normal text-app-text-secondary">
                <span className="font-mono">{layer.id}</span>
                <span className="text-app-text-muted">{layer.kind}</span>
              </FieldLabel>
            </Field>
          ))}
        </FieldGroup>
        <Button type="button" onClick={onSaveStack} disabled={saving}>
          Save layer stack
        </Button>
      </section>

      <section className="mb-4 rounded border border-app-border p-3">
        <h2 className="mb-2 text-sm font-semibold text-app-text">Add transparent layer</h2>
        <Input className="mb-2 h-auto w-full px-2 py-1 font-mono text-xs" value={form.id} onChange={(event) => form.setId(event.target.value)} placeholder="road-course" />
        <div className="mb-2 grid grid-cols-2 gap-2">
          <select
            className="rounded border border-app-border-input bg-app-surface px-2 py-1 text-xs text-app-text"
            value={form.kind}
            onChange={(event) => form.setKind(event.target.value as typeof form.kind)}
          >
            <option value="game">Game layer</option>
            <option value="layout">Layout layer</option>
            <option value="correction">Correction layer</option>
          </select>
          <label className="text-[11px] text-app-text-muted">
            Opacity {Math.round(form.opacity * 100)}%
            <input className="block w-full accent-app-accent" type="range" min="0.05" max="1" step="0.01" value={form.opacity} onChange={(event) => form.setOpacity(Number(event.target.value))} />
          </label>
        </div>
        <Input
          className="mb-2 block h-auto w-full border-0 bg-transparent px-0 py-0 text-xs text-app-text-muted shadow-none"
          type="file"
          accept="image/png,image/webp"
          onChange={(event) => form.selectFile(event.target.files?.[0] ?? null)}
        />
        <SourceEditor title="Layer provenance" source={form.source} onChange={form.setSource} />
        <Button type="button" onClick={onSaveLayer} disabled={!form.valid || saving}>
          Save and assign layer
        </Button>
      </section>
    </>
  );
}

interface ImageryPackStatusProps {
  configuration: TrackConfiguration | null;
  venueId: string;
  calibration: ImageryCalibrationModel;
  status: string | null;
  error: string | null;
  children: ReactNode;
}

export function ImageryPackStatus({ configuration, venueId, calibration, status, error, children }: ImageryPackStatusProps) {
  return (
    <>
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

      {children}

      {calibration.lapId !== null && calibration.replay?.georeference ? (
        <p className="text-xs text-app-text-muted">
          GPS: recorded lap, {calibration.replay.georeference.kind}, RMSE {calibration.replay.georeference.quality.rmseM.toFixed(2)} m
        </p>
      ) : calibration.lapId === null && calibration.catalogReference ? (
        <p className="text-xs text-app-text-muted">GPS: {catalogReferenceMatchLabel(calibration.catalogReference.match)} match · {calibration.catalogReference.outlineSource} outline</p>
      ) : (
        <p className="text-xs text-severity-caution">Assign track to a venue with an iRacing reference or choose a recorded GPS lap.</p>
      )}
      {status && <p className="mt-2 text-xs text-severity-nominal">{status}</p>}
      {error && <p className="mt-2 text-xs text-severity-critical">{error}</p>}
    </>
  );
}
