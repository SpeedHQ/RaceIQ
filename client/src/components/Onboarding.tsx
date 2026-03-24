import { useState, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTelemetryStore } from "../stores/telemetry";
import { useSettings, useSaveSettings } from "../hooks/queries";
import type { TelemetryPacket } from "@shared/types";
import {
  getWheelStyle,
  type WheelStyle,
  getSoundEnabled,
  setSoundEnabled,
  getSoundVolume,
  setSoundVolume,
  getSoundType,
  setSoundType,
  SOUND_PRESETS,
} from "./Settings";
import { playBlip, preloadSound } from "./SectorTimes";
import {
  useProfiles,
  useActiveProfileId,
  useRenameProfile,
} from "../hooks/useProfiles";

const LazyCarWireframe = lazy(() =>
  import("./CarWireframe").then((m) => ({ default: m.CarWireframe }))
);

const ONBOARDING_KEY = "forza-onboarding-complete";
const WHEEL_STYLE_KEY = "forza-wheel-style";

export function isOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === "true";
}

export function markOnboardingComplete() {
  localStorage.setItem(ONBOARDING_KEY, "true");
}

/* ─── Welcome ─── */

function WelcomeViewport({ telemetry }: { telemetry: TelemetryPacket[] }) {
  const [cursorIdx, setCursorIdx] = useState(() => Math.floor(telemetry.length * 0.3));
  const trackOrdinal = telemetry[0]?.TrackOrdinal;

  // Fetch track outline
  const { data: outline } = useQuery({
    queryKey: ["track-outline", trackOrdinal],
    queryFn: async () => {
      const res = await fetch(`/api/track-outline/${trackOrdinal}`);
      if (!res.ok) return null;
      const d: any = await res.json();
      if (d?.points && Array.isArray(d.points)) return d.points as { x: number; z: number }[];
      if (Array.isArray(d)) return d as { x: number; z: number }[];
      return null;
    },
    enabled: !!trackOrdinal,
    staleTime: Infinity,
  });

  // Fetch track boundaries
  const { data: boundaries } = useQuery({
    queryKey: ["track-boundaries", trackOrdinal],
    queryFn: async () => {
      const res = await fetch(`/api/track-boundaries/${trackOrdinal}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!trackOrdinal,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (telemetry.length === 0) return;
    let lastTime = 0;
    let rafId: number;
    const frameDuration = 1000 / 60; // cap at 60fps

    function tick(time: number) {
      rafId = requestAnimationFrame(tick);
      if (time - lastTime < frameDuration) return;
      lastTime = time;
      setCursorIdx((prev) => {
        const next = prev + 1;
        return next >= telemetry.length ? 0 : next;
      });
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [telemetry]);

  // Build driving line from telemetry positions — downsample for perf
  const lapLine = useMemo(() => {
    if (telemetry.length < 2) return null;
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < telemetry.length; i += 10) {
      const p = telemetry[i];
      if (p.PositionX === 0 && p.PositionZ === 0) continue;
      pts.push({ x: p.PositionX, z: p.PositionZ });
    }
    return pts.length > 2 ? pts : null;
  }, [telemetry]);

  const packet = telemetry[cursorIdx] ?? telemetry[0];
  if (!packet) return null;

  return (
    <div className="w-full h-48 rounded-lg overflow-hidden border border-app-border bg-black">
      <Suspense fallback={<div className="w-full h-full animate-pulse bg-app-surface-alt" />}>
        <LazyCarWireframe
          packet={packet}
          telemetry={telemetry}
          cursorIdx={cursorIdx}
          outline={lapLine}
          boundaries={boundaries ?? undefined}
          carOrdinal={packet.CarOrdinal}
          minimal
          hideControls
          autoOrbit
        />
      </Suspense>
    </div>
  );
}

export function StepWelcome() {
  const { data: demoTelemetry, isLoading } = useQuery({
    queryKey: ["demo-lap"],
    queryFn: async () => {
      const res = await fetch("/demo-lap.csv");
      if (!res.ok) return [];
      const text = await res.text();
      const lines = text.split("\n");
      const headers = lines[0].split(",");
      const packets: TelemetryPacket[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const vals = lines[i].split(",");
        const obj: any = {};
        for (let j = 0; j < headers.length; j++) {
          obj[headers[j]] = Number(vals[j]);
        }
        packets.push(obj as TelemetryPacket);
      }
      return packets;
    },
    staleTime: Infinity,
  });

  const hasTelemetry = !!demoTelemetry?.length;

  return (
    <div className="flex flex-col items-center justify-center text-center py-6">
      {isLoading ? (
        <div className="mb-5 w-full h-48 rounded-lg bg-app-surface-alt animate-pulse" />
      ) : hasTelemetry ? (
        <div className="mb-5 w-full">
          <WelcomeViewport telemetry={demoTelemetry!} />
        </div>
      ) : (
        <div className="mb-5 relative w-64 h-20">
          <div className="absolute inset-0 bg-app-accent/5 rounded-lg blur-xl" />
          <svg viewBox="0 0 260 80" fill="none" className="relative w-full h-full">
            {[20, 40, 60].map((y) => (
              <line key={y} x1="0" y1={y} x2="260" y2={y} stroke="currentColor" strokeWidth="0.5" className="text-app-border" opacity="0.3" />
            ))}
            <polyline
              points="0,65 20,63 35,25 50,20 70,23 90,60 110,65 125,30 145,15 165,18 180,55 200,63 220,25 240,12 260,15"
              stroke="url(#accentGrad)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              strokeDasharray="400"
              strokeDashoffset="400"
              className="animate-[drawLine_2s_ease-out_forwards]"
            />
            <defs>
              <linearGradient id="accentGrad" x1="0" y1="0" x2="260" y2="0">
                <stop offset="0%" stopColor="var(--color-app-accent, #22d3ee)" stopOpacity="0.4" />
                <stop offset="50%" stopColor="var(--color-app-accent, #22d3ee)" stopOpacity="1" />
                <stop offset="100%" stopColor="var(--color-app-accent, #22d3ee)" stopOpacity="0.6" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      )}

      <h2 className="text-2xl font-bold text-app-text mb-2 tracking-tight">
        RaceIQ
      </h2>
      <p className="text-sm text-app-text-muted max-w-sm leading-relaxed">
        The most advanced sim racing telemetry dashboard.
      </p>
      <div className="flex items-center gap-2 mt-5">
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">
          Live telemetry
        </span>
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">
          Lap comparison
        </span>
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">
          AI analysis
        </span>
      </div>
    </div>
  );
}

/* ─── Profile ─── */

export function StepProfile() {
  const { data: profiles = [] } = useProfiles();
  const { data: activeProfileId } = useActiveProfileId();
  const renameProfile = useRenameProfile();
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const [name, setName] = useState(activeProfile?.name ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (activeProfile?.name && !name) setName(activeProfile.name);
  }, [activeProfile?.name]);

  async function handleSave() {
    if (!activeProfileId || !name.trim()) return;
    await renameProfile.mutateAsync({ id: activeProfileId, name: name.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">Profile Name</h2>
      <p className="text-sm text-app-text-muted mb-4">
        Give your profile a name. You can create additional profiles later.
      </p>
      <div className="flex items-end gap-2 max-w-xs">
        <div className="flex-1">
          <Label htmlFor="profile-name" className="text-app-text-secondary text-xs">
            Name
          </Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setSaved(false); }}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            className="glass-input border bg-app-surface-alt border-app-border-input text-app-text mt-1"
            placeholder="Driver 1"
          />
        </div>
        <Button size="sm" onClick={handleSave} disabled={!name.trim()}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/* ─── Wheel Style ─── */

export function StepWheel() {
  const [wheelStyle, setWheelStyle] = useState<WheelStyle>(() => getWheelStyle());

  function select(style: WheelStyle) {
    setWheelStyle(style);
    localStorage.setItem(WHEEL_STYLE_KEY, style);
  }

  const options = [
    { value: "svg" as WheelStyle, label: "Default", description: "" },
    { value: "fanatec" as WheelStyle, label: "Fanatec ClubSport F1", description: "" },
  ];

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-4">
        Choose the steering wheel displayed during live telemetry.
      </h2>
      <div className="grid grid-cols-2 gap-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => select(opt.value)}
            className={`relative rounded-lg border p-3 text-left transition-all ${
              wheelStyle === opt.value
                ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30"
                : "border-app-border bg-app-surface-alt hover:border-app-border-input"
            }`}
          >
            <div className="text-sm font-medium text-app-text">{opt.label}</div>
            {opt.description && <div className="text-xs text-app-text-muted mt-0.5">{opt.description}</div>}
            <div className="mt-2 h-32 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
              {opt.value === "fanatec" ? (
                <img src="/fanatec-f1-wheel.webp" alt="Fanatec F1 wheel" className="h-full object-contain" />
              ) : (
                <img src="/steering-wheel-simple.svg" alt="steering wheel" className="h-full object-contain" />
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Units ─── */

export function StepUnits() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [unitSystem, setUnitSystem] = useState<"metric" | "imperial">(displaySettings.unit);
  const [saved, setSaved] = useState(false);

  async function selectUnit(unit: "metric" | "imperial") {
    setUnitSystem(unit);
    setSaved(false);
    try {
      await saveSettings.mutateAsync({ unit });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">Units</h2>
      <p className="text-sm text-app-text-muted mb-4">
        Choose between Imperial and Metric for speed, distance, and temperature.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => selectUnit("imperial")}
          className={`rounded-lg border p-4 text-left transition-all ${
            unitSystem === "imperial"
              ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30"
              : "border-app-border bg-app-surface-alt hover:border-app-border-input"
          }`}
        >
          <div className="text-sm font-medium text-app-text">Imperial</div>
          <div className="text-xs text-app-text-muted mt-1">mph, ft, lb, °F</div>
        </button>
        <button
          onClick={() => selectUnit("metric")}
          className={`rounded-lg border p-4 text-left transition-all ${
            unitSystem === "metric"
              ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30"
              : "border-app-border bg-app-surface-alt hover:border-app-border-input"
          }`}
        >
          <div className="text-sm font-medium text-app-text">Metric</div>
          <div className="text-xs text-app-text-muted mt-1">km/h, m, kg, °C</div>
        </button>
      </div>
      {saved && <p className="text-xs text-emerald-400 mt-3">Saved</p>}
    </div>
  );
}

/* ─── Sound ─── */

export function StepSound() {
  const [enabled, setEnabled] = useState(() => getSoundEnabled());
  const [type, setType] = useState(() => getSoundType());
  const [volume, setVolume] = useState(() => getSoundVolume());

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">Sound</h2>
      <p className="text-sm text-app-text-muted mb-4">
        Audio feedback for sector changes and lap events.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <Label className="text-app-text-secondary text-sm">Sector blip</Label>
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          onClick={() => { setEnabled(true); setSoundEnabled(true); }}
        >
          On
        </Button>
        <Button
          size="sm"
          variant={!enabled ? "default" : "outline"}
          onClick={() => { setEnabled(false); setSoundEnabled(false); }}
        >
          Off
        </Button>
      </div>

      {enabled && (
        <>
          <div className="mb-4">
            <Label className="text-app-text-secondary text-xs mb-2 block">Preset</Label>
            <div className="flex flex-wrap gap-1.5">
              {SOUND_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={type === p.id ? "default" : "outline"}
                  onClick={() => {
                    setType(p.id);
                    setSoundType(p.id);
                    if (p.id !== "url") preloadSound(`/sounds/${p.id}.mp3`);
                    playBlip(1);
                  }}
                  className="text-xs"
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <Label className="text-app-text-secondary text-xs mb-2 block">
              Volume — {Math.round(volume * 100)}%
            </Label>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(volume * 100)}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10) / 100;
                setVolume(v);
                setSoundVolume(v);
              }}
              className="w-64 accent-cyan-500"
            />
          </div>

          <Button size="sm" variant="outline" onClick={() => playBlip(1.25)}>
            Preview
          </Button>
        </>
      )}
    </div>
  );
}

/* ─── Connection Test ─── */

export function StepConnection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [udpPort, setUdpPort] = useState(() => String((displaySettings as any).udpPort ?? 5300));
  const [portSaved, setPortSaved] = useState(false);
  const [portError, setPortError] = useState("");
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const connected = useTelemetryStore((s) => s.connected);
  const receiving = packetsPerSec > 0;

  async function handleSavePort() {
    const port = parseInt(udpPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      setPortError("Port must be between 1024-65535");
      return;
    }
    setPortError("");
    try {
      await saveSettings.mutateAsync({ udpPort: port } as any);
      setPortSaved(true);
      setTimeout(() => setPortSaved(false), 2000);
    } catch {
      setPortError("Failed to save");
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">Connection</h2>
      <p className="text-sm text-app-text-muted mb-4">
        Set the UDP port, then start a race in Forza to test the connection.
      </p>

      <div className="flex items-end gap-2 mb-4">
        <div>
          <Label htmlFor="onboard-port" className="text-app-text-secondary text-xs">
            UDP Port
          </Label>
          <Input
            id="onboard-port"
            type="number"
            min={1024}
            max={65535}
            value={udpPort}
            onChange={(e) => { setUdpPort(e.target.value); setPortSaved(false); }}
            onKeyDown={(e) => e.key === "Enter" && handleSavePort()}
            className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-28"
          />
        </div>
        <Button size="sm" onClick={handleSavePort}>
          {portSaved ? "Saved" : "Save"}
        </Button>
      </div>
      {portError && <p className="text-red-400 text-xs mb-3">{portError}</p>}

      <details className="mb-4 group">
        <summary className="text-xs text-app-accent cursor-pointer hover:text-app-accent/80 transition-colors">
          How to enable Data Out in Forza Motorsport
        </summary>
        <div className="mt-3 rounded-lg border border-app-border bg-app-surface-alt p-3">
          <ol className="space-y-1.5 text-xs text-app-text-muted list-decimal list-inside">
            <li>Open <span className="text-app-text">Settings</span> in Forza Motorsport.</li>
            <li>Go to <span className="text-app-text">Gameplay &amp; HUD</span>.</li>
            <li>Scroll to <span className="text-app-text">UDP Race Telemetry</span>.</li>
            <li>Set <span className="text-app-text">Data Out</span> to <span className="text-app-accent font-medium">On</span>.</li>
            <li>
              Set <span className="text-app-text">IP Address</span> to your PC's IP (or{" "}
              <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code> if same PC).
            </li>
            <li>
              Set <span className="text-app-text">Port</span> to{" "}
              <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">{udpPort || "5300"}</code>.
            </li>
            <li>Set <span className="text-app-text">Packet Format</span> to <span className="text-app-accent font-medium">Car Dash</span>.</li>
          </ol>
        </div>
      </details>

      <div className={`rounded-lg border p-4 transition-colors ${
        receiving
          ? "border-emerald-500/50 bg-emerald-500/5"
          : connected
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-app-border bg-app-surface-alt"
      }`}>
        <div className="flex items-center gap-3">
          <div className={`relative w-3 h-3 rounded-full ${
            receiving ? "bg-emerald-400" : connected ? "bg-amber-400" : "bg-app-text-muted/30"
          }`}>
            {!receiving && connected && (
              <span className="absolute inset-0 rounded-full bg-amber-400 animate-ping opacity-40" />
            )}
            {receiving && (
              <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-40" />
            )}
          </div>
          <div>
            <p className={`text-sm font-medium ${
              receiving ? "text-emerald-400" : connected ? "text-amber-400" : "text-app-text-muted"
            }`}>
              {receiving
                ? "Receiving telemetry!"
                : connected
                  ? "Connected — waiting for race data..."
                  : "WebSocket disconnected"}
            </p>
            <p className="text-xs text-app-text-muted mt-0.5">
              {receiving
                ? `${packetsPerSec} packets/sec`
                : connected
                  ? "Start a race in Forza (Practice, Qualifying, or Race). No data during menus, replays, or spectating."
                  : "Check that the server is running."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
