import { useEffect, useState } from "react";
import { isDevelopment } from "@/lib/env";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { convertTemp, celsiusToFahrenheit } from "../lib/temperature";
import { playBlip, preloadSound } from "./SectorTimes";
import { useSettings, useSaveSettings } from "../hooks/queries";
import { useTheme, type Theme } from "../context/theme";
import { client } from "../lib/rpc";
import { useTelemetryStore } from "../stores/telemetry";

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

const DEFAULT_WHEEL = "/wheels/Simple.svg";

export function getWheelStyle(): string {
  return localStorage.getItem(WHEEL_STYLE_KEY) || DEFAULT_WHEEL;
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

interface WheelOption { id: string; name: string; src: string }

function WheelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [wheels, setWheels] = useState<WheelOption[]>([]);

  useEffect(() => {
    client.api.wheels.$get().then(r => r.json()).then(setWheels).catch(() => {});
  }, []);

  const currentSrc = value;

  return (
    <div className="grid grid-cols-3 gap-3 max-w-lg">
      {wheels.map((w) => (
        <button
          key={w.id}
          onClick={() => onChange(w.src)}
          className={`relative rounded-lg border p-3 text-left transition-all ${
            currentSrc === w.src
              ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30"
              : "border-app-border bg-app-surface-alt hover:border-app-border-input"
          }`}
        >
          <div className="text-sm font-medium text-app-text truncate">{w.name}</div>
          <div className="mt-2 h-20 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
            <img src={w.src} alt={w.name} className="h-full object-contain" />
          </div>
        </button>
      ))}
      {wheels.length === 0 && (
        <p className="text-sm text-app-text-muted col-span-3">No wheel images found in client/public/wheels/</p>
      )}
    </div>
  );
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
  { id: "ai", label: "AI Analysis" },
  { id: "developer", label: "Developer", devOnly: true },
  { id: "updates", label: "Updates" },
  { id: "about", label: "About" },
] as const;

type SectionId = (typeof NAV_ITEMS)[number]["id"];

function AiSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<"claude-cli" | "gemini">(displaySettings.aiProvider ?? "claude-cli");
  const [model, setModel] = useState(displaySettings.aiModel ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const hasKey = !!(displaySettings as any).geminiApiKeySet;

  const { data: aiModels } = useQuery({
    queryKey: ["ai-models", provider],
    queryFn: async () => {
      const res = await fetch("/api/ai-models");
      return res.json() as Promise<Record<string, { id: string; name: string }[]>>;
    },
  });

  const models = aiModels?.[provider] ?? [];

  const handleSave = async () => {
    if (apiKey) {
      await fetch("/api/ai-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini", apiKey }),
      });
      setApiKey("");
    }
    saveSettings.mutate({ aiProvider: provider, aiModel: model });
    qc.invalidateQueries({ queryKey: ["ai-models"] });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-app-text mb-4">AI Analysis Provider</h2>
      <p className="text-xs text-app-text-muted mb-4">
        Choose which AI provider to use for lap analysis. Claude CLI uses your locally installed Claude Code. Gemini uses Google's API with your own key.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-app-text-muted mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => { setProvider(e.target.value as "claude-cli" | "gemini"); setModel(""); }}
            className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
          >
            <option value="claude-cli">Claude CLI (local)</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </div>
        {models.length > 0 && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs"
            >
              <option value="">Default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
        {provider === "gemini" && (
          <div>
            <label className="block text-xs text-app-text-muted mb-1">Gemini API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? "••••••••  (key stored)" : "AIza..."}
              className="bg-app-surface border border-app-border-input rounded px-3 py-1.5 text-sm text-app-text w-full max-w-xs font-mono"
            />
            <p className="text-xs text-app-text-muted mt-1">
              Get a free API key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Google AI Studio</a>
            </p>
          </div>
        )}
        <button
          onClick={handleSave}
          className="text-sm px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </section>
  );
}

