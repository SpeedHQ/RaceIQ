import { useEffect, useState } from "react";
import { useSaveSettings, useSettings } from "../../hooks/settings";
import { m } from "../../paraglide/messages";
import { useLiveEngineerVoicePackStatus } from "../../hooks/live-engineer-voice-pack";

const clampVolume = (value: number) => Math.min(1, Math.max(0, value));

export function RadioModal({ showPackageGate = true }: { showPackageGate?: boolean } = {}) {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const status = useLiveEngineerVoicePackStatus();
  const [volume, setVolume] = useState(displaySettings.radioVolume);
  const [saveError, setSaveError] = useState(false);
  useEffect(() => setVolume(displaySettings.radioVolume), [displaySettings.radioVolume]);
  const save = (patch: Record<string, unknown>) => {
    setSaveError(false);
    saveSettings.mutate(patch, { onError: () => setSaveError(true) });
  };
  const voiceReady = status.data?.state === "ready" && !status.isError && !status.isFetching;
  const toggle = (key: "radioSpotterEnabled" | "radioRaceEngineerEnabled" | "radioTextCalloutsEnabled") => save({ [key]: !displaySettings[key] });
  const commitVolume = () => { const next = clampVolume(volume); if (next !== displaySettings.radioVolume) save({ radioVolume: next }); };
  const switches = [
    ["radioSpotterEnabled", m.settings_radio_spotter(), m.settings_radio_spotter_desc(), true],
    ["radioRaceEngineerEnabled", m.settings_radio_race_engineer(), m.settings_radio_race_engineer_desc(), true],
    ["radioTextCalloutsEnabled", m.settings_radio_text_callouts(), m.settings_radio_text_callouts_desc(), false],
  ] as const;
  return <div className="space-y-4">
    <p className="text-sm text-app-text-muted">{m.settings_radio_desc()}</p>
    {showPackageGate && <>
    {(status.isPending || status.isFetching) && <p role="status" className="text-sm text-app-text-muted">{m.radio_voice_pack_checking()}</p>}
    {status.isError && <div role="alert" className="space-y-2 text-sm text-status-danger"><p>{m.radio_voice_pack_status_failed()}</p><button type="button" className="underline" onClick={() => void status.refetch()}>{m.radio_voice_pack_check_again()}</button></div>}
    {!status.isError && !status.isFetching && status.data && status.data.state !== "ready" && <div className="space-y-2 rounded border border-app-border p-3 text-sm">
      <p className="font-medium">{status.data.state === "download-required" ? m.radio_voice_pack_download_required() : m.radio_voice_pack_update_required()}</p>
      <p>{m.radio_voice_pack_required_version({ version: status.data.requiredVersion, engineVersion: String(status.data.requiredEngineVersion), language: status.data.language })}</p>
      <a className="underline" href={status.data.downloadUrl} target="_blank" rel="noopener noreferrer">{m.radio_voice_pack_download_link()}</a>
      <p>{m.radio_voice_pack_install_guidance()}</p>
      <a className="block underline" href="https://github.com/SpeedHQ/RaceIQ/blob/main/docs/installation/windows.md#optional-live-engineer-voice-pack" target="_blank" rel="noopener noreferrer">{m.radio_voice_pack_install_docs()}</a>
      <button type="button" className="block underline" onClick={() => void status.refetch()}>{m.radio_voice_pack_check_again()}</button>
    </div>}
    </>}
    {switches.map(([key, label, description, voice]) => <div key={key} className="flex items-center justify-between gap-4">
      <div><p className="font-medium">{label}</p><p className="text-xs text-app-text-muted">{description}</p></div>
      <button type="button" role="switch" aria-label={label} aria-checked={displaySettings[key]} disabled={voice && !voiceReady} onClick={() => toggle(key)} className={`rounded-full border px-3 py-1 text-xs ${displaySettings[key] ? "border-app-accent text-app-accent" : "border-app-border text-app-text-muted"} disabled:cursor-not-allowed disabled:opacity-50`}>{displaySettings[key] ? m.common_enabled() : m.common_disabled()}</button>
    </div>)}
    <div className="space-y-2">
      <label htmlFor="radio-volume" className="block font-medium">{m.settings_radio_volume()} — {Math.round(volume * 100)}%</label>
      <input id="radio-volume" type="range" min="0" max="100" step="1" value={Math.round(volume * 100)} onChange={(event) => setVolume(Number(event.target.value) / 100)} onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume} className="w-full accent-app-accent" />
    </div>
    {saveError && <p role="alert" className="text-sm text-status-danger">{m.settings_radio_save_failed()}</p>}
  </div>;
}
