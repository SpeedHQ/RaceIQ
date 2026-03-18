import { useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { LiveTelemetry } from "./components/LiveTelemetry";
import { LapList } from "./components/LapList";
import { LapComparison } from "./components/LapComparison";
import { Settings } from "./components/Settings";
import { Button } from "@/components/ui/button";

type Tab = "live" | "compare";

export default function App() {
  const { connected, packet, packetsPerSec } = useWebSocket();
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("live");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <div className="flex items-center justify-between border-b border-slate-800">
        <div className="flex items-center">
          <ConnectionStatus connected={connected} packetsPerSec={packetsPerSec} forzaReceiving={packetsPerSec > 0} />

          {/* Tab Navigation */}
          <div className="flex items-center gap-0 ml-4">
            <button
              onClick={() => setActiveTab("live")}
              className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors ${
                activeTab === "live"
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              Live
            </button>
            <button
              onClick={() => setActiveTab("compare")}
              className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-colors ${
                activeTab === "compare"
                  ? "border-cyan-400 text-cyan-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              Compare
            </button>
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

      {activeTab === "live" ? (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-0">
          {/* Left: Live Telemetry */}
          <div className="border-r border-slate-800 overflow-auto">
            <div className="p-2 border-b border-slate-800">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Live Telemetry
              </h2>
            </div>
            <LiveTelemetry packet={packet} />
          </div>

          {/* Right: Lap List */}
          <div className="overflow-auto">
            <div className="p-2 border-b border-slate-800">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Recorded Laps
              </h2>
            </div>
            <LapList />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <LapComparison />
        </div>
      )}
    </div>
  );
}
