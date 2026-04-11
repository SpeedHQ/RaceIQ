import { useEffect, useState } from "react";
import { isDevelopment } from "@/lib/env";
import { useUiStore } from "../stores/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { playBlip, preloadSound } from "./SectorTimes";
import { useSettings, useSaveSettings } from "../hooks/queries";
import { useTheme, type Theme } from "../context/theme";

import { WheelPicker } from "./settings/WheelPicker";
import { AiSection } from "./settings/AiSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { ExtractionSection } from "./settings/ExtractionSection";
import { F1ExtractionSection } from "./settings/F1ExtractionSection";
import { AboutSection } from "./settings/AboutSection";
import { DiagnosticsSection } from "./settings/DiagnosticsSection";

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
  STEER_LOCK_KEY,
  WHEEL_STYLE_KEY,
} from "../lib/settings-storage";

const NAV_ITEMS = [
  { id: "theme", label: "Theme" },
  { id: "connection", label: "Connection" },
  { id: "wheel", label: "Wheel" },
  { id: "temperature", label: "Temperature" },
  { id: "tireHealth", label: "Tire Health" },
  { id: "suspension", label: "Suspension" },
  { id: "speed", label: "Units" },
  { id: "sound", label: "Sound" },
  { id: "ai", label: "AI Analysis" },
  { id: "developer", label: "Developer", devOnly: true },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]["id"];

