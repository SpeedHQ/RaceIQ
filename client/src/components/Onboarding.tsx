import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { LOCALES } from "@shared/locales";
import type { TelemetryPacket } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiDiscord, SiGithub } from "react-icons/si";
import { DEMO_CAR } from "../data/car-models";
import { useSaveSettings, useSettings } from "../hooks/queries";
import { client } from "../lib/rpc";
import { useTelemetryStore } from "../stores/telemetry";
import { CarWireframe } from "./CarWireframe";
import { playBlip, preloadSound } from "./SectorTimes";
import { SOUND_PRESETS, getSoundEnabled, getSoundType, getSoundVolume, getWheelStyle, setSoundEnabled, setSoundType, setSoundVolume } from "./Settings";

const WHEEL_STYLE_KEY = "forza-wheel-style";

/* ─── Welcome ─── */

function WelcomeViewport({ telemetry }: { telemetry: TelemetryPacket[] }) {
  const [cursorIdx, setCursorIdx] = useState(() => Math.floor(telemetry.length * 0.3));
  const rafIdRef = useRef<number>(0);
  const pausedRef = useRef(false);
  const trackOrdinal = telemetry[0]?.TrackOrdinal;

  // Fetch track outline
  useQuery({
    queryKey: ["track-outline", trackOrdinal],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({
        param: { ordinal: String(trackOrdinal) },
        query: { gameId: "fm-2023" },
      });
      if (!res.ok) return null;
      const d = (await res.json()) as Record<string, unknown>;
      if (d?.points && Array.isArray(d.points)) return d.points as { x: number; z: number }[];
      if (Array.isArray(d)) return d as { x: number; z: number }[];
      return null;
    },
    enabled: !!trackOrdinal,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Fetch track boundaries
  const { data: boundaries } = useQuery({
    queryKey: ["track-boundaries", trackOrdinal],
    queryFn: async () => {
      const res = await client.api["track-boundaries"][":ordinal"].$get({
        param: { ordinal: String(trackOrdinal) },
        query: { gameId: "fm-2023" },
      });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!trackOrdinal,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Expose frame control for Playwright recording
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__setFrame = (n: number) => setCursorIdx(n);
    (window as unknown as Record<string, unknown>).__pauseAnimation = () => {
      pausedRef.current = true;
      cancelAnimationFrame(rafIdRef.current);
    };
    (window as unknown as Record<string, unknown>).__resumeAnimation = () => {
      pausedRef.current = false;
      let lastTime = 0;
      const frameDuration = 1000 / 60;
      function tick(time: number) {
        if (pausedRef.current) return;
        rafIdRef.current = requestAnimationFrame(tick);
        if (time - lastTime < frameDuration) return;
        lastTime = time;
        setCursorIdx((prev) => {
          const next = prev + 1;
          return next >= telemetry.length ? 0 : next;
        });
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    (window as unknown as Record<string, unknown>).__totalFrames = telemetry.length;
    return () => {
      (window as unknown as Record<string, unknown>).__setFrame = undefined;
      (window as unknown as Record<string, unknown>).__pauseAnimation = undefined;
      (window as unknown as Record<string, unknown>).__totalFrames = undefined;
    };
  }, [telemetry.length]);

  useEffect(() => {
    if (telemetry.length === 0) return;
    pausedRef.current = false;
    let lastTime = 0;
    const frameDuration = 1000 / 60;

    function tick(time: number) {
      if (pausedRef.current) return;
      rafIdRef.current = requestAnimationFrame(tick);
      if (time - lastTime < frameDuration) return;
      lastTime = time;
      setCursorIdx((prev) => {
        const next = prev + 1;
        return next >= telemetry.length ? 0 : next;
      });
    }

    rafIdRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafIdRef.current);
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
      <CarWireframe
        gameId="fm-2023"
        packet={packet}
        telemetry={telemetry}
        cursorIdx={cursorIdx}
        outline={lapLine}
        boundaries={boundaries ?? undefined}
        carOrdinal={packet.CarOrdinal}
        carModel={DEMO_CAR}
        minimal
        hideControls
        autoOrbit
      />
    </div>
  );
}

export function StepWelcome() {
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
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
        const obj: Record<string, unknown> = {};
        for (let j = 0; j < headers.length; j++) {
          obj[headers[j]] = Number(vals[j]);
        }
        packets.push(obj as unknown as TelemetryPacket);
      }
      return packets;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  const telemetry = demoTelemetry ?? [];
  const hasTelemetry = telemetry.length > 0;

  return (
    <div className="flex flex-col items-center justify-center text-center py-6">
      {isLoading ? (
        <div className="mb-5 w-full h-48 rounded-lg bg-app-surface-alt animate-pulse" />
      ) : hasTelemetry ? (
        <div className="mb-5 w-full">
          <WelcomeViewport telemetry={telemetry} />
        </div>
      ) : (
        <div className="mb-5 relative w-64 h-20">
          <div className="absolute inset-0 bg-app-accent/5 rounded-lg blur-xl" />
          <svg viewBox="0 0 260 80" fill="none" className="relative w-full h-full" aria-hidden="true">
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

      <h2 className="text-2xl font-bold text-app-text mb-1 tracking-tight">RaceIQ</h2>
      {versionInfo?.current && <div className="text-xs font-mono text-app-text-muted mb-2">v{versionInfo.current}</div>}
      <p className="text-sm text-app-text-muted max-w-sm leading-relaxed">{m.ob_welcome_tagline()}</p>
      <div className="flex items-center gap-2 mt-5">
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">{m.ob_welcome_feature_live()}</span>
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">{m.ob_welcome_feature_compare()}</span>
        <span className="px-2.5 py-1 rounded-full border border-app-border bg-app-surface-alt text-xs text-app-text-secondary">{m.ob_welcome_feature_ai()}</span>
      </div>
    </div>
  );
}

/* ─── Profile ─── */

export function StepProfile() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  // Use server value as initial state; fall back to "" while loading
  const serverName = displaySettings.driverName ?? "";
  const [name, setName] = useState(serverName);
  const latestName = useRef(name);
  const committedName = useRef(serverName);

  // Keep latestName ref in sync via effect (not during render)
  useEffect(() => {
    latestName.current = name;
  }, [name]);

  // Populate from server once loaded (if still empty)
  useEffect(() => {
    if (serverName && !latestName.current) {
      setName(serverName);
      committedName.current = serverName;
    }
  }, [serverName]);

  // Save on unmount so clicking Next without blurring still saves
  useEffect(() => {
    return () => {
      const trimmed = latestName.current.trim();
      if (trimmed !== committedName.current) {
        saveSettings.mutate({ driverName: trimmed });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBlur = () => {
    const trimmed = name.trim();
    if (trimmed !== committedName.current) {
      committedName.current = trimmed;
      saveSettings.mutate({ driverName: trimmed });
    }
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.ob_profile_title()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_profile_desc()}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="driver-name" className="text-xs text-app-text-muted">
          {m.ob_profile_name_label()}
        </Label>
        <Input
          id="driver-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder={m.ob_profile_name_placeholder()}
          className="max-w-xs"
          autoFocus
        />
      </div>
    </div>
  );
}

/* ─── Language ─── */

export function StepLanguage() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const current = displaySettings.language ?? "en";

  async function selectLanguage(code: string) {
    if (code === current) return;
    try {
      await saveSettings.mutateAsync({ language: code });
    } catch {
      // best-effort persist; still switch the UI locale below
    }
    // Apply in place — no reload — so the wizard stays open and re-renders in
    // the newly chosen language.
    applyLocale(code);
  }

  const options = LOCALES.map((loc) => ({ value: loc.code, label: `${loc.label} (${loc.code})` }));

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_language()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_language_desc()}</p>
      <div className="max-w-xs">
        <SearchSelect value={current} onChange={selectLanguage} options={options} placeholder="Search language..." focusColor="app-accent" />
      </div>
    </div>
  );
}

/* ─── Wheel Style ─── */

export function StepWheel() {
  const [wheelStyle, setWheelStyle] = useState(() => getWheelStyle());
  const [wheels, setWheels] = useState<Array<{ id: string; name: string; src: string }>>([]);

  useEffect(() => {
    client.api.wheels
      .$get()
      .then((r) => r.json())
      .then(setWheels)
      .catch(() => {});
  }, []);

  function select(src: string) {
    setWheelStyle(src);
    localStorage.setItem(WHEEL_STYLE_KEY, src);
  }

  const currentSrc = wheelStyle;

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.ob_wheel_title()}</h2>
      <p className="text-xs text-app-text-muted mb-4">
        {m.ob_wheel_add_hint()} <code className="bg-app-surface-alt px-1 py-0.5 rounded">client/public/wheels/</code>
      </p>
      <div className="grid grid-cols-3 gap-3">
        {wheels.map((w) => (
          <button
            type="button"
            key={w.id}
            onClick={() => select(w.src)}
            className={`relative rounded-lg border p-3 text-left transition-all ${
              currentSrc === w.src ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
            }`}
          >
            <div className="text-sm font-medium text-app-text truncate">{w.name}</div>
            <div className="mt-2 h-24 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
              <img src={w.src} alt={w.name} className="h-full object-contain" />
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
  const [temperatureUnit, setTemperatureUnit] = useState<"C" | "F">(displaySettings.temperatureUnit);

  async function saveUnitSettings(next: { unit?: "metric" | "imperial"; temperatureUnit?: "C" | "F" }) {
    try {
      await saveSettings.mutateAsync({ unit: next.unit ?? unitSystem, temperatureUnit: next.temperatureUnit ?? temperatureUnit });
    } catch {
      // silent
    }
  }

  async function selectUnit(unit: "metric" | "imperial") {
    setUnitSystem(unit);
    await saveUnitSettings({ unit });
  }

  async function selectTemperatureUnit(next: "C" | "F") {
    setTemperatureUnit(next);
    await saveUnitSettings({ temperatureUnit: next });
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_units()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_units_desc()}</p>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => selectUnit("imperial")}
          className={`rounded-lg border p-4 text-left transition-all ${
            unitSystem === "imperial" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
          }`}
        >
          <div className="text-sm font-medium text-app-text">{m.ob_units_imperial()}</div>
          <div className="text-xs text-app-text-muted mt-1">mph, ft, lb</div>
        </button>
        <button
          type="button"
          onClick={() => selectUnit("metric")}
          className={`rounded-lg border p-4 text-left transition-all ${
            unitSystem === "metric" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
          }`}
        >
          <div className="text-sm font-medium text-app-text">{m.ob_units_metric()}</div>
          <div className="text-xs text-app-text-muted mt-1">km/h, m, kg</div>
        </button>
      </div>

      <div className="mt-5 pt-5 border-t border-app-border">
        <h3 className="text-sm font-semibold text-app-text mb-1">{m.label_temperature()}</h3>
        <p className="text-xs text-app-text-muted mb-3">{m.ob_units_temperature_desc()}</p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => selectTemperatureUnit("F")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${
              temperatureUnit === "F" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
            }`}
          >
            °F
          </button>
          <button
            type="button"
            onClick={() => selectTemperatureUnit("C")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${
              temperatureUnit === "C" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-input"
            }`}
          >
            °C
          </button>
        </div>
      </div>
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
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_sound()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_sound_desc()}</p>

      <div className="flex items-center gap-3 mb-4">
        <Label className="text-app-text-secondary text-sm">{m.ob_sound_sector_blip()}</Label>
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          onClick={() => {
            setEnabled(true);
            setSoundEnabled(true);
          }}
        >
          {m.common_on()}
        </Button>
        <Button
          size="sm"
          variant={!enabled ? "default" : "outline"}
          onClick={() => {
            setEnabled(false);
            setSoundEnabled(false);
          }}
        >
          {m.common_off()}
        </Button>
      </div>

      {enabled && (
        <>
          <div className="mb-4">
            <Label className="text-app-text-secondary text-xs mb-2 block">{m.ob_sound_preset()}</Label>
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
            <Label className="text-app-text-secondary text-xs mb-2 block">{m.label_volume()} — {Math.round(volume * 100)}%</Label>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(volume * 100)}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10) / 100;
                setVolume(v);
                setSoundVolume(v);
              }}
              className="w-64 accent-cyan-500"
            />
          </div>

          <Button size="sm" variant="outline" onClick={() => playBlip(1.25)}>
            {m.label_preview()}
          </Button>
        </>
      )}
    </div>
  );
}

