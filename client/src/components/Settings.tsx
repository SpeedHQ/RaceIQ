import { LOCALES } from "@shared/locales";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { isDevelopment } from "@/lib/env";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { useSaveSettings, useSettings } from "../hooks/queries";
import { useUiStore } from "../stores/ui";
import { playBlip, preloadSound } from "./SectorTimes";

import { AboutSection } from "./settings/AboutSection";
import { AiSection } from "./settings/AiSection";
import { DiagnosticsSection } from "./settings/DiagnosticsSection";
import { ExtractionSection } from "./settings/ExtractionSection";
import { F1ExtractionSection } from "./settings/F1ExtractionSection";
import { GamesSection } from "./settings/GamesSection";
import { StorageSection } from "./settings/StorageSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { WheelPicker } from "./settings/WheelPicker";

// Re-export localStorage utilities so existing importers don't break
export {
  getSoundEnabled,
  getSoundType,
  getSoundUrl,
  getSoundVolume,
  getSteeringLock,
  getWheelStyle,
  SOUND_PRESETS,
  type SoundType,
  setSoundEnabled,
  setSoundType,
  setSoundUrl,
  setSoundVolume,
} from "../lib/settings-storage";

import {
  getSoundEnabled,
  getSoundType,
  getSoundUrl,
  getSoundVolume,
  getSteeringLock,
  getWheelStyle,
  SOUND_PRESETS,
  STEER_LOCK_KEY,
  setSoundEnabled,
  setSoundType,
  setSoundUrl,
  setSoundVolume,
  WHEEL_STYLE_KEY,
} from "../lib/settings-storage";

const NAV_ITEMS = [
  { id: "general", label: "General" },
  { id: "games", label: "Games" },
  { id: "connection", label: "Connection" },
  { id: "wheel", label: "Wheel" },
  { id: "speed", label: "Units" },
  { id: "sound", label: "Sound" },
  { id: "storage", label: "Storage" },
  { id: "ai", label: "AI Analysis" },
  { id: "developer", label: "Developer", devOnly: true },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]["id"];

// Localized display label per section id. Falls back to the English NAV_ITEMS
// label if a key is somehow missing.
const NAV_LABELS: Record<SectionId, () => string> = {
  general: m.label_general,
  games: m.label_games,
  connection: m.label_connection,
  wheel: m.label_wheel,
  speed: m.label_units,
  sound: m.label_sound,
  storage: m.settings_nav_storage,
  ai: m.label_ai_analysis,
  developer: m.settings_nav_developer,
  diagnostics: m.label_diagnostics,
  updates: m.label_updates,
  about: m.label_about,
};

