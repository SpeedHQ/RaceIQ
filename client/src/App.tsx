import { useState, useEffect, useRef } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { LiveTelemetry } from "./components/LiveTelemetry";
import { CurrentLapStats } from "./components/CurrentLapStats";
import { LiveTrackMap } from "./components/LiveTrackMap";
import { LapList } from "./components/LapList";
import { LapComparison } from "./components/LapComparison";
import { RawTelemetry } from "./components/RawTelemetry";
import { TrackViewer } from "./components/TrackViewer";
import { Settings } from "./components/Settings";
import { Button } from "@/components/ui/button";

type Tab = "live" | "compare" | "tracks" | "raw";

const TABS: { id: Tab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "compare", label: "Compare" },
  { id: "tracks", label: "Tracks" },
  { id: "raw", label: "Raw" },
];

export default function App() {
  const { connected, packet, packetsPerSec } = useWebSocket();
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [trackName, setTrackName] = useState("");
  const lastTrackFetchRef = useRef<number | null>(null);

  useEffect(() => {
    if (!packet) return;
    // Fetch track name from session — only refetch when lap changes
    fetch("/api/status")
      .then((r) => r.json())
      .then((status) => {
        const trackOrd = status.currentSession?.trackOrdinal;
        if (trackOrd == null || trackOrd === lastTrackFetchRef.current) return;
        lastTrackFetchRef.current = trackOrd;
        return fetch(`/api/track-name/${trackOrd}`);
      })
      .then((r) => r?.text())
      .then((name) => { if (name) setTrackName(name); })
      .catch(() => {});
  }, [packet?.LapNumber]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <div className="flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center">
          <ConnectionStatus connected={connected} packetsPerSec={packetsPerSec} forzaReceiving={packetsPerSec > 0} />

          <div className="flex items-center gap-0 ml-4">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-cyan-400 text-cyan-400"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSettings(!showSettings)}
          className="mr-2 text-slate-400 hover:text-white"
        >
          {showSettings ? "Close" : "Settings"}
        </Button>
      </div>

      {showSettings && (
        <div className="p-4 border-b border-slate-800 bg-slate-950">
          <div className="max-w-md">
            <Settings />
          </div>
        </div>
      )}

      {activeTab === "live" && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0">
          <div className="border-r border-slate-800 overflow-auto">
            <div className="p-2 border-b border-slate-800">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Live Telemetry
              </h2>
            </div>
            <LiveTelemetry packet={packet} />
          </div>
          <div className="overflow-auto flex flex-col">
            {/* Live Track Map + Current Lap Stats */}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] border-b border-slate-800">
              <div className="border-r border-slate-800 bg-slate-950" style={{ minHeight: 220 }}>
                <div className="p-2 border-b border-slate-800 flex items-center justify-between">
                  <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Track Map
                  </h2>
                  {trackName && (
                    <span className="text-xs text-slate-400 truncate ml-2">{trackName}</span>
                  )}
                </div>
                <LiveTrackMap packet={packet} />
              </div>
              <div>
                <div className="p-2 border-b border-slate-800">
                  <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Current Lap
                  </h2>
                </div>
                <CurrentLapStats packet={packet} />
              </div>
            </div>

            {/* Recorded Laps */}
            <div className="flex-1">
              <div className="p-2 border-b border-slate-800">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Recorded Laps
                </h2>
              </div>
              <LapList />
            </div>
          </div>
        </div>
      )}

      {activeTab === "compare" && (
        <div className="flex-1 overflow-hidden">
          <LapComparison />
        </div>
      )}

      {activeTab === "tracks" && (
        <div className="flex-1 overflow-auto">
          <TrackViewer />
        </div>
      )}

      {activeTab === "raw" && (
        <div className="flex-1 overflow-hidden">
          <RawTelemetry packet={packet} />
        </div>
      )}
    </div>
  );
}