/* ─── Startup ─── */

export function StepStartup() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const enabled = !!displaySettings.isCompiled;

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_launch_on_login()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_startup_desc()}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          disabled={!enabled}
          aria-checked={!!displaySettings.launchOnLogin}
          onClick={() => enabled && saveSettings.mutate({ launchOnLogin: !displaySettings.launchOnLogin })}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent ${
            !enabled
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
        <span className="text-sm text-app-text-muted">{!enabled ? m.settings_launch_installed_only() : displaySettings.launchOnLogin ? m.common_enabled() : m.common_disabled()}</span>
      </div>
    </div>
  );
}

/* ─── Onboarding Modal (state-managed, no routing) ─── */

// `id` is a stable React key (never localized); `label` renders the localized
// stepper caption.
const MODAL_STEPS = [
  { id: "welcome", label: m.step_welcome, Component: StepWelcome },
  { id: "language", label: m.label_language, Component: StepLanguage },
  { id: "profile", label: m.step_profile, Component: StepProfile },
  { id: "wheel", label: m.label_wheel, Component: StepWheel },
  { id: "units", label: m.label_units, Component: StepUnits },
  { id: "sound", label: m.label_sound, Component: StepSound },
  { id: "startup", label: m.step_startup, Component: StepStartup },
  { id: "community", label: m.step_community, Component: StepCommunity },
];

