import { useEffect, useState } from "react";
import { useSaveSettings, useSettings } from "../../hooks/settings";
import { m } from "../../paraglide/messages";

const clampVolume = (value: number) => Math.min(1, Math.max(0, value));

export function RadioModal() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [volume, setVolume] = useState(displaySettings.radioVolume);
  const [saveError, setSaveError] = useState(false);
  useEffect(() => setVolume(displaySettings.radioVolume), [displaySettings.radioVolume]);
  const save = (patch: Record<string, unknown>) => {
    setSaveError(false);
    saveSettings.mutate(patch, { onError: () => setSaveError(true) });
  };
  const toggle = (key: "radioSpotterEnabled" | "radioRaceEngineerEnabled" | "radioTextCalloutsEnabled") => save({ [key]: !displaySettings[key] });
  const commitVolume = () => { const next = clampVolume(volume); if (next !== displaySettings.radioVolume) save({ radioVolume: next }); };
  const switches = [
    ["radioSpotterEnabled", m.settings_radio_spotter(), m.settings_radio_spotter_desc()],
    ["radioRaceEngineerEnabled", m.settings_radio_race_engineer(), m.settings_radio_race_engineer_desc()],
    ["radioTextCalloutsEnabled", m.settings_radio_text_callouts(), m.settings_radio_text_callouts_desc()],
  ] as const;
  return <div className="space-y-4">
    <p className="text-sm text-app-text-muted">{m.settings_radio_desc()}</p>
    {switches.map(([key, label, description]) => <div key={key} className="flex items-center justify-between gap-4">
      <div><p className="font-medium">{label}</p><p className="text-xs text-app-text-muted">{description}</p></div>
      <button type="button" role="switch" aria-checked={displaySettings[key]} onClick={() => toggle(key)} className={`rounded-full border px-3 py-1 text-xs ${displaySettings[key] ? "border-app-accent text-app-accent" : "border-app-border text-app-text-muted"}`}>{displaySettings[key] ? m.common_enabled() : m.common_disabled()}</button>
    </div>)}
    <div className="space-y-2">
      <label htmlFor="radio-volume" className="block font-medium">{m.settings_radio_volume()} — {Math.round(volume * 100)}%</label>
      <input id="radio-volume" type="range" min="0" max="100" step="1" value={Math.round(volume * 100)} onChange={(event) => setVolume(Number(event.target.value) / 100)} onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume} className="w-full accent-app-accent" />
    </div>
    {saveError && <p role="alert" className="text-sm text-status-danger">{m.settings_radio_save_failed()}</p>}
  </div>;
}
