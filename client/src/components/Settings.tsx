import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { convertTemp, celsiusToFahrenheit } from "../lib/temperature";
import { playBlip, preloadSound } from "./SectorTimes";
import { useSettings, useSaveSettings } from "../hooks/queries";
import { useTheme, type Theme } from "../context/theme";

// Client-side preferences stored in localStorage
const STEER_LOCK_KEY = "forza-steer-lock";
const WHEEL_STYLE_KEY = "forza-wheel-style";
const SOUND_ENABLED_KEY = "forza-sound-enabled";
const SOUND_VOLUME_KEY = "forza-sound-volume";
const SOUND_TYPE_KEY = "forza-sound-type";
const SOUND_URL_KEY = "forza-sound-url";

export function getSteeringLock(): number {
  const val = localStorage.getItem(STEER_LOCK_KEY);
  return val ? parseInt(val, 10) : 900;
}

export type WheelStyle = "svg" | "fanatec";

export function getWheelStyle(): WheelStyle {
  const val = localStorage.getItem(WHEEL_STYLE_KEY);
  return (val as WheelStyle) ?? "svg";
}

export function getSoundEnabled(): boolean {
  const val = localStorage.getItem(SOUND_ENABLED_KEY);
  return val === null ? true : val === "true"; // default on
}

export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(SOUND_ENABLED_KEY, String(enabled));
}

export function getSoundVolume(): number {
  const val = localStorage.getItem(SOUND_VOLUME_KEY);
  return val ? parseFloat(val) : 0.15; // default 15%
}

export function setSoundVolume(volume: number): void {
  localStorage.setItem(SOUND_VOLUME_KEY, String(Math.max(0, Math.min(1, volume))));
}

export const SOUND_PRESETS = [
  { id: "beep-2", label: "Beep Short" },
  { id: "url", label: "Custom URL" },
] as const;

export type SoundType = string; // preset id or "url"

export function getSoundType(): string {
  const val = localStorage.getItem(SOUND_TYPE_KEY);
  return val ?? "beep-2";
}

export function setSoundType(type: SoundType): void {
  localStorage.setItem(SOUND_TYPE_KEY, type);
}

export function getSoundUrl(): string {
  return localStorage.getItem(SOUND_URL_KEY) ?? "";
}

export function setSoundUrl(url: string): void {
  localStorage.setItem(SOUND_URL_KEY, url);
}

const NAV_ITEMS = [
  { id: "theme", label: "Theme" },
  { id: "connection", label: "Connection" },
  { id: "wheel", label: "Wheel" },
  { id: "temperature", label: "Temperature" },
  { id: "tireHealth", label: "Tire Health" },
  { id: "suspension", label: "Suspension" },
  { id: "speed", label: "Units" },
  { id: "sound", label: "Sound" },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]["id"];

