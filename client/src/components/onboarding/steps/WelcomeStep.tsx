import { LOCALES } from "@shared/platform/i18n/locales";
import type { SemanticAnalysisFrame } from "@/components/analyse/track-map/types";
import type { SceneRuntime, SceneSource } from "@/components/wireframe/SceneRuntime";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CarWireframe } from "@/components/CarWireframe";
import { SearchSelect } from "@/components/ui/SearchSelect";
import { DEMO_CAR } from "@/data/car-models";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { applyLocale } from "@/lib/locale";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";

interface DemoFixture {
  frames: SemanticAnalysisFrame[];
}

function WelcomeViewport({ telemetry }: { telemetry: SemanticAnalysisFrame[] }) {
  const [cursorIdx, setCursorIdx] = useState(() => Math.floor(telemetry.length * 0.3));
  const rafIdRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const isDisposedRef = useRef(false);
  const lastTimeRef = useRef(0);
  const telemetryLengthRef = useRef(telemetry.length);
  const framesRef = useRef(telemetry);
  framesRef.current = telemetry;
  const cursorRef = useRef(cursorIdx);
  const [seekGeneration, setSeekGeneration] = useState(0);
  const seekGenerationRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const recording = typeof window !== "undefined" && Boolean((window as unknown as Record<string, unknown>).__recording);
  const initialCursorIdx = useRef(cursorIdx).current;
  const handleRuntime = useCallback((runtime: SceneRuntime | null) => {
    runtimeRef.current = runtime;
    const w = window as unknown as Record<string, unknown>;
    w.__captureSceneBitmap = recording && runtime ? () => runtime.captureBitmap() : undefined;
  }, [recording]);
  const source = useMemo<SceneSource>(() => ({
    framesRef, cursorRef, playing, playbackSpeed: 1, seekGeneration, recording,
  }), [playing, seekGeneration, recording]);
  const seek = useCallback(() => {
    const generation = ++seekGenerationRef.current;
    setSeekGeneration(generation);
    return generation;
  }, []);
  telemetryLengthRef.current = telemetry.length;
  const trackOrdinal = telemetry[0]?.values["identity.track-ordinal"];
  const pauseAnimation = useCallback(() => {
    if (!isRunningRef.current) return;
    setPlaying(false);
    isRunningRef.current = false;
    cancelAnimationFrame(rafIdRef.current);
  }, []);
  const resumeAnimation = useCallback(() => {
    if (isDisposedRef.current || isRunningRef.current) return;
    setPlaying(true);
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
        const next = prev + 1 >= totalPackets ? 0 : prev + 1;
        cursorRef.current = next;
        if (next === 0) seek();
        return next;
      });
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, [seek]);

  useQuery({
    queryKey: ["track-outline", trackOrdinal],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({ param: { ordinal: encodeURIComponent(String(trackOrdinal)) }, query: { gameId: "fm-2023" } });
      if (!res.ok) return null;
      const d = (await res.json()) as Record<string, unknown>;
      if (d?.points && Array.isArray(d.points)) return d.points as { x: number; z: number }[];
      if (Array.isArray(d)) return d as { x: number; z: number }[];
      return null;
    },
    enabled: !!trackOrdinal,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { data: boundaries } = useQuery({
    queryKey: ["track-boundaries", trackOrdinal],
    queryFn: async () => {
      const res = await client.api["track-boundaries"][":ordinal"].$get({ param: { ordinal: encodeURIComponent(String(trackOrdinal)) }, query: { gameId: "fm-2023" } });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!trackOrdinal,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    isDisposedRef.current = false;
    const expose = window as unknown as Record<string, unknown>;
    expose.__setFrame = (n: number) => {
      const idx = Math.max(0, Math.min(telemetryLengthRef.current - 1, n));
      cursorRef.current = idx;
      const generation = seek();
      flushSync(() => {
        setSeekGeneration(generation);
        setCursorIdx(idx);
      });
      return runtimeRef.current ? runtimeRef.current.requestFrame(generation) : Promise.resolve();
    };
    expose.__pauseAnimation = () => pauseAnimation();
    expose.__resumeAnimation = () => resumeAnimation();
    expose.__totalFrames = telemetryLengthRef.current;
    return () => {
      isDisposedRef.current = true;
      expose.__setFrame = undefined;
      expose.__pauseAnimation = undefined;
      expose.__resumeAnimation = undefined;
      expose.__totalFrames = undefined;
      pauseAnimation();
    };
  }, [pauseAnimation, resumeAnimation, seek]);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__totalFrames = telemetry.length;
  }, [telemetry.length]);
  useEffect(() => {
    if (telemetry.length === 0) return;
    resumeAnimation();
    return () => pauseAnimation();
  }, [pauseAnimation, resumeAnimation, telemetry]);
  const lapLine = useMemo(() => {
    if (telemetry.length < 2) return null;
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < telemetry.length; i += 10) {
      const p = telemetry[i];
      const x = p.values["motion.position-x"];
      const z = p.values["motion.position-z"];
      if (typeof x !== "number" || typeof z !== "number" || (x === 0 && z === 0)) continue;
      pts.push({ x, z });
    }
    return pts.length > 2 ? pts : null;
  }, [telemetry]);
  const packet = telemetry[cursorIdx] ?? telemetry[0];
  if (!packet) return null;
  const carOrdinal = packet.values["identity.car-ordinal"];
  return (
    <div className="w-full h-48 rounded-lg overflow-hidden border border-app-border bg-app-bg">
      <CarWireframe
        gameId="fm-2023"
        frame={telemetry[0]}
        source={source}
        telemetry={telemetry}
        cursorIdx={initialCursorIdx}
        onRuntime={handleRuntime}
        outline={lapLine}
        boundaries={boundaries ?? undefined}
        carOrdinal={typeof carOrdinal === "number" ? carOrdinal : undefined}
        carModel={DEMO_CAR}
        minimal
        hideControls
        autoOrbit
      />
    </div>
  );
}

export function WelcomeStep() {
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
  const { data: demoTelemetry, isLoading } = useQuery({
    queryKey: ["demo-lap"],
    queryFn: async () => {
      const res = await fetch("/demo-lap.json.gz");
      if (!res.ok) return [];
      return ((await res.json()) as DemoFixture).frames;
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
      /* best-effort persist; still switch UI locale below */
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
