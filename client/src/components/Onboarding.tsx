import { LOCALES } from "@shared/platform/i18n/locales";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiDiscord, SiGithub } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { DEMO_CAR } from "../data/car-models";
import { useSaveSettings, useSettings } from "../hooks/queries";
import { client } from "../lib/rpc";
import { useTelemetryStore } from "../stores/telemetry";
import { CarWireframe } from "./CarWireframe";
import { playBlip, preloadSound } from "./SectorTimes";
import { getSoundEnabled, getSoundType, getSoundVolume, getWheelStyle, SOUND_PRESETS, setSoundEnabled, setSoundType, setSoundVolume } from "./Settings";

const WHEEL_STYLE_KEY = "forza-wheel-style";

/* ─── Welcome ─── */

function WelcomeViewport({ telemetry }: { telemetry: TelemetryPacket[] }) {
  const [cursorIdx, setCursorIdx] = useState(() => Math.floor(telemetry.length * 0.3));
  const rafIdRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const isDisposedRef = useRef(false);
  const lastTimeRef = useRef(0);
  const telemetryLengthRef = useRef(telemetry.length);
  telemetryLengthRef.current = telemetry.length;
  const trackOrdinal = telemetry[0]?.TrackOrdinal;

  const pauseAnimation = useCallback(() => {
    if (!isRunningRef.current) return;
    isRunningRef.current = false;
    cancelAnimationFrame(rafIdRef.current);
  }, []);

  const resumeAnimation = useCallback(() => {
    if (isDisposedRef.current || isRunningRef.current) return;

    isRunningRef.current = true;
    lastTimeRef.current = 0;

    const frameDuration = 1000 / 60;
    const tick = (time: number) => {
      if (!isRunningRef.current || isDisposedRef.current) return;

      rafIdRef.current = requestAnimationFrame(tick);
      if (time - lastTimeRef.current < frameDuration) return;

      lastTimeRef.current = time;
      setCursorIdx((prev) => {
        const totalPackets = telemetryLengthRef.current;
        const next = prev + 1;
        return next >= totalPackets ? 0 : next;
      });
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

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
    isDisposedRef.current = false;
    const expose = window as unknown as Record<string, unknown>;
    expose.__setFrame = (n: number) => {
      if (!isDisposedRef.current) setCursorIdx(n);
    };
    expose.__pauseAnimation = () => {
      pauseAnimation();
    };
    expose.__resumeAnimation = () => {
      resumeAnimation();
    };
    expose.__totalFrames = telemetryLengthRef.current;
    return () => {
      isDisposedRef.current = true;
      expose.__setFrame = undefined;
      expose.__pauseAnimation = undefined;
      expose.__resumeAnimation = undefined;
      expose.__totalFrames = undefined;
      pauseAnimation();
    };
  }, [pauseAnimation, resumeAnimation]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__totalFrames = telemetry.length;
  }, [telemetry.length]);

  useEffect(() => {
    if (telemetry.length === 0) return;
    resumeAnimation();
    return () => pauseAnimation();
  }, [pauseAnimation, resumeAnimation, telemetry]);

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
    <div className="w-full h-48 rounded-lg overflow-hidden border border-app-border bg-app-bg">
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

  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const currentLang = displaySettings.language ?? "en";
  const langOptions = LOCALES.map((loc) => ({ value: loc.code, label: `${loc.label} (${loc.code})` }));
  async function selectLanguage(code: string) {
    if (code === currentLang) return;
    try {
      await saveSettings.mutateAsync({ language: code });
    } catch {
      // best-effort persist; still switch the UI locale below
    }
    applyLocale(code);
  }

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
                <stop offset="0%" stopColor="var(--app-accent)" stopOpacity="0.4" />
                <stop offset="50%" stopColor="var(--app-accent)" stopOpacity="1" />
                <stop offset="100%" stopColor="var(--app-accent)" stopOpacity="0.6" />
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
      <div className="mt-6 w-full max-w-[220px] text-left">
        <div className="text-xs text-app-text-muted mb-1.5 text-center">{m.label_language()}</div>
        <SearchSelect value={currentLang} onChange={selectLanguage} options={langOptions} placeholder={m.settings_language_search_placeholder()} focusColor="app-accent" />
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
          <Button
            type="button"
            key={w.id}
            onClick={() => select(w.src)}
            className={`relative rounded-lg border p-3 text-left transition-all ${
              currentSrc === w.src ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
            }`}
          >
            <div className="text-sm font-medium text-app-text truncate">{w.name}</div>
            <div className="mt-2 h-24 flex items-center justify-center rounded-md border border-app-border bg-app-surface overflow-hidden">
              <img src={w.src} alt={w.name} className="h-full object-contain" />
            </div>
          </Button>
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
        <Button
          type="button"
          onClick={() => selectUnit("imperial")}
          className={`rounded-lg border p-4 text-left transition-all ${
            unitSystem === "imperial" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
          }`}
        >
          <div className="text-sm font-medium text-app-text">{m.ob_units_imperial()}</div>
          <div className="text-xs text-app-text-muted mt-1">mph, ft, lb</div>
        </Button>
        <Button
          type="button"
          onClick={() => selectUnit("metric")}
          className={`rounded-lg border p-4 text-left transition-all ${
            unitSystem === "metric" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
          }`}
        >
          <div className="text-sm font-medium text-app-text">{m.ob_units_metric()}</div>
          <div className="text-xs text-app-text-muted mt-1">km/h, m, kg</div>
        </Button>
      </div>

      <div className="mt-5 pt-5 border-t border-app-border">
        <h3 className="text-sm font-semibold text-app-text mb-1">{m.label_temperature()}</h3>
        <p className="text-xs text-app-text-muted mb-3">{m.ob_units_temperature_desc()}</p>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => selectTemperatureUnit("F")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${
              temperatureUnit === "F" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
            }`}
          >
            °F
          </Button>
          <Button
            type="button"
            onClick={() => selectTemperatureUnit("C")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${
              temperatureUnit === "C" ? "border-app-accent bg-app-accent/10 ring-1 ring-app-accent/30" : "border-app-border bg-app-surface-alt hover:border-app-border-hover"
            }`}
          >
            °C
          </Button>
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
          variant={enabled ? "selected-toggle" : "outline"}
          onClick={() => {
            setEnabled(true);
            setSoundEnabled(true);
          }}
        >
          {m.common_on()}
        </Button>
        <Button
          size="sm"
          variant={!enabled ? "selected-toggle" : "outline"}
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
            <Label className="text-app-text-secondary text-xs mb-2 block">
              {m.label_volume()} — {Math.round(volume * 100)}%
            </Label>
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
              className="w-64 accent-app-accent"
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
        <Button
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
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-app-text shadow-lg ring-0 transition-transform ${
              displaySettings.launchOnLogin ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </Button>
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
    <div className="@container/onboarding fixed inset-0 z-50 flex items-stretch justify-center bg-app-bg @3xl/onboarding:items-center @3xl/onboarding:p-4">
      <div className="flex max-h-screen w-full flex-col overflow-hidden border-app-border bg-app-surface shadow-2xl @3xl/onboarding:max-w-3xl @3xl/onboarding:rounded-xl @3xl/onboarding:border">
        {/* Header — hidden on welcome */}
        {step > 0 && (
          <div className="shrink-0 px-4 pt-4 pb-4 @3xl/onboarding:px-6 @3xl/onboarding:pt-6">
            <h1 className="text-app-heading font-semibold text-app-text @3xl/onboarding:text-app-title">{m.ob_configure_title()}</h1>
            <div className="flex items-center gap-2 mt-4 overflow-x-auto pb-1">
              {MODAL_STEPS.slice(1).map((s, idx) => {
                const i = idx + 1;
                return (
                  <div key={s.id} className="flex items-center gap-2 shrink-0">
                    <Button
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
                              ? "border-status-success bg-status-success/15 text-status-success"
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
                    </Button>
                    {idx < MODAL_STEPS.length - 2 && <div className={`w-8 h-px ${i < step ? "bg-status-success/50" : "bg-app-border"}`} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="min-h-[280px] flex-1 overflow-y-auto border-t border-app-border px-4 py-5 @3xl/onboarding:px-6">
          <StepComponent />
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end border-t border-app-border bg-app-surface-alt/30 px-4 py-4 @3xl/onboarding:px-6">
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                {m.common_back()}
              </Button>
            )}
            {step < MODAL_STEPS.length - 1 ? (
              <Button variant="app-primary" size="sm" onClick={() => setStep((s) => s + 1)}>
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
          {m.ob_discord()}
        </a>
        <a
          href="https://github.com/SpeedHQ/RaceIQ"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface-alt px-4 py-2.5 text-sm text-app-text-secondary hover:border-app-accent hover:text-app-accent transition-colors"
        >
          <SiGithub className="w-5 h-5" />
          {m.ob_github()}
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
            className="border bg-app-surface-alt border-app-border-input text-app-text font-mono mt-1 w-28"
          />
        </div>
        <Button size="sm" onClick={handleSavePort}>
          {portSaved ? m.common_saved() : m.common_save()}
        </Button>
      </div>
      {portError && <p className="text-status-danger text-xs mb-3">{portError}</p>}

      <details className="mb-4 group">
        <summary className="text-xs text-app-accent cursor-pointer hover:text-app-accent/80 transition-colors">{m.settings_forza_guide_toggle()}</summary>
        <div className="mt-3 rounded-lg border border-app-border bg-app-surface-alt p-3">
          <ol className="space-y-1.5 text-xs text-app-text-muted list-decimal list-inside">
            <li>{m.ob_forza_open_settings()}</li>
            <li>{m.ob_forza_go_to_gameplay()}</li>
            <li>{m.ob_forza_scroll_udp()}</li>
            <li>{m.setupguide_data_out_on()}</li>
            <li>
              {m.ob_ip_address_short()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code> {m.ob_ip_address_same_pc()}
            </li>
            <li>
              {m.ob_port_set_to()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">{udpPort || "5301"}</code>.
            </li>
            <li>{m.ob_packet_format_car_dash()}</li>
          </ol>
          <p className="mt-2 text-app-caption text-app-text-muted/70">{m.ob_connection_forza_note()}</p>
        </div>
      </details>

      <details className="mb-4 group">
        <summary className="text-xs text-app-accent cursor-pointer hover:text-app-accent/80 transition-colors">{m.settings_f1_guide_toggle()}</summary>
        <div className="mt-3 rounded-lg border border-app-border bg-app-surface-alt p-3">
          <ol className="space-y-1.5 text-xs text-app-text-muted list-decimal list-inside">
            <li>{m.ob_f1_open_settings()}</li>
            <li>{m.ob_f1_go_to_telemetry()}</li>
            <li>{m.setupguide_udp_telemetry_on()}</li>
            <li>{m.ob_udp_broadcast_off()}</li>
            <li>
              {m.ob_ip_address_short()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">127.0.0.1</code> {m.ob_ip_address_same_pc()}
            </li>
            <li>
              {m.ob_port_set_to()} <code className="text-app-accent bg-app-surface rounded px-1 py-0.5 font-mono">{udpPort || "5300"}</code>.
            </li>
            <li>{m.ob_udp_send_rate_short()}</li>
            <li>{m.setupguide_udp_format()}</li>
          </ol>
          <p className="mt-2 text-app-caption text-app-text-muted/70">{m.ob_connection_f1_note()}</p>
        </div>
      </details>

      <div className={`rounded-lg border p-4 transition-colors ${receiving ? "border-status-success/50 bg-status-success/5" : "border-app-border bg-app-surface-alt"}`}>
        <div className="flex items-center gap-3">
          <div className={`relative w-3 h-3 rounded-full ${receiving ? "bg-status-success" : "bg-app-text-muted/30"}`}>
            {receiving && <span className="absolute inset-0 rounded-full bg-status-success animate-ping opacity-40" />}
            {!receiving && <span className="absolute inset-0 rounded-full bg-app-text-muted/30 animate-ping opacity-40" />}
          </div>
          <div>
            <p className={`text-sm font-medium ${receiving ? "text-status-success" : "text-app-text-muted"}`}>
              {receiving ? (packetsPerSec > 0 ? m.ob_connection_status_receiving() : m.ob_connection_status_connected_waiting()) : m.ob_connection_status_waiting()}
            </p>
            <p className="text-xs text-app-text-muted mt-0.5">
              {receiving ? (packetsPerSec > 0 ? `${packetsPerSec} ${m.ob_connection_packets_per_sec()}` : `${udpPps} ${m.ob_connection_udp_pkts_hint()}`) : m.ob_connection_start_hint()}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