export function Settings({ initialSection, onClose }: { initialSection?: SectionId; onClose?: () => void } = {}) {
  const { openOnboarding } = useUiStore();
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? "theme");
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
  const tempUnit = unitSystem === "metric" ? "C" as const : "F" as const;
  const [healthThresholds, setHealthThresholds] = useState(displaySettings.tireHealthThresholds.values);
  const [suspThresholds, setSuspThresholds] = useState(displaySettings.suspensionThresholds.values);
  const [healthStatus, setHealthStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [healthError, setHealthError] = useState("");
  const [suspStatus, setSuspStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [suspError, setSuspError] = useState("");
  const [unitStatus, setUnitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [unitError, setUnitError] = useState("");

  const tempSettingsJson = JSON.stringify(displaySettings);
  useEffect(() => {
    setUnitSystem(displaySettings.unit);
    setHealthThresholds(displaySettings.tireHealthThresholds.values);
    setSuspThresholds(displaySettings.suspensionThresholds.values);
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

  const port = parseInt(udpPort, 10);
  const hasChanges = savedPort === null || port !== savedPort;

  async function handleSave() {
    const savePort = parseInt(udpPort, 10);
    if (isNaN(savePort) || savePort < 1024 || savePort > 65535) {
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
      await saveSettings.mutateAsync({ unit: unitSystem });
      setUnitStatus("saved");
      setTimeout(() => setUnitStatus("idle"), 2000);
    } catch (err) {
      setUnitStatus("error");
      setUnitError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function handleHealthSave() {
    const sorted = [...healthThresholds].sort((a, b) => a - b);
    if (sorted.some((v) => v < 0 || v > 100)) {
      setHealthStatus("error");
      setHealthError("Values must be between 0-100");
      return;
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] <= sorted[i - 1]) {
        setHealthStatus("error");
        setHealthError("Thresholds must be in ascending order");
        return;
      }
    }
    setHealthStatus("saving");
    setHealthError("");
    try {
      await saveSettings.mutateAsync({ tireHealthThresholds: { values: sorted } });
      setHealthThresholds(sorted);
      setHealthStatus("saved");
      setTimeout(() => setHealthStatus("idle"), 2000);
    } catch (err) {
      setHealthStatus("error");
      setHealthError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function handleSuspSave() {
    const sorted = [...suspThresholds].sort((a, b) => a - b);
    if (sorted.some((v) => v < 0 || v > 100)) {
      setSuspStatus("error");
      setSuspError("Values must be between 0-100");
      return;
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] <= sorted[i - 1]) {
        setSuspStatus("error");
        setSuspError("Thresholds must be in ascending order");
        return;
      }
    }
    setSuspStatus("saving");
    setSuspError("");
    try {
      await saveSettings.mutateAsync({ suspensionThresholds: { values: sorted } });
      setSuspThresholds(sorted);
      setSuspStatus("saved");
      setTimeout(() => setSuspStatus("idle"), 2000);
    } catch (err) {
      setSuspStatus("error");
      setSuspError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  const themes: { value: Theme; label: string; description: string }[] = [
    { value: "morph", label: "Morph", description: "Morphic black" },
  ];

  return (
    <div className="flex h-full">
      {/* Left nav */}
      <nav className="w-48 shrink-0 border-r border-app-border bg-app-surface-alt/50 py-2 flex flex-col">
        {NAV_ITEMS.filter((item) => !("devOnly" in item) || isDevelopment).map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveSection(item.id)}
            className={`w-full text-left px-4 py-2 text-sm transition-colors ${
              activeSection === item.id
                ? "text-app-accent bg-app-accent/10 border-r-2 border-app-accent"
                : "text-app-text-muted hover:text-app-text hover:bg-app-surface-alt"
            }`}
          >
            {item.label}
          </button>
        ))}
        <div className="mt-auto pt-2 border-t border-app-border mx-2">
          <button
            className="w-full text-left px-4 py-2 text-sm text-app-text-muted hover:text-app-text hover:bg-app-surface-alt transition-colors"
            onClick={() => { onClose?.(); openOnboarding(); }}
          >
            Setup Wizard
          </button>
        </div>
      </nav>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeSection === "theme" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Theme</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Choose the visual style for the interface.
            </p>
            <div className="grid grid-cols-2 gap-3 max-w-sm">
              {themes.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTheme(t.value)}
                  className={`relative rounded-lg border p-3 text-left transition-all ${
                    theme === t.value
                      ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30"
                      : "border-app-border bg-app-surface-alt hover:border-app-border-input"
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
            <p className="text-sm text-app-text-muted mb-4">
              Set the UDP port to listen on. In Forza: Settings &gt; Gameplay &gt;
              Data Out &gt; set IP to this machine's address and the port below.
            </p>

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
              <Button
                onClick={handleSave}
                disabled={status === "saving" || !hasChanges}
                variant={status === "saved" ? "secondary" : "default"}
                className="shrink-0"
              >
                {status === "saving"
                  ? "Saving..."
                  : status === "saved"
                    ? "Saved"
                    : "Save"}
              </Button>
            </div>
            {status === "error" && (
              <p className="text-red-400 text-sm mt-2">{errorMsg}</p>
            )}
            {savedPort && (
              <p className="text-app-text-muted text-xs mt-3">
                Listening on 0.0.0.0:{savedPort}
              </p>
            )}

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
              <p className="text-app-text-muted text-xs mt-1">
                WebSocket refresh rate for live telemetry. Lower values reduce CPU usage.
              </p>
            </div>

            <div className="mt-6 pt-6 border-t border-app-border">
              <button
                onClick={() => setShowSetupGuide(!showSetupGuide)}
                className="flex items-center gap-2 text-sm text-app-accent hover:text-app-accent/80 transition-colors"
              >
                <svg
                  className={`w-4 h-4 transition-transform ${showSetupGuide ? "rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                How to enable Data Out in Forza Motorsport
              </button>

              {showSetupGuide && (
                <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
                  <h3 className="text-sm font-semibold text-app-text mb-3">
                    Forza Motorsport (2023) — Data Out Setup
                  </h3>
                  <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
                    <li>
                      Open <span className="text-app-text">Forza Motorsport</span> and go to{" "}
                      <span className="text-app-text">Settings</span>.
                    </li>
                    <li>
                      Navigate to{" "}
                      <span className="text-app-text">Gameplay &amp; HUD</span>.
                    </li>
                    <li>
                      Scroll down to the{" "}
                      <span className="text-app-text">UDP Race Telemetry</span> section.
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out</span> to{" "}
                      <span className="text-app-accent font-medium">On</span>.
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out IP Address</span> to your
                      PC's local IP address (e.g.{" "}
                      <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">
                        192.168.1.x
                      </code>
                      ).
                      <p className="mt-1 text-xs text-app-text-muted/70">
                        If the game is running on the same PC, use{" "}
                        <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">
                          127.0.0.1
                        </code>
                      </p>
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out IP Port</span> to{" "}
                      <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">
                        {udpPort || "5301"}
                      </code>{" "}
                      (must match the UDP port above).
                    </li>
                    <li>
                      Set <span className="text-app-text">Data Out Packet Format</span> to{" "}
                      <span className="text-app-accent font-medium">Car Dash</span>.
                    </li>
                  </ol>

                  <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <p className="text-xs text-amber-400">
                      <span className="font-semibold">Note:</span> Telemetry only sends data
                      while you're in a race session (Practice, Qualifying, or Race). You
                      won't receive data from menus, replays, or while spectating.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3">
              <button
                onClick={() => setShowF1SetupGuide(!showF1SetupGuide)}
                className="flex items-center gap-2 text-sm text-app-accent hover:text-app-accent/80 transition-colors"
              >
                <svg
                  className={`w-4 h-4 transition-transform ${showF1SetupGuide ? "rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                How to enable UDP Telemetry in F1 2025
              </button>

              {showF1SetupGuide && (
                <div className="mt-4 rounded-lg border border-app-border bg-app-surface-alt p-4 max-w-lg">
                  <h3 className="text-sm font-semibold text-app-text mb-3">
                    EA Sports F1 2025 — UDP Telemetry Setup
                  </h3>
                  <ol className="space-y-2.5 text-sm text-app-text-muted list-decimal list-inside">
                    <li>
                      Open <span className="text-app-text">F1 2025</span> and go to{" "}
                      <span className="text-app-text">Settings</span> (main menu).
                    </li>
                    <li>
                      Navigate to{" "}
                      <span className="text-app-text">Telemetry Settings</span>.
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Telemetry</span> to{" "}
                      <span className="text-app-accent font-medium">On</span>.
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Broadcast Mode</span> to{" "}
                      <span className="text-app-accent font-medium">Off</span> (unicast).
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP IP Address</span> to your
                      PC's local IP address (e.g.{" "}
                      <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">
                        192.168.1.x
                      </code>
                      ).
                      <p className="mt-1 text-xs text-app-text-muted/70">
                        If the game is running on the same PC, use{" "}
                        <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">
                          127.0.0.1
                        </code>
                      </p>
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Port</span> to{" "}
                      <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 text-xs font-mono">
                        {udpPort || "5300"}
                      </code>{" "}
                      (must match the UDP port above).
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Send Rate</span> to{" "}
                      <span className="text-app-accent font-medium">60 Hz</span> for best data quality.
                    </li>
                    <li>
                      Set <span className="text-app-text">UDP Format</span> to{" "}
                      <span className="text-app-accent font-medium">2025</span>.
                    </li>
                  </ol>

                  <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <p className="text-xs text-amber-400">
                      <span className="font-semibold">Note:</span> F1 telemetry is auto-detected — you can use the
                      same UDP port for both Forza and F1. Telemetry only sends data during active sessions
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
              Choose the steering wheel style displayed during live telemetry.
              Add your own by placing images in <code className="text-xs bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
            </p>
            <WheelPicker value={wheelStyle} onChange={(v) => { setWheelStyle(v); localStorage.setItem(WHEEL_STYLE_KEY, v); }} />

            <div className="mt-6 pt-6 border-t border-app-border max-w-xs">
              <Label htmlFor="steer-lock" className="text-app-text-secondary">
                Steering Wheel Rotation (degrees)
              </Label>
              <p className="text-xs text-app-text-muted mb-1.5">
                Full lock-to-lock rotation of your wheel. Common: 900° (default), 540°, 360°, 270°
              </p>
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
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val >= 180 && val <= 1800) {
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

        {activeSection === "temperature" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Temperature</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Set the display unit. Tire temperature color thresholds are set per game automatically.
            </p>

            <div className="flex items-center gap-2 mb-4">
              <Label className="text-app-text-secondary mr-2">Unit</Label>
              <Button
                size="sm"
                variant={tempUnit === "F" ? "default" : "outline"}
                onClick={() => setUnitSystem("imperial")}
                className="w-12"
              >
                °F
              </Button>
              <Button
                size="sm"
                variant={tempUnit === "C" ? "default" : "outline"}
                onClick={() => setUnitSystem("metric")}
                className="w-12"
              >
                °C
              </Button>
            </div>
          </section>
        )}

        {activeSection === "tireHealth" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Tire Health</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Color thresholds for tire health percentage. Values are health % boundaries (ascending).
            </p>

            <div className="space-y-3 max-w-xs">
              {[
                { label: "Critical (below = red)", color: "text-red-400", idx: 0 },
                { label: "Low (below = orange)", color: "text-orange-400", idx: 1 },
                { label: "Medium (below = yellow)", color: "text-yellow-400", idx: 2 },
                { label: "Good (above = green)", color: "text-emerald-400", idx: 3 },
              ].map(({ label, color, idx }) => (
                <div key={idx}>
                  <Label className={`${color} text-xs`}>{label}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={healthThresholds[idx] ?? ""}
                    onChange={(e) => {
                      const next = [...healthThresholds];
                      next[idx] = parseFloat(e.target.value) || 0;
                      setHealthThresholds(next);
                    }}
                    className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-24"
                  />
                </div>
              ))}
            </div>

            <div className="flex gap-2 mt-4">
              <Button onClick={handleHealthSave} disabled={healthStatus === "saving"}>
                {healthStatus === "saving" ? "Saving..." : healthStatus === "saved" ? "Saved" : "Save"}
              </Button>
              <Button variant="outline" onClick={() => setHealthThresholds([20, 40, 60, 80])}>
                Reset
              </Button>
            </div>

            {healthStatus === "error" && (
              <p className="text-red-400 text-sm mt-2">{healthError}</p>
            )}
          </section>
        )}

        {activeSection === "suspension" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Suspension</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Color thresholds for suspension travel (0-100%). Values are travel % boundaries (ascending).
            </p>

            <div className="space-y-3 max-w-xs">
              {[
                { label: "Extended (below = blue)", color: "text-blue-400", idx: 0 },
                { label: "Compressed (above = yellow)", color: "text-yellow-400", idx: 1 },
                { label: "Bottomed (above = red)", color: "text-red-400", idx: 2 },
              ].map(({ label, color, idx }) => (
                <div key={idx}>
                  <Label className={`${color} text-xs`}>{label}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={suspThresholds[idx] ?? ""}
                    onChange={(e) => {
                      const next = [...suspThresholds];
                      next[idx] = parseFloat(e.target.value) || 0;
                      setSuspThresholds(next);
                    }}
                    className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-24"
                  />
                </div>
              ))}
            </div>

            <div className="flex gap-2 mt-4">
              <Button onClick={handleSuspSave} disabled={suspStatus === "saving"}>
                {suspStatus === "saving" ? "Saving..." : suspStatus === "saved" ? "Saved" : "Save"}
              </Button>
              <Button variant="outline" onClick={() => setSuspThresholds([25, 65, 85])}>
                Reset
              </Button>
            </div>

            {suspStatus === "error" && (
              <p className="text-red-400 text-sm mt-2">{suspError}</p>
            )}
          </section>
        )}

        {activeSection === "speed" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Units</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Choose between Imperial and Metric units for speed, distance, and weight.
            </p>

            <div className="flex items-center gap-2">
              <Label className="text-app-text-secondary mr-2">Unit</Label>
              <Button
                size="sm"
                variant={unitSystem === "imperial" ? "default" : "outline"}
                onClick={() => setUnitSystem("imperial")}
              >
                Imperial (mph, ft, lb)
              </Button>
              <Button
                size="sm"
                variant={unitSystem === "metric" ? "default" : "outline"}
                onClick={() => setUnitSystem("metric")}
              >
                Metric (km/h, m, kg)
              </Button>
            </div>

            <div className="mt-4">
              <Button onClick={handleUnitSave} disabled={unitStatus === "saving"}>
                {unitStatus === "saving" ? "Saving..." : unitStatus === "saved" ? "Saved" : "Save"}
              </Button>
            </div>

            {unitStatus === "error" && (
              <p className="text-red-400 text-sm mt-2">{unitError}</p>
            )}
          </section>
        )}

        {activeSection === "sound" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Sound</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Audio feedback for sector changes and other events.
            </p>

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
                <p className="text-xs text-app-text-muted mb-2">
                  Paste a direct link to an .mp3 or .wav file. Short clips (&lt;1s) work best.
                </p>
                <div className="flex gap-2">
                  <Input
                    value={soundUrl}
                    onChange={(e) => setSoundUrlState(e.target.value)}
                    placeholder="https://example.com/beep.mp3"
                    className="flex-1"
                  />
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
                  const v = parseInt(e.target.value, 10) / 100;
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
        {activeSection === "ai" && (
          <AiSection />
        )}
        {activeSection === "developer" && (
          <div className="space-y-8">
            <ExtractionSection />
            <F1ExtractionSection />
          </div>
        )}
        {activeSection === "diagnostics" && (
          <DiagnosticsSection />
        )}
        {activeSection === "updates" && (
          <UpdatesSection />
        )}
        {activeSection === "about" && (
          <AboutSection />
        )}
      </div>
    </div>
  );
}