export function Settings({ initialSection, onClose }: { initialSection?: SectionId; onClose?: () => void } = {}) {
  const { openOnboarding } = useUiStore();
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? "general");
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [udpPort, setUdpPort] = useState("5301");
  const [showF1SetupGuide, setShowF1SetupGuide] = useState(false);
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [steerLock, setSteerLock] = useState(() => String(getSteeringLock()));
  const [wheelStyle, setWheelStyle] = useState<string>(() => getWheelStyle());
  const [soundEnabled, setSoundEnabledState] = useState(() => getSoundEnabled());
  const [soundVolume, setSoundVolumeState] = useState(() => getSoundVolume());
  const [soundType, setSoundTypeState] = useState(() => getSoundType());
  const [soundUrl, setSoundUrlState] = useState(() => getSoundUrl());

  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [unitSystem, setUnitSystem] = useState<"metric" | "imperial">(displaySettings.unit);
  const [temperatureUnit, setTemperatureUnit] = useState<"C" | "F">(displaySettings.temperatureUnit);
  const [unitStatus, setUnitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [unitError, setUnitError] = useState("");

  const tempSettingsJson = JSON.stringify(displaySettings);
  useEffect(() => {
    setUnitSystem(displaySettings.unit);
    setTemperatureUnit(displaySettings.temperatureUnit);
  }, [tempSettingsJson]);

  // Seed UDP port from settings query
  const settingsQuery = useSettings();
  useEffect(() => {
    const data = settingsQuery.displaySettings;
    if (data.udpPort != null && savedPort === null) {
      setUdpPort(String(data.udpPort));
      setSavedPort(data.udpPort);
    }
  }, [settingsQuery.displaySettings]);

  const port = Number.parseInt(udpPort, 10);
  const hasChanges = savedPort === null || port !== savedPort;

  async function handleSave() {
    const savePort = Number.parseInt(udpPort, 10);
    if (Number.isNaN(savePort) || savePort < 1024 || savePort > 65535) {
      setStatus("error");
      setErrorMsg(m.settings_port_range_error());
      return;
    }

    setStatus("saving");
    setErrorMsg("");
    try {
      await saveSettings.mutateAsync({ udpPort: savePort });
      setSavedPort(savePort);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : m.label_failed_to_save());
    }
  }

  async function handleUnitSave() {
    setUnitStatus("saving");
    setUnitError("");
    try {
      await saveSettings.mutateAsync({
        unit: unitSystem,
        temperatureUnit,
      });
      setUnitStatus("saved");
      setTimeout(() => setUnitStatus("idle"), 2000);
    } catch (err) {
      setUnitStatus("error");
      setUnitError(err instanceof Error ? err.message : m.label_failed_to_save());
    }
  }

  return (
    <div className="@container/settings flex h-full flex-col @3xl/settings:flex-row">
      {/* Nav — horizontal tabs on mobile, sidebar on md+ */}
      <nav className="flex shrink-0 overflow-x-auto border-b border-app-border bg-app-surface-alt/50 py-2 @3xl/settings:w-48 @3xl/settings:flex-col @3xl/settings:overflow-x-visible @3xl/settings:border-r @3xl/settings:border-b-0">
        {NAV_ITEMS.filter((item) => !("devOnly" in item) || isDevelopment).map((item) => (
          <Button
            variant="app-ghost"
            size="app-md"
            key={item.id}
            onClick={() => setActiveSection(item.id)}
            className={`shrink-0 md:w-full !justify-start !rounded-none !px-4 !py-2 text-sm whitespace-nowrap transition-colors ${
              activeSection === item.id
                ? "border-b-2 border-app-accent bg-app-accent/10 text-app-accent @3xl/settings:border-r-2 @3xl/settings:border-b-0"
                : "text-app-text-muted hover:text-app-text hover:bg-app-surface-hover"
            }`}
          >
            {(NAV_LABELS[item.id] ?? (() => item.label))()}
          </Button>
        ))}
        <div className="hidden md:block mt-auto pt-2 border-t border-app-border mx-2">
          <Button
            variant="app-ghost"
            size="app-md"
            className="w-full !justify-start !rounded-none !px-4 !py-2 text-sm text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
            onClick={() => {
              onClose?.();
              openOnboarding();
            }}
          >
            {m.settings_setup_wizard()}
          </Button>
        </div>
        <Button
          variant="app-ghost"
          size="app-md"
          className="shrink-0 !rounded-none !px-4 !py-2 text-sm whitespace-nowrap text-app-text-muted hover:text-app-text transition-colors border-l border-app-border ml-auto"
          onClick={() => {
            onClose?.();
            openOnboarding();
          }}
        >
          {m.settings_setup_wizard()}
        </Button>
      </nav>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto p-4 @3xl/settings:p-6">
        {activeSection === "general" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">{m.label_general()}</h2>
            <p className="text-sm text-app-text-muted mb-4">{m.settings_general_desc()}</p>

            <div className="max-w-xs mb-6">
              <Label className="text-app-text-secondary">{m.label_language()}</Label>
              <div className="mt-1.5">
                <SearchSelect
                  value={displaySettings.language ?? "en"}
                  onChange={async (code) => {
                    await saveSettings.mutateAsync({ language: code });
                    // Switch language in place (no page reload — keeps the live
                    // WebSocket/telemetry alive). Re-renders all m.* via the
                    // uiLocale remount key in __root.tsx.
                    applyLocale(code);
                  }}
                  options={LOCALES.map((loc) => ({ value: loc.code, label: `${loc.label} (${loc.code})` }))}
                  placeholder={m.settings_language_search_placeholder()}
                  focusColor="app-accent"
                />
              </div>
              <p className="text-app-text-muted text-xs mt-1">{m.settings_language_desc()}</p>
            </div>

            <div className="max-w-xs">
              <Label className={`${displaySettings.isCompiled ? "text-app-text-secondary" : "text-app-text-muted"}`}>{m.label_launch_on_login()}</Label>
              <div className="flex items-center gap-3 mt-1.5">
                <Button
                  type="button"
                  role="switch"
                  disabled={!displaySettings.isCompiled}
                  aria-checked={!!displaySettings.launchOnLogin}
                  onClick={() => displaySettings.isCompiled && saveSettings.mutate({ launchOnLogin: !displaySettings.launchOnLogin })}
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent ${
                    !displaySettings.isCompiled
                      ? "opacity-40 cursor-not-allowed bg-app-surface-alt border border-app-border-input"
                      : displaySettings.launchOnLogin
                        ? "cursor-pointer bg-app-accent"
                        : "cursor-pointer bg-app-surface-alt border border-app-border-input"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-app-text shadow-lg ring-0 transition-transform ${
                      displaySettings.launchOnLogin ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </Button>
                <span className="text-sm text-app-text-muted">
                  {!displaySettings.isCompiled ? m.settings_launch_installed_only() : displaySettings.launchOnLogin ? m.common_enabled() : m.common_disabled()}
                </span>
              </div>
              <p className="text-app-text-muted text-xs mt-1">{m.settings_launch_on_login_desc()}</p>
            </div>
          </section>
        )}

        {activeSection === "games" && <GamesSection />}

        {activeSection === "connection" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">{m.settings_connection_title()}</h2>
            <p className="text-sm text-app-text-muted mb-4">{m.settings_connection_desc()}</p>

            <div className="flex items-end gap-3 max-w-xs">
              <div className="flex-1">
                <Label htmlFor="udp-port" className="text-app-text-secondary">
                  {m.label_udp_port()}
                </Label>
                <Input
                  id="udp-port"
                  type="number"
                  min={1024}
                  max={65535}
                  value={udpPort}
                  onChange={(e) => {
                    setUdpPort(e.target.value);
                    setStatus("idle");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  className="border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1.5"
                  placeholder="5301"
                />
              </div>
              <Button onClick={handleSave} disabled={status === "saving" || !hasChanges} variant={status === "saved" ? "secondary" : "default"} className="shrink-0">
                {status === "saving" ? m.common_saving() : status === "saved" ? m.common_saved() : m.common_save()}
              </Button>
            </div>
            {status === "error" && <p className="text-status-danger text-sm mt-2">{errorMsg}</p>}
            {savedPort && (
              <p className="text-app-text-muted text-xs mt-3">
                {m.settings_listening_on()} 0.0.0.0:{savedPort}
              </p>
            )}

            <div className="mt-4 max-w-xs">
              <Label className="text-app-text-secondary">{m.settings_live_refresh_rate()}</Label>
              <select
                value={displaySettings.wsRefreshRate ?? "60"}
                onChange={(e) => saveSettings.mutate({ wsRefreshRate: e.target.value })}
                className="mt-1.5 w-full bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text"
              >
                <option value="60">60 Hz</option>
                <option value="50">50 Hz</option>
                <option value="40">40 Hz</option>
                <option value="30">30 Hz</option>
              </select>
              <p className="text-app-text-muted text-xs mt-1">{m.settings_live_refresh_rate_desc()}</p>
            </div>

            <div className="mt-4 max-w-xs">
              <Label className="text-app-text-secondary">{m.settings_render_frame_cap()}</Label>
              <select
                value={String(displaySettings.renderFpsCap ?? 60)}
                onChange={(e) => saveSettings.mutate({ renderFpsCap: Number(e.target.value) })}
                className="mt-1.5 w-full bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text"
              >
                <option value="120">120 fps</option>
                <option value="90">90 fps</option>
                <option value="60">60 fps</option>
                <option value="45">45 fps</option>
                <option value="30">30 fps</option>
                <option value="15">15 fps</option>
              </select>
              <p className="text-app-text-muted text-xs mt-1">{m.settings_render_frame_cap_desc()}</p>
            </div>

            <div className="mt-6 pt-6 border-t border-app-border">
              <Button variant="app-ghost" size="app-sm" onClick={() => setShowSetupGuide(!showSetupGuide)} className="!p-0 text-sm text-app-accent hover:text-app-accent/80">
                <svg aria-hidden="true" className={`w-4 h-4 transition-transform ${showSetupGuide ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {m.settings_forza_guide_toggle()}
              </Button>

              {showSetupGuide && (
                <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
                  <h3 className="text-sm font-semibold text-app-text mb-3">{m.settings_forza_guide_title()}</h3>
                  <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
                    <li>{m.setupguide_forza_step1()}</li>
                    <li>{m.setupguide_forza_step2()}</li>
                    <li>{m.setupguide_forza_step3()}</li>
                    <li>{m.setupguide_data_out_on()}</li>
                    <li>
                      {m.setupguide_data_out_ip()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">192.168.1.x</code>
                      ).
                      <p className="mt-1 text-xs text-app-text-muted/70">
                        {m.settingsguide_same_pc_running()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
                      </p>
                    </li>
                    <li>
                      {m.setupguide_data_out_port()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{udpPort || "5301"}</code>{" "}
                      {m.settingsguide_match_port_above()}
                    </li>
                    <li>{m.setupguide_data_out_packet_format()}</li>
                  </ol>

                  <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
                    <p className="text-xs text-status-warning">
                      <span className="font-semibold">{m.setupguide_note_label()}</span> {m.settingsguide_forza_note()}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3">
              <Button variant="app-ghost" size="app-sm" onClick={() => setShowF1SetupGuide(!showF1SetupGuide)} className="!p-0 text-sm text-app-accent hover:text-app-accent/80">
                <svg aria-hidden="true" className={`w-4 h-4 transition-transform ${showF1SetupGuide ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {m.settings_f1_guide_toggle()}
              </Button>

              {showF1SetupGuide && (
                <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
                  <h3 className="text-sm font-semibold text-app-text mb-3">{m.settings_f1_guide_title()}</h3>
                  <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
                    <li>{m.setupguide_f1_step1()}</li>
                    <li>{m.setupguide_f1_step2()}</li>
                    <li>{m.setupguide_udp_telemetry_on()}</li>
                    <li>{m.setupguide_udp_broadcast_off()}</li>
                    <li>
                      {m.setupguide_udp_ip()}
                      <p className="mt-1 text-xs text-app-text-muted/70">
                        {m.settingsguide_same_pc_running()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
                      </p>
                    </li>
                    <li>
                      {m.setupguide_udp_port()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{udpPort || "5300"}</code> {m.settingsguide_match_port_above()}
                    </li>
                    <li>{m.setupguide_udp_send_rate()}</li>
                    <li>{m.setupguide_udp_format()}</li>
                  </ol>

                  <div className="mt-4 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
                    <p className="text-xs text-status-warning">
                      <span className="font-semibold">{m.setupguide_note_label()}</span> {m.settingsguide_f1_note()}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {activeSection === "wheel" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">{m.settings_wheel_title()}</h2>
            <p className="text-sm text-app-text-muted mb-4">
              {m.settings_wheel_desc()} <code className="text-xs bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
            </p>
            <WheelPicker
              value={wheelStyle}
              onChange={(v) => {
                setWheelStyle(v);
                localStorage.setItem(WHEEL_STYLE_KEY, v);
              }}
            />

            <div className="mt-6 pt-6 border-t border-app-border max-w-xs">
              <Label htmlFor="steer-lock" className="text-app-text-secondary">
                {m.settings_steer_rotation_label()}
              </Label>
              <p className="text-xs text-app-text-muted mb-1.5">{m.settings_steer_rotation_desc()}</p>
              <div className="flex items-end gap-3">
                <Input
                  id="steer-lock"
                  type="number"
                  min={180}
                  max={1800}
                  step={10}
                  value={steerLock}
                  onChange={(e) => {
                    setSteerLock(e.target.value);
                    const val = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(val) && val >= 180 && val <= 1800) {
                      localStorage.setItem(STEER_LOCK_KEY, String(val));
                    }
                  }}
                  className="border bg-app-surface-alt border-app-border-input text-app-text font-mono w-24"
                />
                <span className="text-xs text-app-text-muted mb-2">°</span>
              </div>
            </div>
          </section>
        )}

        {activeSection === "speed" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">{m.label_units()}</h2>
            <p className="text-sm text-app-text-muted mb-4">{m.settings_units_desc()}</p>

            <div className="flex items-center gap-2">
              <Label className="text-app-text-secondary mr-2">{m.settings_units_system_label()}</Label>
              <Button size="sm" variant={unitSystem === "imperial" ? "default" : "outline"} onClick={() => setUnitSystem("imperial")}>
                {m.settings_units_imperial()}
              </Button>
              <Button size="sm" variant={unitSystem === "metric" ? "default" : "outline"} onClick={() => setUnitSystem("metric")}>
                {m.settings_units_metric()}
              </Button>
            </div>

            <div className="mt-5 pt-5 border-t border-app-border">
              <h3 className="text-sm font-semibold text-app-text mb-1">{m.label_temperature()}</h3>
              <p className="text-xs text-app-text-muted mb-3">{m.settings_temperature_desc()}</p>

              <div className="flex items-center gap-2">
                <Label className="text-app-text-secondary mr-2">{m.settings_temperature_unit_label()}</Label>
                <Button size="sm" variant={temperatureUnit === "F" ? "default" : "outline"} onClick={() => setTemperatureUnit("F")}>
                  °F
                </Button>
                <Button size="sm" variant={temperatureUnit === "C" ? "default" : "outline"} onClick={() => setTemperatureUnit("C")}>
                  °C
                </Button>
              </div>
            </div>

            <div className="mt-4">
              <Button onClick={handleUnitSave} disabled={unitStatus === "saving"}>
                {unitStatus === "saving" ? m.common_saving() : unitStatus === "saved" ? m.common_saved() : m.common_save()}
              </Button>
            </div>

            {unitStatus === "error" && <p className="text-status-danger text-sm mt-2">{unitError}</p>}
          </section>
        )}

        {activeSection === "sound" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">{m.label_sound()}</h2>
            <p className="text-sm text-app-text-muted mb-4">{m.settings_sound_desc()}</p>

            <div className="flex items-center gap-3 mb-4">
              <Label className="text-app-text-secondary">{m.settings_sound_sector_blip()}</Label>
              <Button
                size="sm"
                variant={soundEnabled ? "selected-toggle" : "outline"}
                onClick={() => {
                  setSoundEnabledState(true);
                  setSoundEnabled(true);
                }}
              >
                {m.common_on()}
              </Button>
              <Button
                size="sm"
                variant={!soundEnabled ? "selected-toggle" : "outline"}
                onClick={() => {
                  setSoundEnabledState(false);
                  setSoundEnabled(false);
                }}
              >
                {m.common_off()}
              </Button>
            </div>

            <div className="mb-4">
              <Label className="text-app-text-secondary mb-2 block">{m.settings_sound_preset()}</Label>
              <div className="flex flex-wrap gap-1.5">
                {SOUND_PRESETS.map((p) => (
                  <Button
                    key={p.id}
                    size="sm"
                    variant={soundType === p.id ? "default" : "outline"}
                    onClick={() => {
                      setSoundTypeState(p.id);
                      setSoundType(p.id);
                      // Preview on select
                      if (p.id !== "url") {
                        preloadSound(`/sounds/${p.id}.mp3`);
                      }
                      playBlip(1);
                    }}
                    className="text-xs"
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>

            {soundType === "url" && (
              <div className="mb-4">
                <Label className="text-app-text-secondary mb-2 block">{m.settings_sound_url_label()}</Label>
                <p className="text-xs text-app-text-muted mb-2">{m.settings_sound_url_desc()}</p>
                <div className="flex gap-2">
                  <Input value={soundUrl} onChange={(e) => setSoundUrlState(e.target.value)} placeholder="https://example.com/beep.mp3" className="flex-1" />
                  <Button
                    size="sm"
                    onClick={() => {
                      setSoundUrl(soundUrl);
                      if (soundUrl) preloadSound(soundUrl);
                    }}
                  >
                    {m.common_save()}
                  </Button>
                </div>
              </div>
            )}

            <div className="mb-4">
              <Label className="text-app-text-secondary mb-2 block">
                {m.label_volume()} — {Math.round(soundVolume * 100)}%
              </Label>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(soundVolume * 100)}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10) / 100;
                  setSoundVolumeState(v);
                  setSoundVolume(v);
                }}
                className="w-64 accent-app-accent"
              />
            </div>

            <div>
              <Label className="text-app-text-secondary mb-2 block">{m.label_preview()}</Label>
              <Button size="sm" variant="outline" onClick={() => playBlip(1.25)}>
                {m.settings_sound_play()}
              </Button>
            </div>
          </section>
        )}
        {activeSection === "storage" && <StorageSection />}
        {activeSection === "ai" && <AiSection />}
        {activeSection === "developer" && (
          <div className="space-y-8">
            <ExtractionSection />
            <F1ExtractionSection />
          </div>
        )}
        {activeSection === "diagnostics" && <DiagnosticsSection />}
        {activeSection === "updates" && <UpdatesSection />}
        {activeSection === "about" && <AboutSection />}
      </div>
    </div>
  );
}
