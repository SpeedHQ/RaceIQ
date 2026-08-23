import { LOCALES } from "@shared/platform/i18n/locales";
import type { TelemetryPacket } from "@shared/telemetry/types";
import type { SemanticAnalysisFrame } from "@/components/analyse/track-map/types";
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

function toSemanticFrame(packet: TelemetryPacket): SemanticAnalysisFrame {
  const values: Record<string, unknown> = {
    "identity.track-ordinal": packet.TrackOrdinal, "identity.car-ordinal": packet.CarOrdinal,
    "motion.position-x": packet.PositionX, "motion.position-z": packet.PositionZ, "motion.speed": packet.Speed,
    "motion.yaw": packet.Yaw, "motion.pitch": packet.Pitch, "motion.roll": packet.Roll,
    "inputs.gear": packet.Gear, "inputs.steering": packet.Steer, "timing.distance-traveled": packet.DistanceTraveled,
    "tire.temperature.average": [packet.TireTempFL, packet.TireTempFR, packet.TireTempRL, packet.TireTempRR],
  };
  return { values, states: {}, freshness: {} };
}
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

  useQuery({
    queryKey: ["track-outline", trackOrdinal],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: "fm-2023" } });
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
      const res = await client.api["track-boundaries"][":ordinal"].$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: "fm-2023" } });
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
      if (!isDisposedRef.current) setCursorIdx(n);
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
  }, [pauseAnimation, resumeAnimation]);
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
        frame={toSemanticFrame(packet)}
        telemetry={telemetry.map(toSemanticFrame)}
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

export function WelcomeStep() {
  const versionInfo = useTelemetryStore((s) => s.versionInfo);
  const { data: demoTelemetry, isLoading } = useQuery({
    queryKey: ["demo-lap"],
    queryFn: async () => {
      const res = await fetch("/demo-lap.csv");
      if (!res.ok) return [];
      const lines = (await res.text()).split("\n");
      const headers = lines[0].split(",");
      const packets: TelemetryPacket[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const vals = lines[i].split(",");
        const obj: Record<string, unknown> = {};
        for (let j = 0; j < headers.length; j++) obj[headers[j]] = Number(vals[j]);
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