export function OnboardingModal({ onClose }: { onClose?: () => void } = {}) {
  const [step, setStep] = useState(0);
  const saveSettings = useSaveSettings();
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const lastUdpAt = useTelemetryStore((s) => s.lastUdpAt);
  const receiving = udpPps > 0 || packetsPerSec > 0 || lastUdpAt > 0;
  const { Component: StepComponent } = MODAL_STEPS[step];

  function handleFinish() {
    if (onClose) {
      onClose();
    } else {
      saveSettings.mutate({ onboardingComplete: true } as never);
    }
  }

  return (
    <div className="fixed inset-0 flex items-stretch md:items-center justify-center bg-app-bg md:p-4 z-50">
      <div className="w-full md:max-w-3xl md:rounded-xl md:border border-app-border bg-app-surface shadow-2xl overflow-hidden flex flex-col max-h-screen">
        {/* Header — hidden on welcome */}
        {step > 0 && (
          <div className="px-4 md:px-6 pt-4 md:pt-6 pb-4 shrink-0">
            <h1 className="text-base md:text-lg font-semibold text-app-text">{m.ob_configure_title()}</h1>
            <div className="flex items-center gap-2 mt-4 overflow-x-auto pb-1">
              {MODAL_STEPS.slice(1).map((s, idx) => {
                const i = idx + 1;
                return (
                  <div key={s.id} className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setStep(i)}
                      className={`flex items-center gap-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                        i === step ? "text-app-accent" : i < step ? "text-app-text-secondary" : "text-app-text-muted/50"
                      }`}
                    >
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors ${
                          i === step
                            ? "border-app-accent bg-app-accent/15 text-app-accent"
                            : i < step
                              ? "border-emerald-500 bg-emerald-500/15 text-emerald-400"
                              : "border-app-border bg-app-surface-alt text-app-text-muted/50"
                        }`}
                      >
                        {i < step ? (
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          idx + 1
                        )}
                      </span>
                      {s.label()}
                    </button>
                    {idx < MODAL_STEPS.length - 2 && <div className={`w-8 h-px ${i < step ? "bg-emerald-500/50" : "bg-app-border"}`} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="px-4 md:px-6 py-5 min-h-[280px] border-t border-app-border flex-1 overflow-y-auto">
          <StepComponent />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 md:px-6 py-4 border-t border-app-border bg-app-surface-alt/30 shrink-0">
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                {m.common_back()}
              </Button>
            )}
            {step < MODAL_STEPS.length - 1 ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                {step === 0 ? m.common_get_started() : m.common_next()}
              </Button>
            ) : (
              <Button size="sm" variant={receiving ? "default" : "outline"} onClick={handleFinish} disabled={saveSettings.isPending}>
                {receiving ? m.common_finish() : m.common_next()}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Community ─── */

export function StepCommunity() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6">
      <h2 className="text-2xl font-bold text-app-text mb-2 tracking-tight">{m.ob_community_title()}</h2>
      <p className="text-sm text-app-text-muted max-w-md leading-relaxed mt-2">{m.ob_community_body()}</p>
      <div className="flex items-center gap-4 mt-5">
        <a
          href="https://discord.gg/ZNXKyYPumT"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface-alt px-4 py-2.5 text-sm text-app-text-secondary hover:border-app-accent hover:text-app-accent transition-colors"
        >
          <SiDiscord className="w-5 h-5" />
          Discord
        </a>
        <a
          href="https://github.com/SpeedHQ/RaceIQ"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface-alt px-4 py-2.5 text-sm text-app-text-secondary hover:border-app-accent hover:text-app-accent transition-colors"
        >
          <SiGithub className="w-5 h-5" />
          GitHub
        </a>
      </div>
    </div>
  );
}

/* ─── Connection Test ─── */

export function StepConnection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [udpPort, setUdpPort] = useState(() => {
    const settings = displaySettings as Record<string, unknown>;
    const udpPortValue = settings.udpPort;
    return typeof udpPortValue === "number" ? String(udpPortValue) : "5301";
  });
  const [portSaved, setPortSaved] = useState(false);
  const [portError, setPortError] = useState("");
  const packetsPerSec = useTelemetryStore((s) => s.packetsPerSec);
  const udpPps = useTelemetryStore((s) => s.udpPps);
  const lastUdpAt = useTelemetryStore((s) => s.lastUdpAt);
  const receiving = udpPps > 0 || packetsPerSec > 0 || lastUdpAt > 0;

  async function handleSavePort() {
    const port = Number.parseInt(udpPort, 10);
    if (Number.isNaN(port) || port < 1024 || port > 65535) {
      setPortError(m.settings_port_range_error());
      return;
    }
    setPortError("");
    try {
      await saveSettings.mutateAsync({ udpPort: port });
      setPortSaved(true);
      setTimeout(() => setPortSaved(false), 2000);
    } catch {
      setPortError(m.label_failed_to_save());
    }
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_connection()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_connection_desc()}</p>

      <div className="flex items-end gap-2 mb-4">
        <div>
          <Label htmlFor="onboard-port" className="text-app-text-secondary text-xs">
            {m.label_udp_port()}
          </Label>
          <Input
            id="onboard-port"
            type="number"
            min={1024}
            max={65535}
            value={udpPort}
            onChange={(e) => {
              setUdpPort(e.target.value);
              setPortSaved(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && handleSavePort()}
            className="glass-input border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-28"
          />
        </div>
        <Button size="sm" onClick={handleSavePort}>
          {portSaved ? m.common_saved() : m.common_save()}
        </Button>
      </div>
      {portError && <p className="text-red-400 text-xs mb-3">{portError}</p>}

      <details className="mb-4 group">
        <summary className="text-xs text-app-accent cursor-pointer hover:text-app-accent/80 transition-colors">{m.settings_forza_guide_toggle()}</summary>
        <div className="mt-3 rounded-lg border border-app-border bg-app-surface-alt p-3">
          <ol className="space-y-1.5 text-xs text-app-text-muted list-decimal list-inside">
            <li>
              Open <span className="text-app-text">Settings</span> in Forza Motorsport.
            </li>
            <li>
              Go to <span className="text-app-text">Gameplay &amp; HUD</span>.
            </li>
            <li>
              Scroll to <span className="text-app-text">UDP Race Telemetry</span>.
            </li>
            <li>
              Set <span className="text-app-text">Data Out</span> to <span className="text-app-accent font-medium">On</span>.
            </li>
            <li>
              Set <span className="text-app-text">IP Address</span> to your PC's IP (or <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code> if same PC).
            </li>
            <li>
              Set <span className="text-app-text">Port</span> to <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">{udpPort || "5301"}</code>.
            </li>
            <li>
              Set <span className="text-app-text">Packet Format</span> to <span className="text-app-accent font-medium">Car Dash</span>.
            </li>
          </ol>
          <p className="mt-2 text-[10px] text-app-text-muted/70">{m.ob_connection_forza_note()}</p>
        </div>
      </details>

      <details className="mb-4 group">
        <summary className="text-xs text-app-accent cursor-pointer hover:text-app-accent/80 transition-colors">{m.settings_f1_guide_toggle()}</summary>
        <div className="mt-3 rounded-lg border border-app-border bg-app-surface-alt p-3">
          <ol className="space-y-1.5 text-xs text-app-text-muted list-decimal list-inside">
            <li>
              Open <span className="text-app-text">Settings</span> in F1 2025.
            </li>
            <li>
              Go to <span className="text-app-text">Telemetry Settings</span>.
            </li>
            <li>
              Set <span className="text-app-text">UDP Telemetry</span> to <span className="text-app-accent font-medium">On</span>.
            </li>
            <li>
              Set <span className="text-app-text">UDP Broadcast Mode</span> to <span className="text-app-accent font-medium">Off</span>.
            </li>
            <li>
              Set <span className="text-app-text">IP Address</span> to your PC's IP (or <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code> if same PC).
            </li>
            <li>
              Set <span className="text-app-text">Port</span> to <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">{udpPort || "5300"}</code>.
            </li>
            <li>
              Set <span className="text-app-text">UDP Send Rate</span> to <span className="text-app-accent font-medium">60 Hz</span>.
            </li>
            <li>
              Set <span className="text-app-text">UDP Format</span> to <span className="text-app-accent font-medium">2025</span>.
            </li>
          </ol>
          <p className="mt-2 text-[10px] text-app-text-muted/70">{m.ob_connection_f1_note()}</p>
        </div>
      </details>

      <div className={`rounded-lg border p-4 transition-colors ${receiving ? "border-emerald-500/50 bg-emerald-500/5" : "border-app-border bg-app-surface-alt"}`}>
        <div className="flex items-center gap-3">
          <div className={`relative w-3 h-3 rounded-full ${receiving ? "bg-emerald-400" : "bg-app-text-muted/30"}`}>
            {receiving && <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-40" />}
            {!receiving && <span className="absolute inset-0 rounded-full bg-app-text-muted/30 animate-ping opacity-40" />}
          </div>
          <div>
            <p className={`text-sm font-medium ${receiving ? "text-emerald-400" : "text-app-text-muted"}`}>
              {receiving ? (packetsPerSec > 0 ? m.ob_connection_status_receiving() : m.ob_connection_status_connected_waiting()) : m.ob_connection_status_waiting()}
            </p>
            <p className="text-xs text-app-text-muted mt-0.5">
              {receiving ? (packetsPerSec > 0 ? m.ob_connection_packets_per_sec({ count: packetsPerSec }) : m.ob_connection_udp_pkts_hint({ count: udpPps })) : m.ob_connection_start_hint()}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
