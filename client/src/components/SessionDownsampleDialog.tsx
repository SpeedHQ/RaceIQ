import { RECORDING_FREQUENCIES_HZ, type RecordingFrequencyHz } from "@raceiq/shared/platform/runtime/recording-frequency";
import type { SessionDownsamplePreview, SessionDownsampleRequest } from "@raceiq/shared/racing/sessions/downsample";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SessionDownsampleSkipSummary } from "@/components/SessionDownsampleSkipSummary";
import { formatBytes } from "@/lib/format-bytes";
import { m } from "@/paraglide/messages";
import { previewSessionDownsample, useStartSessionDownsample } from "@/hooks/session-downsample";

const ages = [30, 90, 180, 365] as const;
type Scope = "all" | "older-than";

export function SessionDownsampleDialog({
  open,
  busy,
  initialRequest,
  onClose,
  onStarted,
}: {
  open: boolean;
  busy: boolean;
  initialRequest?: SessionDownsampleRequest | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [mode, setMode] = useState<Scope>(initialRequest?.mode ?? "all");
  const [age, setAge] = useState<(typeof ages)[number]>(initialRequest?.mode === "older-than" ? initialRequest.olderThanDays : 30);
  const [targetHz, setTargetHz] = useState<RecordingFrequencyHz>(initialRequest?.targetHz ?? 50);
  const [preview, setPreview] = useState<SessionDownsamplePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useStartSessionDownsample();
  const request: SessionDownsampleRequest = mode === "all" ? { mode, targetHz } : { mode, olderThanDays: age, targetHz };
  const clearPreview = () => {
    setPreview(null);
    setError(null);
  };
  const runPreview = async () => {
    setLoading(true);
    clearPreview();
    try {
      setPreview((await previewSessionDownsample(request)) as SessionDownsamplePreview);
    } catch (cause) {
      setError(`${m.storage_downsample_preview_failed()} ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setLoading(false);
    }
  };
  const begin = async () => {
    if (!preview || preview.candidateSessionIds.length === 0 || busy || start.isPending) return;
    try {
      await start.mutateAsync(request);
      onStarted();
      onClose();
    } catch (cause) {
      setError(`${m.storage_downsample_start_failed()} ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !loading && !start.isPending) onClose();
      }}
    >
      <DialogContent size="wide" className="max-h-[calc(100dvh-2rem)] overflow-y-auto" overlayClassName="bg-app-bg/60">
        <DialogHeader>
          <DialogTitle>{m.storage_downsample_title()}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-app-text-secondary">{m.storage_downsample_description()}</p>
        <FieldGroup className="min-w-0">
          <Field>
            <FieldLabel>{m.storage_downsample_scope()}</FieldLabel>
            <ToggleGroup
              value={[mode]}
              disabled={loading || start.isPending}
              variant="app-outline"
              className="flex w-full flex-wrap"
              aria-label={m.storage_downsample_scope()}
              onValueChange={(values) => {
                const value = values[0];
                if (value === "all" || value === "older-than") {
                  setMode(value);
                  clearPreview();
                }
              }}
            >
              <ToggleGroupItem value="all">{m.storage_downsample_scope_all()}</ToggleGroupItem>
              <ToggleGroupItem value="older-than">{m.storage_auto_cleanup_age()}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {mode === "older-than" && (
            <Field>
              <FieldLabel htmlFor="downsample-age">{m.storage_auto_cleanup_age()}</FieldLabel>
              <select
                id="downsample-age"
                value={age}
                disabled={loading || start.isPending}
                onChange={(event) => {
                  setAge(Number(event.target.value) as typeof age);
                  clearPreview();
                }}
                className="h-9 w-full rounded-md border border-app-border-input bg-app-surface px-2 text-sm text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/50"
              >
                {ages.map((days) => (
                  <option key={days} value={days}>
                    {m.sessions_cleanup_age_option({ days })}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field>
            <FieldLabel>{m.storage_downsample_frequency()}</FieldLabel>
            <ToggleGroup
              value={[String(targetHz)]}
              disabled={loading || start.isPending}
              variant="app-outline"
              className="flex w-full flex-wrap"
              aria-label={m.storage_downsample_frequency()}
              onValueChange={(values) => {
                const frequency = RECORDING_FREQUENCIES_HZ.find((hz) => String(hz) === values[0]);
                if (frequency) {
                  setTargetHz(frequency);
                  clearPreview();
                }
              }}
            >
              {RECORDING_FREQUENCIES_HZ.map((hz) => (
                <ToggleGroupItem key={hz} value={String(hz)}>
                  {hz} Hz
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </FieldGroup>
        <div className="flex flex-col gap-3 rounded-md border border-app-border bg-app-surface-alt/50 p-3 text-sm">
          <p>{m.storage_downsample_warning()}</p>
          <p className="text-app-text-secondary">{m.storage_downsample_analysis_warning()}</p>
        </div>
        {loading && (
          <p role="status" className="text-sm text-app-text-dim">
            {m.common_loading()}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-status-danger">
            {error}
          </p>
        )}
        {preview && (
          <div aria-live="polite" className="flex flex-col gap-3">
            <p className="text-sm font-medium text-app-text">
              {m.storage_downsample_preview_summary({ files: preview.fileCount, sessions: preview.candidateSessionIds.length, size: formatBytes(preview.sourceBytes) })}
            </p>
            {preview.candidateSessionIds.length === 0 && <p className="text-sm text-app-text-dim">{m.storage_downsample_no_candidates()}</p>}
            <SessionDownsampleSkipSummary skips={preview.skipped} title={m.storage_downsample_skipped()} />
          </div>
        )}
        <DialogFooter className="flex-wrap border-0 bg-transparent p-0">
          <Button variant="app-ghost" size="app-sm" disabled={loading || start.isPending} onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button variant="app-outline" size="app-sm" disabled={loading || start.isPending} onClick={() => void runPreview()}>
            {loading ? m.common_loading() : m.storage_downsample_preview()}
          </Button>
          <Button variant="destructive-outline" size="app-sm" disabled={loading || start.isPending || !preview || preview.candidateSessionIds.length === 0 || busy} onClick={() => void begin()}>
            {start.isPending ? m.common_loading() : m.storage_downsample_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