export function Settings() {
  const [activeSection, setActiveSection] = useState<SectionId>("theme");
  const [udpPort, setUdpPort] = useState("5300");
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [steerLock, setSteerLock] = useState(() => String(getSteeringLock()));
  const [wheelStyle, setWheelStyle] = useState<WheelStyle>(() => getWheelStyle());
  const [soundEnabled, setSoundEnabledState] = useState(() => getSoundEnabled());
  const [soundVolume, setSoundVolumeState] = useState(() => getSoundVolume());
  const [soundType, setSoundTypeState] = useState(() => getSoundType());
  const [soundUrl, setSoundUrlState] = useState(() => getSoundUrl());

  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const { theme, setTheme } = useTheme();
  const [tempUnit, setTempUnit] = useState<"F" | "C">(displaySettings.temperatureUnit);
  const [thresholds, setThresholds] = useState(displaySettings.tireTemperatureThresholds);
  const [healthThresholds, setHealthThresholds] = useState(displaySettings.tireHealthThresholds.values);
  const [suspThresholds, setSuspThresholds] = useState(displaySettings.suspensionThresholds.values);
  const [speedUnit, setSpeedUnit] = useState<"mph" | "kmh">(displaySettings.speedUnit);
  const [tempStatus, setTempStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tempError, setTempError] = useState("");
  const [healthStatus, setHealthStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [healthError, setHealthError] = useState("");
  const [suspStatus, setSuspStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [suspError, setSuspError] = useState("");
  const [speedStatus, setSpeedStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [speedError, setSpeedError] = useState("");

  const tempSettingsJson = JSON.stringify(displaySettings);
  useEffect(() => {
    const unit = displaySettings.temperatureUnit;
    const raw = displaySettings.tireTemperatureThresholds;
    setTempUnit(unit);
    setSpeedUnit(displaySettings.speedUnit);
    // Server always stores in °F — convert to display unit
    setThresholds(unit === "C" ? {
      cold: convertTemp(raw.cold, "C"),
      warm: convertTemp(raw.warm, "C"),
      hot: convertTemp(raw.hot, "C"),
    } : raw);
    setHealthThresholds(displaySettings.tireHealthThresholds.values);
    setSuspThresholds(displaySettings.suspensionThresholds.values);
  }, [tempSettingsJson]);

  // Seed UDP port from settings query
  const settingsQuery = useSettings();
  useEffect(() => {
    const data = settingsQuery.displaySettings as any;
    if (data?.udpPort != null && savedPort === null) {
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
      await saveSettings.mutateAsync({ udpPort: savePort } as any);
      setSavedPort(savePort);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function handleTempSave() {
    // Convert display values back to °F if user is in °C mode
    const thresholdsInF = tempUnit === "C"
      ? {
          cold: celsiusToFahrenheit(thresholds.cold),
          warm: celsiusToFahrenheit(thresholds.warm),
          hot: celsiusToFahrenheit(thresholds.hot),
        }
      : thresholds;

    if (thresholdsInF.cold >= thresholdsInF.warm || thresholdsInF.warm >= thresholdsInF.hot) {
      setTempStatus("error");
      setTempError("Thresholds must be in order: cold < warm < hot");
      return;
    }

    setTempStatus("saving");
    setTempError("");
    try {
      await saveSettings.mutateAsync({
        temperatureUnit: tempUnit,
        tireTemperatureThresholds: thresholdsInF,
      });
      setTempStatus("saved");
      setTimeout(() => setTempStatus("idle"), 2000);
    } catch (err) {
      setTempStatus("error");
      setTempError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function handleSpeedSave() {
    setSpeedStatus("saving");
    setSpeedError("");
    try {
      await saveSettings.mutateAsync({ speedUnit });
      setSpeedStatus("saved");
      setTimeout(() => setSpeedStatus("idle"), 2000);
    } catch (err) {
      setSpeedStatus("error");
      setSpeedError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  function handleTempReset() {
    setThresholds({ cold: 150, warm: 220, hot: 280 });
    setTempUnit("F");
    setSpeedUnit("mph");
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
    { value: "default", label: "Default", description: "Classic dark theme" },
    { value: "morph", label: "Morph", description: "Glassmorphic black" },
  ];

  return (
    <div className="flex h-full">
      {/* Left nav */}
      <nav className="w-48 shrink-0 border-r border-app-border bg-app-surface-alt/50 py-2">
        {NAV_ITEMS.map((item) => (
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
                  {t.value === "morph" && (
                    <div className="mt-2 h-8 rounded-md border border-[#2a2a2a] bg-gradient-to-br from-[#1e1e1e] to-[#141414]" />
                  )}
                  {t.value === "default" && (
                    <div className="mt-2 h-8 rounded-md border border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900" />
                  )}
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
                  placeholder="5300"
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

        {activeSection === "wheel" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Steering Wheel</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Choose the steering wheel style displayed during live telemetry.
            </p>
            <div className="grid grid-cols-2 gap-3 max-w-sm">
              {([
                { value: "svg" as WheelStyle, label: "Vector", description: "SVG illustration" },
                { value: "fanatec" as WheelStyle, label: "Photo", description: "Fanatec ClubSport F1" },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    setWheelStyle(opt.value);
                    localStorage.setItem(WHEEL_STYLE_KEY, opt.value);
                  }}
                  className={`relative rounded-lg border p-3 text-left transition-all ${
                    wheelStyle === opt.value
                      ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30"
                      : "border-app-border bg-app-surface-alt hover:border-app-border-input"
                  }`}
                >
                  <div className="text-sm font-medium text-app-text">{opt.label}</div>
                  <div className="text-xs text-app-text-muted mt-0.5">{opt.description}</div>
                  <div className="mt-2 h-16 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
                    {opt.value === "fanatec" ? (
                      <img src="/fanatec-f1-wheel.webp" alt="Fanatec F1 wheel" className="h-full object-contain" />
                    ) : (
                      <img src="/fanatec-f1-wheel.svg" alt="steering wheel" className="h-full object-contain" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {activeSection === "temperature" && (
          <section>
            <h2 className="text-lg font-semibold text-app-text mb-1">Temperature</h2>
            <p className="text-sm text-app-text-muted mb-4">
              Set the display unit and tire temperature color thresholds.
            </p>

            <div className="flex items-center gap-2 mb-4">
              <Label className="text-app-text-secondary mr-2">Unit</Label>
              <Button
                size="sm"
                variant={tempUnit === "F" ? "default" : "outline"}
                onClick={() => {
                  if (tempUnit === "C") {
                    setThresholds({
                      cold: celsiusToFahrenheit(thresholds.cold),
                      warm: celsiusToFahrenheit(thresholds.warm),
                      hot: celsiusToFahrenheit(thresholds.hot),
                    });
                  }
                  setTempUnit("F");
                }}
                className="w-12"
              >
                °F
              </Button>
              <Button
                size="sm"
                variant={tempUnit === "C" ? "default" : "outline"}
                onClick={() => {
                  if (tempUnit === "F") {
                    setThresholds({
                      cold: convertTemp(thresholds.cold, "C"),
                      warm: convertTemp(thresholds.warm, "C"),
                      hot: convertTemp(thresholds.hot, "C"),
                    });
                  }
                  setTempUnit("C");
                }}
                className="w-12"
              >
                °C
              </Button>
            </div>

            <div className="space-y-3 max-w-xs">
              <div>
                <Label htmlFor="threshold-cold" className="text-blue-400 text-xs">
                  Cold (below = blue)
                </Label>
                <Input
                  id="threshold-cold"
                  type="number"
                  value={parseFloat(thresholds.cold.toFixed(1))}
                  onChange={(e) => setThresholds({ ...thresholds, cold: parseFloat(e.target.value) || 0 })}
                  className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-24"
                />
              </div>
              <div>
                <Label htmlFor="threshold-warm" className="text-amber-400 text-xs">
                  Warm (above = amber)
                </Label>
                <Input
                  id="threshold-warm"
                  type="number"
                  value={parseFloat(thresholds.warm.toFixed(1))}
                  onChange={(e) => setThresholds({ ...thresholds, warm: parseFloat(e.target.value) || 0 })}
                  className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-24"
                />
              </div>
              <div>
                <Label htmlFor="threshold-hot" className="text-red-400 text-xs">
                  Hot (above = red)
                </Label>
                <Input
                  id="threshold-hot"
                  type="number"
                  value={parseFloat(thresholds.hot.toFixed(1))}
                  onChange={(e) => setThresholds({ ...thresholds, hot: parseFloat(e.target.value) || 0 })}
                  className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-24"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Button onClick={handleTempSave} disabled={tempStatus === "saving"}>
                {tempStatus === "saving" ? "Saving..." : tempStatus === "saved" ? "Saved" : "Save"}
              </Button>
              <Button variant="outline" onClick={handleTempReset}>
                Reset
              </Button>
            </div>

            {tempStatus === "error" && (
              <p className="text-red-400 text-sm mt-2">{tempError}</p>
            )}
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
                variant={speedUnit === "mph" ? "default" : "outline"}
                onClick={() => setSpeedUnit("mph")}
              >
                Imperial (mph, ft, lb)
              </Button>
              <Button
                size="sm"
                variant={speedUnit === "kmh" ? "default" : "outline"}
                onClick={() => setSpeedUnit("kmh")}
              >
                Metric (km/h, m, kg)
              </Button>
            </div>

            <div className="mt-4">
              <Button onClick={handleSpeedSave} disabled={speedStatus === "saving"}>
                {speedStatus === "saving" ? "Saving..." : speedStatus === "saved" ? "Saved" : "Save"}
              </Button>
            </div>

            {speedStatus === "error" && (
              <p className="text-red-400 text-sm mt-2">{speedError}</p>
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
                      if (p.id !== "url" && p.id !== "synth") {
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
      </div>
    </div>
  );
}
