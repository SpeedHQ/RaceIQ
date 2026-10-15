import { useEffect, useState } from "react";
import { isRecordingRetentionPolicyValid, RECORDING_FREQUENCIES_HZ } from "@raceiq/shared/platform/runtime/recording-frequency";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldSet, FieldTitle } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";
import type { DisplaySettings } from "@/stores/telemetry";

const AGE_OPTIONS = [30, 90, 180, 365] as const;
type AgeDays = (typeof AGE_OPTIONS)[number];
type RetentionDraft = Pick<DisplaySettings, "sessionDownsampleEnabled" | "sessionDownsampleAgeDays" | "sessionDownsampleFrequencyHz" | "sessionCleanupEnabled" | "sessionCleanupAgeDays">;

function fromSettings(settings: RetentionDraft): RetentionDraft {
  return {
    sessionDownsampleEnabled: settings.sessionDownsampleEnabled,
    sessionDownsampleAgeDays: settings.sessionDownsampleAgeDays,
    sessionDownsampleFrequencyHz: settings.sessionDownsampleFrequencyHz,
    sessionCleanupEnabled: settings.sessionCleanupEnabled,
    sessionCleanupAgeDays: settings.sessionCleanupAgeDays,
  };
}

function sameDraft(a: RetentionDraft, b: RetentionDraft) {
  return (
    a.sessionDownsampleEnabled === b.sessionDownsampleEnabled &&
    a.sessionDownsampleAgeDays === b.sessionDownsampleAgeDays &&
    a.sessionDownsampleFrequencyHz === b.sessionDownsampleFrequencyHz &&
    a.sessionCleanupEnabled === b.sessionCleanupEnabled &&
    a.sessionCleanupAgeDays === b.sessionCleanupAgeDays
  );
}

export function RecordingRetentionControls({ disabled = false }: { disabled?: boolean }) {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const [baseline, setBaseline] = useState<RetentionDraft | null>(null);
  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settingsLoaded) return;
    const incoming = fromSettings(displaySettings);
    if (baseline === null || draft === null) {
      setBaseline(incoming);
      setDraft(incoming);
      return;
    }
    if (!sameDraft(incoming, baseline)) {
      if (sameDraft(draft, baseline)) setDraft(incoming);
      setBaseline(incoming);
    }
  }, [settingsLoaded, displaySettings, baseline, draft]);

  if (!draft || !baseline) return null;
  const policyInvalid = !isRecordingRetentionPolicyValid(draft);
  const dirty = !sameDraft(draft, baseline);
  const locked = disabled || !settingsLoaded || saveSettings.isPending;
  const update = (changes: Partial<RetentionDraft>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
    setSaveError(false);
    setSaved(false);
  };
  const save = async () => {
    if (policyInvalid || !dirty || locked) return;
    setSaveError(false);
    setSaved(false);
    try {
      const savedValues = { ...draft };
      await saveSettings.mutateAsync(savedValues);
      setBaseline(savedValues);
      setDraft(savedValues);
      setSaved(true);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <FieldSet className="gap-3">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-3">
          <Field orientation="horizontal" className="items-start">
            <FieldContent>
              <FieldTitle>{m.storage_auto_downsample_label()}</FieldTitle>
              <FieldDescription>{m.storage_auto_downsample_description()}</FieldDescription>
            </FieldContent>
            <Switch
              aria-label={m.storage_auto_downsample_label()}
              checked={draft.sessionDownsampleEnabled}
              disabled={locked}
              onCheckedChange={(checked) => update({ sessionDownsampleEnabled: checked })}
            />
          </Field>
          <Field data-invalid={policyInvalid || undefined}>
            <FieldLabel htmlFor="retention-downsample-age">{m.storage_downsample_after()}</FieldLabel>
            <select
              id="retention-downsample-age"
              aria-invalid={policyInvalid}
              className="h-9 w-full rounded-md border border-app-border-input bg-app-surface px-3 text-sm text-app-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
              value={draft.sessionDownsampleAgeDays}
              disabled={locked}
              onChange={(event) => update({ sessionDownsampleAgeDays: Number(event.target.value) as AgeDays })}
            >
              {AGE_OPTIONS.map((days) => (
                <option key={days} value={days} disabled={draft.sessionDownsampleEnabled && draft.sessionCleanupEnabled && days >= draft.sessionCleanupAgeDays}>
                  {m.sessions_cleanup_age_option({ days })}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="retention-downsample-frequency">{m.storage_downsample_frequency()}</FieldLabel>
            <select
              id="retention-downsample-frequency"
              className="h-9 w-full rounded-md border border-app-border-input bg-app-surface px-3 text-sm text-app-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
              value={draft.sessionDownsampleFrequencyHz}
              disabled={locked}
              onChange={(event) => update({ sessionDownsampleFrequencyHz: Number(event.target.value) as (typeof RECORDING_FREQUENCIES_HZ)[number] })}
            >
              {RECORDING_FREQUENCIES_HZ.map((hz) => (
                <option key={hz} value={hz}>
                  {hz} Hz
                </option>
              ))}
            </select>
          </Field>
        </section>
        <section className="flex min-w-0 flex-col gap-3">
          <Field orientation="horizontal" className="items-start">
            <FieldContent>
              <FieldTitle>{m.storage_auto_cleanup_label()}</FieldTitle>
              <FieldDescription>{m.storage_auto_cleanup_desc()}</FieldDescription>
            </FieldContent>
            <Switch aria-label={m.storage_auto_cleanup_label()} checked={draft.sessionCleanupEnabled} disabled={locked} onCheckedChange={(checked) => update({ sessionCleanupEnabled: checked })} />
          </Field>
          <Field data-invalid={policyInvalid || undefined}>
            <FieldLabel htmlFor="retention-delete-age">{m.storage_delete_after()}</FieldLabel>
            <select
              id="retention-delete-age"
              aria-invalid={policyInvalid}
              className="h-9 w-full rounded-md border border-app-border-input bg-app-surface px-3 text-sm text-app-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
              value={draft.sessionCleanupAgeDays}
              disabled={locked}
              onChange={(event) => update({ sessionCleanupAgeDays: Number(event.target.value) as AgeDays })}
            >
              {AGE_OPTIONS.map((days) => (
                <option key={days} value={days} disabled={draft.sessionDownsampleEnabled && draft.sessionCleanupEnabled && days <= draft.sessionDownsampleAgeDays}>
                  {m.sessions_cleanup_age_option({ days })}
                </option>
              ))}
            </select>
          </Field>
        </section>
      </div>
      {policyInvalid && (
        <Alert variant="destructive">
          <AlertDescription>{m.storage_retention_policy_error()}</AlertDescription>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{m.storage_save_failed()}</AlertDescription>
        </Alert>
      )}
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.storage_retention_saved()}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" variant="outline" disabled={locked || !dirty || policyInvalid} onClick={() => void save()}>
          {saveSettings.isPending ? m.common_saving() : m.common_save()}
        </Button>
      </div>
    </FieldSet>
  );
}
