import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { convertTemp, celsiusToFahrenheit } from "../lib/temperature";
import { useTelemetryStore } from "../stores/telemetry";
import { useTheme, type Theme } from "../context/theme";

// Steering lock stored in localStorage so it persists across refreshes
const STEER_LOCK_KEY = "forza-steer-lock";

export function getSteeringLock(): number {
  const val = localStorage.getItem(STEER_LOCK_KEY);
  return val ? parseInt(val, 10) : 900;
}

export function Settings() {
  const [udpPort, setUdpPort] = useState("5300");
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [steerLock, setSteerLock] = useState(() => String(getSteeringLock()));

  const { displaySettings, refetchSettings } = useTelemetryStore();
  const { theme, setTheme } = useTheme();
  const [tempUnit, setTempUnit] = useState<"F" | "C">(displaySettings.temperatureUnit);
  const [thresholds, setThresholds] = useState(displaySettings.tireTemperatureThresholds);
  const [speedUnit, setSpeedUnit] = useState<"mph" | "kmh">(displaySettings.speedUnit);
  const [tempStatus, setTempStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tempError, setTempError] = useState("");

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
  }, [tempSettingsJson]);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { udpPort: number }) => {
        setUdpPort(String(data.udpPort));
        setSavedPort(data.udpPort);
      })
      .catch(() => {});
  }, []);

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
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udpPort: savePort }),
      });
      const text = await res.text();
      let data: { udpPort?: number; error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Server error: ${text.slice(0, 100)}`);
      }
      if (!res.ok) {
        throw new Error(data.error || "Failed to save");
      }
      setSavedPort(data.udpPort ?? null);
      setUdpPort(String(data.udpPort));
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
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temperatureUnit: tempUnit,
          speedUnit: speedUnit,
          tireTemperatureThresholds: thresholdsInF,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      await refetchSettings();
      setTempStatus("saved");
      setTimeout(() => setTempStatus("idle"), 2000);
    } catch (err) {
      setTempStatus("error");
      setTempError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  function handleTempReset() {
    setThresholds({ cold: 150, warm: 220, hot: 280 });
    setTempUnit("F");
    setSpeedUnit("mph");
  }

  const themes: { value: Theme; label: string; description: string }[] = [
    { value: "default", label: "Default", description: "Classic dark theme" },
    { value: "morph", label: "Morph", description: "Glassmorphic black" },
  ];

  return (
    <>
    <Card className="glass-card border bg-app-surface border-app-border">
      <CardHeader>
        <CardTitle className="text-app-text">Theme</CardTitle>
        <CardDescription>
          Choose the visual style for the interface.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3">
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
                <div className="mt-2 h-8 rounded-md border border-white/10 bg-gradient-to-br from-white/5 to-transparent backdrop-blur-sm" />
              )}
              {t.value === "default" && (
                <div className="mt-2 h-8 rounded-md border border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900" />
              )}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>

    <Card className="glass-card border bg-app-surface border-app-border mt-4">
      <CardHeader>
        <CardTitle className="text-app-text">Forza Connection</CardTitle>
        <CardDescription>
          Set the UDP port to listen on. In Forza: Settings &gt; Gameplay &gt;
          Data Out &gt; set IP to this machine's address and the port below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-3">
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
                : "Apply"}
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

        <div className="mt-4 pt-4 border-t border-app-border">
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
      </CardContent>
    </Card>

    <Card className="glass-card border bg-app-surface border-app-border mt-4">
      <CardHeader>
        <CardTitle className="text-app-text">Temperature</CardTitle>
        <CardDescription>
          Set the display unit and tire temperature color thresholds.
        </CardDescription>
      </CardHeader>
      <CardContent>
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

        <div className="space-y-3">
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
            {tempStatus === "saving" ? "Saving..." : tempStatus === "saved" ? "Saved" : "Apply"}
          </Button>
          <Button variant="outline" onClick={handleTempReset}>
            Reset
          </Button>
        </div>

        {tempStatus === "error" && (
          <p className="text-red-400 text-sm mt-2">{tempError}</p>
        )}
      </CardContent>
    </Card>

    <Card className="glass-card border bg-app-surface border-app-border mt-4">
      <CardHeader>
        <CardTitle className="text-app-text">Speed & Distance</CardTitle>
        <CardDescription>
          Set the display units for speed and distance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Label className="text-app-text-secondary mr-2">Unit</Label>
          <Button
            size="sm"
            variant={speedUnit === "mph" ? "default" : "outline"}
            onClick={() => setSpeedUnit("mph")}
          >
            mph / mi
          </Button>
          <Button
            size="sm"
            variant={speedUnit === "kmh" ? "default" : "outline"}
            onClick={() => setSpeedUnit("kmh")}
          >
            km/h / km
          </Button>
        </div>
        <p className="text-xs text-app-text-muted mt-2">
          Changes are saved with the Apply button above.
        </p>
      </CardContent>
    </Card>
    </>
  );
}