function UpdatesSection() {
  const updateAvailable = useTelemetryStore((s) => s.updateAvailable);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checked: boolean;
  } | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await client.api.update.check.$post();
      setCheckResult(await res.json() as any);
    } catch {
      setCheckResult(null);
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    setApplying(true);
    try {
      await client.api.update.apply.$post();
    } catch {
      setApplying(false);
    }
    // If apply succeeds, the server exits — app will reconnect after restart
  };

  const showUpdate = checkResult?.updateAvailable || !!updateAvailable;
  const latestVersion = checkResult?.latest ?? updateAvailable;
  const currentVersion = checkResult?.current;

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-1">Updates</h2>
      {currentVersion && (
        <p className="text-sm text-app-text-muted mb-4">
          Current version: <span className="text-app-text font-mono">{currentVersion}</span>
        </p>
      )}

      {showUpdate && latestVersion && (
        <div className="rounded-lg border border-app-accent/30 bg-app-accent/5 p-4 space-y-3 mb-4">
          <p className="text-sm font-medium text-app-accent">
            Update available: v{latestVersion}
          </p>
          <div className="flex gap-3">
            <Button
              onClick={handleInstall}
              disabled={applying}
              className="bg-app-accent text-black hover:bg-app-accent/90"
            >
              {applying ? "Installing..." : "Install Update"}
            </Button>
            <Button variant="outline" onClick={() => setCheckResult(null)}>
              Later
            </Button>
          </div>
          {applying && (
            <p className="text-xs text-app-text-muted">
              RaceIQ will restart after installing. This page may briefly disconnect.
            </p>
          )}
        </div>
      )}

      {checkResult && !checkResult.updateAvailable && (
        <p className="text-sm text-app-text-muted mb-4">
          You&apos;re on the latest version ({checkResult.current}).
        </p>
      )}

      <Button onClick={handleCheck} disabled={checking} variant="outline">
        {checking ? "Checking..." : "Check for Updates"}
      </Button>
    </section>
  );
}

function ExtractionSection() {
  const [status, setStatus] = useState<{
    status: string;
    installed: boolean;
    extracted: number;
    failed: number;
    total: number;
    current: string;
    error: string;
  } | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await client.api.extraction.status.$get();
      setStatus(await res.json());
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Poll while running
  useEffect(() => {
    if (status?.status !== "running") return;
    const interval = setInterval(fetchStatus, 500);
    return () => clearInterval(interval);
  }, [status?.status]);

  const handleExtract = async () => {
    await client.api.extraction.run.$post();
    fetchStatus();
  };

  const isRunning = status?.status === "running";
  const isDone = status?.status === "done";
  const progress = status && status.total > 0
    ? Math.round((status.extracted + status.failed) / status.total * 100)
    : 0;

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-4">Forza Motorsport 2023 Extraction</h2>

      {!status?.installed && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3 mb-4">
          <p className="text-sm text-yellow-300">
            Forza Motorsport 2023 not detected. Make sure it's installed via Steam.
          </p>
        </div>
      )}

      {isDone && status.extracted > 0 && (
        <div className="rounded-md bg-green-500/10 border border-green-500/30 p-3 mb-4">
          <p className="text-sm text-green-300">
            {status.extracted} track outlines extracted
            {status.failed > 0 && <span className="text-app-text-muted"> ({status.failed} skipped)</span>}
          </p>
        </div>
      )}

      {status?.status === "error" && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 p-3 mb-4">
          <p className="text-sm text-red-300">{status.error}</p>
        </div>
      )}

      {isRunning && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 flex-1 rounded-full bg-app-surface-alt overflow-hidden">
              <div
                className="h-full bg-app-accent transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-app-text-muted w-10 text-right">{progress}%</span>
          </div>
          <p className="text-xs text-app-text-muted">
            Extracting {status.current}... ({status.extracted} done)
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handleExtract}
          disabled={isRunning || !status?.installed}
          variant={isDone ? "outline" : "default"}
        >
          {isRunning ? "Extracting..." : isDone ? "Re-extract" : "Extract Track Data"}
        </Button>
        {isDone && status.extracted > 0 && (
          <Button
            variant="outline"
            className="text-red-400 border-red-500/30 hover:bg-red-500/10"
            onClick={async () => {
              await client.api.extraction.data.$delete();
              fetchStatus();
            }}
          >
            Delete Extracted Data
          </Button>
        )}
      </div>
    </section>
  );
}

