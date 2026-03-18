import { useWebSocket } from "./hooks/useWebSocket";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { LiveTelemetry } from "./components/LiveTelemetry";
import { LapList } from "./components/LapList";

export default function App() {
  const { connected, packet, packetsPerSec } = useWebSocket();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <ConnectionStatus connected={connected} packetsPerSec={packetsPerSec} />

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
    </div>
  );
}
