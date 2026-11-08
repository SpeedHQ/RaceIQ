import { useState } from "react";
import { RECORDING_FREQUENCIES_HZ, type RecordingFrequencyHz } from "@raceiq/shared/platform/runtime/recording-frequency";
import { Button } from "@/components/ui/button";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function RecordingFrequencyControl() {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const [saveFailed, setSaveFailed] = useState(false);

  async function selectFrequency(frequencyHz: RecordingFrequencyHz) {
    setSaveFailed(false);
    try {
      await saveSettings.mutateAsync({ recordingFrequencyHz: frequencyHz });
    } catch {
      setSaveFailed(true);
    }
  }

  return (
    <fieldset disabled={!settingsLoaded || saveSettings.isPending} className="space-y-2">
      <legend className="text-sm font-semibold text-app-text">{m.recording_frequency_label()}</legend>
      <p id="recording-frequency-description" className="text-sm text-app-text-muted">{m.recording_frequency_description()}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={m.recording_frequency_label()} aria-describedby="recording-frequency-description">
        {RECORDING_FREQUENCIES_HZ.map((frequencyHz) => (
          <Button
            key={frequencyHz}
            type="button"
            size="sm"
            variant={displaySettings.recordingFrequencyHz === frequencyHz ? "selected-toggle" : "outline"}
            aria-pressed={displaySettings.recordingFrequencyHz === frequencyHz}
            onClick={() => void selectFrequency(frequencyHz)}
          >
            {frequencyHz} Hz
          </Button>
        ))}
      </div>
      {saveFailed && <p role="alert" className="text-sm text-status-danger">{m.label_failed_to_save()}</p>}
    </fieldset>
  );
}