function F1ExtractionSection() {
  const [status, setStatus] = useState<{
    status: string;
    installed: boolean;
    extracted: number;
    failed: number;
    total: number;
    current: string;
    error: string;
  } | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await client.api.extraction.f1.status.$get();
      setStatus(await res.json());
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (status?.status !== "running") return;
    const interval = setInterval(fetchStatus, 500);
    return () => clearInterval(interval);
  }, [status?.status]);

  const handleExtract = async () => {
    await client.api.extraction.f1.run.$post();
    fetchStatus();
  };

  const isRunning = status?.status === "running";
  const isDone = status?.status === "done";
  const progress = status && status.total > 0
    ? Math.round((status.extracted + status.failed) / status.total * 100)
    : 0;

  return (
    <section>
      <h2 className="text-lg font-semibold text-app-text mb-4">F1 2025 Extraction</h2>

      {!status?.installed && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3 mb-4">
          <p className="text-sm text-yellow-300">
            F1 25 not detected. Make sure it's installed via Steam.
          </p>
        </div>
      )}

      {isDone && status.extracted > 0 && (
        <div className="rounded-md bg-green-500/10 border border-green-500/30 p-3 mb-4">
          <p className="text-sm text-green-300">
            {status.extracted} track outlines extracted
            {status.failed > 0 && <span className="text-app-text-muted"> ({status.failed} skipped)</span>}
          </p>
        </div>
      )}

      {status?.status === "error" && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 p-3 mb-4">
          <p className="text-sm text-red-300">{status.error}</p>
        </div>
      )}

      {isRunning && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 flex-1 rounded-full bg-app-surface-alt overflow-hidden">
              <div
                className="h-full bg-app-accent transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-app-text-muted w-10 text-right">{progress}%</span>
          </div>
          <p className="text-xs text-app-text-muted">
            Extracting {status.current}... ({status.extracted} done)
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handleExtract}
          disabled={isRunning || !status?.installed}
          variant={isDone ? "outline" : "default"}
        >
          {isRunning ? "Extracting..." : isDone ? "Re-extract" : "Extract Track Data"}
        </Button>
        {isDone && status.extracted > 0 && (
          <Button
            variant="outline"
            className="text-red-400 border-red-500/30 hover:bg-red-500/10"
            onClick={async () => {
              await client.api.extraction.f1.data.$delete();
              fetchStatus();
            }}
          >
            Delete Extracted Data
          </Button>
        )}
      </div>
    </section>
  );
}

function AboutSection() {
  const [versionInfo, setVersionInfo] = useState<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    checked: boolean;
  } | null>(null);

  useEffect(() => {
    client.api.version.$get()
      .then((r) => r.json())
      .then(setVersionInfo)
      .catch(() => {});
  }, []);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-app-text mb-4">About</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b border-app-border">
            <span className="text-sm text-app-text-secondary">Version</span>
            <span className="text-sm text-app-text font-mono">
              {versionInfo ? `v${versionInfo.current}` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-app-border">
            <span className="text-sm text-app-text-secondary">Latest release</span>
            <span className="text-sm text-app-text font-mono">
              {!versionInfo?.checked
                ? "Checking..."
                : versionInfo.latest
                  ? `v${versionInfo.latest}`
                  : "Unknown"}
            </span>
          </div>
          {versionInfo?.updateAvailable && (
            <div className="flex items-center justify-between py-3 px-4 rounded-lg bg-yellow-400/10 border border-yellow-400/30">
              <span className="text-sm text-yellow-400">Update available</span>
              <a
                href="https://github.com/SpeedHQ/RaceIQ/releases/latest"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-yellow-400 underline underline-offset-2"
              >
                Download v{versionInfo.latest}
              </a>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function Settings({ initialSection, onClose }: { initialSection?: SectionId; onClose?: () => void } = {}) {
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
  const [thresholds, setThresholds] = useState(displaySettings.tireTempCelsiusThresholds);
  const [healthThresholds, setHealthThresholds] = useState(displaySettings.tireHealthThresholds.values);
  const [suspThresholds, setSuspThresholds] = useState(displaySettings.suspensionThresholds.values);
  const [tempStatus, setTempStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tempError, setTempError] = useState("");
  const [healthStatus, setHealthStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [healthError, setHealthError] = useState("");
  const [suspStatus, setSuspStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [suspError, setSuspError] = useState("");
  const [unitStatus, setUnitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [unitError, setUnitError] = useState("");

  const tempSettingsJson = JSON.stringify(displaySettings);
  useEffect(() => {
    const u = displaySettings.unit;
    const tu = u === "metric" ? "C" as const : "F" as const;
    const raw = displaySettings.tireTempCelsiusThresholds;
    setUnitSystem(u);
    // Server always stores in °F — convert to display unit
    setThresholds(tu === "C" ? {
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
        unit: unitSystem,
        tireTempCelsiusThresholds: thresholdsInF,
      });
      setTempStatus("saved");
      setTimeout(() => setTempStatus("idle"), 2000);
    } catch (err) {
      setTempStatus("error");
      setTempError(err instanceof Error ? err.message : "Failed to save");
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

  function handleTempReset() {
    setThresholds({ cold: 150, warm: 220, hot: 280 });
    setUnitSystem("imperial");
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
          <Link to="/onboarding" onClick={onClose}>
            <button className="w-full text-left px-4 py-2 text-sm text-app-text-muted hover:text-app-text hover:bg-app-surface-alt transition-colors">
              Setup Wizard
            </button>
          </Link>
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
                  setUnitSystem("imperial");
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
                  setUnitSystem("metric");
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
