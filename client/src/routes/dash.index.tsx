import type { TelemetryPacket } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { type ReactNode, useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { ComboDash } from "../components/dashes/ComboDash";
import { ComboDash2 } from "../components/dashes/ComboDash2";
import { fakeForzaDisplayPacket, fakeForzaPacket, fakePit, fakeSectors, generateFakeSessionLaps } from "../stories/fakeData";
import { RotatePrompt } from "./__root";

const PREVIEW_LAPS = generateFakeSessionLaps(10);

const PREVIEW_RAW_PACKET = {
  ...fakeForzaPacket,
  BrakeTempFrontLeft: 380,
  BrakeTempFrontRight: 375,
  BrakeTempRearLeft: 240,
  BrakeTempRearRight: 238,
  TirePressureFrontLeft: 27.8,
  TirePressureFrontRight: 27.7,
  TirePressureRearLeft: 26.5,
  TirePressureRearRight: 26.4,
  f1: { ...(fakeForzaPacket.f1 ?? {}), totalLaps: 57 },
} as TelemetryPacket;

// Forza stores tire temps in °F — convert to °C.
const fToC = (f: number) => ((f - 32) * 5) / 9;

interface DashMeta {
  slug: "combo-1" | "combo-2";
  href: "/dash/combo-1" | "/dash/combo-2";
}

// Title/description resolve at render time (localized) — see dashTitle/dashDesc.
const DASH_META: DashMeta[] = [
  { slug: "combo-1", href: "/dash/combo-1" },
  { slug: "combo-2", href: "/dash/combo-2" },
];

const dashTitle = (slug: DashMeta["slug"]) => (slug === "combo-1" ? m.dash_race_hud() : m.dash_lap_pace());
const dashDesc = (slug: DashMeta["slug"]) => (slug === "combo-1" ? m.dash_combo1_desc() : m.dash_combo2_desc());

function useViewportSize() {
  const [size, setSize] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 844,
    h: typeof window !== "undefined" ? window.innerHeight : 390,
  }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return size;
}

function useNetworkInfo() {
  return useQuery<{ lanIps: string[]; port: number }>({
    queryKey: ["network-info"],
    queryFn: async () => {
      const res = await fetch("/api/network/info");
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    staleTime: 60_000,
    retry: false,
  });
}

function DashCatalogue() {
  const { data } = useNetworkInfo();
  const lanIp = data?.lanIps?.[0];
  const port = typeof window !== "undefined" ? window.location.port || data?.port : data?.port;
  const vp = useViewportSize();
  const SCALE = 0.6;
  const maxW = Math.floor(vp.w * SCALE);
  const maxH = Math.floor(vp.h * SCALE);
  const previewWidth = `min(100%, ${maxW}px, ${Math.floor((maxH * vp.w) / vp.h)}px)`;
  const previewAspect = `${vp.w} / ${vp.h}`;

  const previewFor = (slug: DashMeta["slug"]): ReactNode => {
    if (slug === "combo-1") {
      return <ComboDash rawPacket={PREVIEW_RAW_PACKET} packet={fakeForzaDisplayPacket} sectors={fakeSectors} pit={fakePit} unitSystem="metric" toTempC={fToC} />;
    }
    return <ComboDash2 rawPacket={PREVIEW_RAW_PACKET} sessionLaps={PREVIEW_LAPS} />;
  };

  return (
    <div className="min-h-screen bg-app-bg text-app-text p-8">
      <RotatePrompt />
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-black tracking-tight">{m.dash_page_title()}</h1>
          <p className="mt-2 text-app-text/60 text-sm">{m.dash_page_intro()}</p>
          {lanIp && port ? (
            <p className="mt-2 text-xs text-app-text/40 font-mono">
              {m.dash_serving_at()} http://{lanIp}:{port}
            </p>
          ) : (
            <p className="mt-2 text-xs text-status-danger/70 font-mono">{m.dash_lan_unavailable()}</p>
          )}
        </div>

        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {DASH_META.map((d) => {
            const url = lanIp && port ? `http://${lanIp}:${port}${d.href}` : null;
            return (
              <li key={d.slug} className="rounded-lg border border-app-text/10 bg-app-text/[0.03] overflow-hidden">
                <Link to={d.href} className="block group">
                  <div
                    className="relative bg-app-bg border-b border-app-text/10 overflow-hidden mx-auto"
                    style={{
                      aspectRatio: previewAspect,
                      width: previewWidth,
                      transform: "translateZ(0)",
                    }}
                  >
                    <div className="absolute inset-0 pointer-events-none">{previewFor(d.slug)}</div>
                    <div className="absolute inset-0 transition-colors group-hover:bg-app-surface-hover/50" />
                  </div>
                </Link>
                <div className="p-5 flex gap-4 items-start">
                  <div className="flex-1 min-w-0">
                    <Link to={d.href}>
                      <div className="text-lg font-bold mb-1 hover:text-app-accent">{dashTitle(d.slug)}</div>
                    </Link>
                    <div className="text-sm text-app-text/60 leading-relaxed">{dashDesc(d.slug)}</div>
                    <div className="mt-3 text-xs font-mono tracking-wider text-app-text/40 break-all">{url ?? d.href}</div>
                  </div>
                  {url && (
                    <div className="shrink-0 rounded bg-app-text p-2 hidden lg:block">
                      <QRCodeSVG value={url} size={96} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/dash/")({
  component: DashCatalogue,
});
