import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isDevelopment } from "@/lib/env";
import { useEffect, useState } from "react";
import { type Theme, useTheme } from "../context/theme";
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
  getSteeringLock,
  getWheelStyle,
  getSoundEnabled,
  setSoundEnabled,
  getSoundVolume,
  setSoundVolume,
  getSoundType,
  setSoundType,
  getSoundUrl,
  setSoundUrl,
  SOUND_PRESETS,
  type SoundType,
} from "../lib/settings-storage";

import {
  SOUND_PRESETS,
  STEER_LOCK_KEY,
  WHEEL_STYLE_KEY,
  getSoundEnabled,
  getSoundType,
  getSoundUrl,
  getSoundVolume,
  getSteeringLock,
  getWheelStyle,
  setSoundEnabled,
  setSoundType,
  setSoundUrl,
  setSoundVolume,
} from "../lib/settings-storage";

const NAV_ITEMS = [
  { id: "general", label: "General" },
  { id: "theme", label: "Theme" },
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
  const { theme, setTheme } = useTheme();
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
      setErrorMsg("Port must be between 1024-65535");
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
      setErrorMsg(err instanceof Error ? err.message : "Failed to save");
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
      setUnitError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const themes: { value: Theme; label: string; description: string }[] = [{ value: "morph", label: "Morph", description: "Morphic black" }];

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Nav — horizontal tabs on mobile, sidebar on md+ */}
      <nav className="md:w-48 shrink-0 md:border-r border-b md:border-b-0 border-app-border bg-app-surface-alt/50 py-2 flex md:flex-col overflow-x-auto md:overflow-x-visible">
        {NAV_ITEMS.filter((item) => !("devOnly" in item) || isDevelopment).map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => setActiveSection(item.id)}
            className={`shrink-0 md:w-full text-left px-4 py-2 text-sm whitespace-nowrap transition-colors ${
              activeSection === item.id
                ? "text-app-accent bg-app-accent/10 border-b-2 md:border-b-0 md:border-r-2 border-app-accent"
                : "text-app-text-muted hover:text-app-text hover:bg-app-surface-alt"
            }`}
          >
            {item.label}
          </button>
        ))}
        <div className="hidden md:block mt-auto pt-2 border-t border-app-border mx-2">
          <button
            type="button"
            className="w-full text-left px-4 py-2 text-sm text-app-text-muted hover:text-app-text hover:bg-app-surface-alt transition-colors"
            onClick={() => {
              onClose?.();
              openOnboarding();
            }}
          >
            Setup Wizard
          </button>
        </div>
        <button
          type="button"
          className="md:hidden shrink-0 px-4 py-2 text-sm whitespace-nowrap text-app-text-muted hover:text-app-text transition-colors border-l border-app-border ml-auto"
          onClick={() => {
            onClose?.();
            openOnboarding();
          }}
        >
          Setup Wizard
        </button>
      </nav>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {activeSection === "general" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">General</h2>
            <p className="text-sm text-app-text-muted mb-4">App-wide settings.</p>

            <div className="max-w-xs">
              <Label className={`${displaySettings.isCompiled ? "text-app-text-secondary" : "text-app-text-muted"}`}>Launch on Login</Label>
              <div className="flex items-center gap-3 mt-1.5">
                <button
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
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${
                      displaySettings.launchOnLogin ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span className="text-sm text-app-text-muted">{!displaySettings.isCompiled ? "Only available in installed app" : displaySettings.launchOnLogin ? "Enabled" : "Disabled"}</span>
              </div>
              <p className="text-app-text-muted text-xs mt-1">Automatically start RaceIQ when you log into Windows.</p>
            </div>
          </section>
        )}

        {activeSection === "games" && <GamesSection />}

        {activeSection === "theme" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Theme</h2>
            <p className="text-sm text-app-text-muted mb-4">Choose the visual style for the interface.</p>
            <div className="grid grid-cols-2 gap-3 max-w-sm">
              {themes.map((t) => (
                <button
                  type="button"
                  key={t.value}
                  onClick={() => setTheme(t.value)}
                  className={`relative rounded-lg border p-3 text-left transition-all ${
                    theme === t.value ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
                  }`}
                >
                  <div className="text-sm font-medium text-app-text">{t.label}</div>
                  <div className="text-xs text-app-text-muted mt-0.5">{t.description}</div>
                  <div className="mt-2 h-8 rounded-md border border-[#2a2a2a] bg-gradient-to-br from-[#1e1e1e] to-[#141414]" />
                </button>
              ))}
            </div>
          </section>
        )}

        {activeSection === "connection" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Forza Connection</h2>
            <p className="text-sm text-app-text-muted mb-4">Set the UDP port to listen on. In Forza: Settings &gt; Gameplay &gt; Data Out &gt; set IP to this machine's address and the port below.</p>

            <div className="flex items-end gap-3 max-w-xs">
              <div className="flex-1">
                <Label htmlFor="udp-port" className="text-app-text-secondary">
                  UDP Port
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
                  className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1.5"
                  placeholder="5301"
                />
              </div>
              <Button onClick={handleSave} disabled={status === "saving" || !hasChanges} variant={status === "saved" ? "secondary" : "default"} className="shrink-0">
                {status === "saving" ? "Saving..." : status === "saved" ? "Saved" : "Save"}
              </Button>
            </div>
            {status === "error" && <p className="text-red-400 text-sm mt-2">{errorMsg}</p>}
            {savedPort && <p className="text-app-text-muted text-xs mt-3">Listening on 0.0.0.0:{savedPort}</p>}

            <div className="mt-4 max-w-xs">
              <Label className="text-app-text-secondary">Live Refresh Rate</Label>
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
              <p className="text-app-text-muted text-xs mt-1">WebSocket refresh rate for live telemetry. Lower values reduce CPU usage.</p>
            </div>

            <div className="mt-4 max-w-xs">
              <Label className="text-app-text-secondary">3D Render Frame Cap</Label>
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
              <p className="text-app-text-muted text-xs mt-1">
                Maximum frame rate for the 3D wireframe scene in analyse. Lower values reduce GPU/CPU load; higher is smoother. Does not affect playback speed.
              </p>
            </div>

            <div className="mt-6 pt-6 border-t border-app-border">
              <button type="button" onClick={() => setShowSetupGuide(!showSetupGuide)} className="flex items-center gap-2 text-sm text-app-accent hover:text-app-accent/80 transition-colors">
                <svg aria-hidden="true" className={`w-4 h-4 transition-transform ${showSetupGuide ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                How to enable Data Out in Forza Motorsport
              </button>

              {showSetupGuide && (
                <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
                  <h3 className="text-sm font-semibold text-app-text mb-3">Forza Motorsport (2023) — Data Out Setup</h3>
                  <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
                    <li>
                      Open <span className="text-app-text">Forza Motorsport</span> and go to <span className="text-app-text">Settings</span>.
                    </li>
                    <li>
                      Navigate to <span className="text-app-text">Gameplay &amp; HUD</span>.
                    </li>
                    <li>
                      Scroll down to the <span className="text-app-text">UDP Race Telemetry</span> section.
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out</span> to <span className="text-app-accent font-medium">On</span>.
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out IP Address</span> to your PC's local IP address (e.g.{" "}
                      <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">192.168.1.x</code>
                      ).
                      <p className="mt-1 text-xs text-app-text-muted/70">
                        If the game is running on the same PC, use <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
                      </p>
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out IP Port</span> to <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{udpPort || "5301"}</code>{" "}
                      (must match the UDP port above).
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out Packet Format</span> to <span className="text-app-accent font-medium">Car Dash</span>.
                    </li>
                  </ol>

                  <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <p className="text-xs text-amber-400">
                      <span className="font-semibold">Note:</span> Telemetry only sends data while you're in a race session (Practice, Qualifying, or Race). You won't receive data from menus, replays,
                      or while spectating.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3">
              <button type="button" onClick={() => setShowF1SetupGuide(!showF1SetupGuide)} className="flex items-center gap-2 text-sm text-app-accent hover:text-app-accent/80 transition-colors">
                <svg aria-hidden="true" className={`w-4 h-4 transition-transform ${showF1SetupGuide ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                How to enable UDP Telemetry in F1 2025
              </button>

              {showF1SetupGuide && (
                <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
                  <h3 className="text-sm font-semibold text-app-text mb-3">EA Sports F1 2025 — UDP Telemetry Setup</h3>
                  <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
                    <li>
                      Open <span className="text-app-text">F1 2025</span> and go to <span className="text-app-text">Settings</span> (main menu).
                    </li>
                    <li>
                      Navigate to <span className="text-app-text">Telemetry Settings</span>.
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Telemetry</span> to <span className="text-app-accent font-medium">On</span>.
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Broadcast Mode</span> to <span className="text-app-accent font-medium">Off</span> (unicast).
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP IP Address</span> to your PC's local IP address (e.g.{" "}
                      <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">192.168.1.x</code>
                      ).
                      <p className="mt-1 text-xs text-app-text-muted/70">
                        If the game is running on the same PC, use <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code>
                      </p>
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Port</span> to <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">{udpPort || "5300"}</code> (must
                      match the UDP port above).
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Send Rate</span> to <span className="text-app-accent font-medium">60 Hz</span> for best data quality.
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Format</span> to <span className="text-app-accent font-medium">2025</span>.
                    </li>
                  </ol>

                  <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <p className="text-xs text-amber-400">
                      <span className="font-semibold">Note:</span> F1 telemetry is auto-detected — you can use the same UDP port for both Forza and F1. Telemetry only sends data during active sessions
                      (Practice, Qualifying, Sprint, Race).
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {activeSection === "wheel" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Steering Wheel</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Choose the steering wheel style displayed during live telemetry. Add your own by placing images in{" "}
              <code className="text-xs bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
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
                Steering Wheel Rotation (degrees)
              </Label>
              <p className="text-xs text-app-text-muted mb-1.5">Full lock-to-lock rotation of your wheel. Common: 900° (default), 540°, 360°, 270°</p>
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
                  className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono w-24"
                />
                <span className="text-xs text-app-text-muted mb-2">°</span>
              </div>
            </div>
          </section>
        )}

        {activeSection === "speed" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Units</h2>
            <p className="text-sm text-app-text-muted mb-4">Choose between Imperial and Metric units for speed, distance, and weight.</p>

            <div className="flex items-center gap-2">
              <Label className="text-app-text-secondary mr-2">System</Label>
              <Button size="sm" variant={unitSystem === "imperial" ? "default" : "outline"} onClick={() => setUnitSystem("imperial")}>
                Imperial (mph, ft, lb)
              </Button>
              <Button size="sm" variant={unitSystem === "metric" ? "default" : "outline"} onClick={() => setUnitSystem("metric")}>
                Metric (km/h, m, kg)
              </Button>
            </div>

            <div className="mt-5 pt-5 border-t border-app-border">
              <h3 className="text-sm font-semibold text-app-text mb-1">Temperature</h3>
              <p className="text-xs text-app-text-muted mb-3">Moved here from separate Settings section. Tire temperature color thresholds stay game-controlled.</p>

              <div className="flex items-center gap-2">
                <Label className="text-app-text-secondary mr-2">Unit</Label>
                <Button size="sm" variant={temperatureUnit === "F" ? "default" : "outline"} onClick={() => setTemperatureUnit("F")} className="w-12">
                  °F
                </Button>
                <Button size="sm" variant={temperatureUnit === "C" ? "default" : "outline"} onClick={() => setTemperatureUnit("C")} className="w-12">
                  °C
                </Button>
              </div>
            </div>

            <div className="mt-4">
              <Button onClick={handleUnitSave} disabled={unitStatus === "saving"}>
                {unitStatus === "saving" ? "Saving..." : unitStatus === "saved" ? "Saved" : "Save"}
              </Button>
            </div>

            {unitStatus === "error" && <p className="text-red-400 text-sm mt-2">{unitError}</p>}
          </section>
        )}

        {activeSection === "sound" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Sound</h2>
            <p className="text-sm text-app-text-muted mb-4">Audio feedback for sector changes and other events.</p>

            <div className="flex items-center gap-3 mb-4">
              <Label className="text-app-text-secondary">Sector blip sounds</Label>
              <Button
                size="sm"
                variant={soundEnabled ? "default" : "outline"}
                onClick={() => {
                  setSoundEnabledState(true);
                  setSoundEnabled(true);
                }}
              >
                On
              </Button>
              <Button
                size="sm"
                variant={!soundEnabled ? "default" : "outline"}
                onClick={() => {
                  setSoundEnabledState(false);
                  setSoundEnabled(false);
                }}
              >
                Off
              </Button>
            </div>

            <div className="mb-4">
              <Label className="text-app-text-secondary mb-2 block">Sound preset</Label>
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
                <Label className="text-app-text-secondary mb-2 block">Sound URL</Label>
                <p className="text-xs text-app-text-muted mb-2">Paste a direct link to an .mp3 or .wav file. Short clips (&lt;1s) work best.</p>
                <div className="flex gap-2">
                  <Input value={soundUrl} onChange={(e) => setSoundUrlState(e.target.value)} placeholder="https://example.com/beep.mp3" className="flex-1" />
                  <Button
                    size="sm"
                    onClick={() => {
                      setSoundUrl(soundUrl);
                      if (soundUrl) preloadSound(soundUrl);
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            )}

            <div className="mb-4">
              <Label className="text-app-text-secondary mb-2 block">Volume — {Math.round(soundVolume * 100)}%</Label>
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
                className="w-64 accent-cyan-500"
              />
            </div>

            <div>
              <Label className="text-app-text-secondary mb-2 block">Preview</Label>
              <Button size="sm" variant="outline" onClick={() => playBlip(1.25)}>
                Play
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
