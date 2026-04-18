import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState, type ReactNode } from "react";
import { ComboDash } from "../components/dashes/ComboDash";
import { ComboDash2 } from "../components/dashes/ComboDash2";
import {
  fakeForzaPacket,
  fakeForzaDisplayPacket,
  fakeSectors,
  fakePit,
  generateFakeSessionLaps,
} from "../stories/fakeData";
import type { TelemetryPacket } from "@shared/types";

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
  title: string;
  description: string;
  href: "/dash/combo-1" | "/dash/combo-2";
}

const DASH_META: DashMeta[] = [
  {
    slug: "combo-1",
    href: "/dash/combo-1",
    title: "Combo Dash 1 — Race HUD",
    description:
      "Rev bar + gear/speed/lap tiles, fuel & tire laps-remaining, lap + sector readout, and a live tire grid. Landscape tablet-friendly.",
  },
  {
    slug: "combo-2",
    href: "/dash/combo-2",
    title: "Combo Dash 2 — Lap Times & Pace",
    description:
      "Lap timing summary across the top, big lap-time trend chart with optimum and average pace lines, plus live sector splits and recent laps on the side.",
  },
];

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
      return (
        <ComboDash
          rawPacket={PREVIEW_RAW_PACKET}
          packet={fakeForzaDisplayPacket}
          sectors={fakeSectors}
          pit={fakePit}
          unitSystem="metric"
          toTempC={fToC}
        />
      );
    }
    return (
      <ComboDash2
        rawPacket={PREVIEW_RAW_PACKET}
        allLaps={PREVIEW_LAPS}
        sessionLaps={PREVIEW_LAPS}
      />
    );
  };

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-black tracking-tight">Dashboards</h1>
          <p className="mt-2 text-white/60 text-sm">
            Single-purpose dashboards designed for a phone or tablet in the cockpit. Scan the QR
            code on the device to open it over your LAN.
          </p>
          {lanIp && port ? (
            <p className="mt-2 text-xs text-white/40 font-mono">
              serving at http://{lanIp}:{port}
            </p>
          ) : (
            <p className="mt-2 text-xs text-red-400/70 font-mono">
              LAN IP unavailable — device must be on the same Wi-Fi as this PC.
            </p>
          )}
        </div>

        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {DASH_META.map((d) => {
            const url = lanIp && port ? `http://${lanIp}:${port}${d.href}` : null;
            return (
              <li
                key={d.slug}
                className="rounded-lg border border-white/10 bg-white/[0.03] overflow-hidden"
              >
                <Link to={d.href} className="block group">
                  <div
                    className="relative bg-black border-b border-white/10 overflow-hidden mx-auto"
                    style={{
                      aspectRatio: previewAspect,
                      width: previewWidth,
                      transform: "translateZ(0)",
                    }}
                  >
                    <div className="absolute inset-0 pointer-events-none">{previewFor(d.slug)}</div>
                    <div className="absolute inset-0 transition-colors group-hover:bg-white/[0.04]" />
                  </div>
                </Link>
                <div className="p-5 flex gap-4 items-start">
                  <div className="flex-1 min-w-0">
                    <Link to={d.href}>
                      <div className="text-lg font-bold mb-1 hover:text-app-accent">{d.title}</div>
                    </Link>
                    <div className="text-sm text-white/60 leading-relaxed">{d.description}</div>
                    <div className="mt-3 text-xs font-mono tracking-wider text-white/40 break-all">
                      {url ?? d.href}
                    </div>
                  </div>
                  {url && (
                    <div className="shrink-0 rounded bg-white p-2 hidden lg:block">
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
