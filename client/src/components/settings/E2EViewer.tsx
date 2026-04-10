import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";

interface E2EFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

interface PacketMetadata {
  packetCount: number;
  packets: Array<{ x: number; y: number; speed: number; throttle: number; brake: number }>;
}

interface Lap {
  lapNumber: number;
  lapTime: number;
  startPacketIndex: number;
  endPacketIndex: number;
  isValid: boolean;
}

function generateTrackSVG(
  packets: Array<{ x: number; y: number }>,
  allPackets: Array<{ x: number; y: number }>,
  currentPacket?: { x: number; y: number },
  boundPackets?: Array<{ x: number; y: number }> // Use these packets for bounds calculation
): string {
  if (packets.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="10" y="30" fill="#999">No packets</text></svg>';
  }

  // Calculate bounds from specified packets (or all packets if not provided)
  const boundsSource = boundPackets || allPackets;
  let minX = boundsSource[0].x;
  let maxX = minX;
  let minY = boundsSource[0].y;
  let maxY = minY;

  for (const p of boundsSource) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const margin = 40;
  const width = 800;
  const height = 600;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scaleX = (width - 2 * margin) / rangeX;
  const scaleY = (height - 2 * margin) / rangeY;
  const scale = Math.min(scaleX, scaleY);

  // Build path with packets up to current index
  let pathData = "";
  for (let i = 0; i < packets.length; i++) {
    const x = margin + (packets[i].x - minX) * scale;
    const y = margin + (packets[i].y - minY) * scale;
    pathData += `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }

  const startX = margin + (packets[0].x - minX) * scale;
  const startY = margin + (packets[0].y - minY) * scale;
  const currentX = currentPacket ? margin + (currentPacket.x - minX) * scale : startX;
  const currentY = currentPacket ? margin + (currentPacket.y - minY) * scale : startY;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: 100%; max-width: 100%; max-height: 100%;">
  <style>
    .track { stroke: #4a90e2; stroke-width: 2; fill: none; }
    .start { fill: #4a90e2; }
    .current { fill: #e24a4a; }
  </style>
  <rect width="800" height="600" fill="#1a1a1a"/>
  <path class="track" d="${pathData}"/>
  <circle cx="${startX}" cy="${startY}" r="5" class="start" opacity="0.6"/>
  <circle cx="${currentX}" cy="${currentY}" r="4" class="current" opacity="0.9"/>
</svg>`;
}

export function E2EViewer() {
  const [files, setFiles] = useState<E2EFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [svgContent, setSvgContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [packetIndex, setPacketIndex] = useState(0);
  const [metadata, setMetadata] = useState<PacketMetadata | null>(null);
  const [laps, setLaps] = useState<Lap[]>([]);
  const [selectedLap, setSelectedLap] = useState<Lap | null>(null);
  const [speed, setSpeed] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Sort files by modification time (newest first)
  const sortedFiles = [...files].sort((a, b) => b.modified - a.modified);

  // Fetch available E2E files
  useEffect(() => {
    const fetchFiles = async () => {
      try {
        const res = await fetch("/api/dev/e2e-files");
        const data = await res.json();
        setFiles(data.files || []);
      } catch (e) {
        console.error("Failed to fetch E2E files:", e);
      }
    };

    fetchFiles();
  }, []);

  // Load selected file, packets, and detect laps
  const handleSelectFile = async (filename: string) => {
    setSelectedFile(filename);
    setLoading(true);
    setMetadata(null);
    setLaps([]);
    setSelectedLap(null);

    try {
      // Load packets
      const packetsRes = await fetch(
        `/api/dev/e2e-packets/${encodeURIComponent(filename)}`
      );
      const packetsData = await packetsRes.json();
      setMetadata(packetsData);

      // Load detected laps
      const lapsRes = await fetch(
        `/api/dev/e2e-laps/${encodeURIComponent(filename)}`
      );
      const lapsData = await lapsRes.json();
      setLaps(lapsData.laps || []);

      // Show all packets on load (packetIndex = 0 means all)
      if (packetsData.packets && packetsData.packets.length > 0) {
        const allPackets = packetsData.packets;
        const svg = generateTrackSVG(allPackets, allPackets, undefined, undefined);
        setSvgContent(svg);
        setPacketIndex(0);
        setSpeed(0);
        setPosition({ x: 0, y: 0 });
      }
    } catch (e) {
      console.error("Failed to load recording:", e);
      setSvgContent("");
      setMetadata(null);
      setLaps([]);
      setSelectedLap(null);
      setPacketIndex(0);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectLap = (lap: Lap) => {
    setSelectedLap(lap);
    setPacketIndex(0); // Show all packets in the lap
  };

  // Find which lap the current packet belongs to (for raw view)
  const getCurrentLapInRawView = (): Lap | null => {
    if (selectedLap || !metadata) return null;

    let displayIndex: number;
    if (packetIndex === 0) {
      displayIndex = metadata.packets.length - 1;
    } else {
      displayIndex = packetIndex - 1;
    }

    return laps.find(lap => displayIndex >= lap.startPacketIndex && displayIndex <= lap.endPacketIndex) || null;
  };

  // Update speed/position and regenerate SVG when packet index changes
  useEffect(() => {
    if (!metadata || metadata.packets.length === 0) {
      setSpeed(0);
      setPosition({ x: 0, y: 0 });
      return;
    }

    // Calculate effective packet index
    // packetIndex 0 = all packets, 1+ = up to that packet index
    let displayIndex: number;

    if (selectedLap) {
      // When lap is selected, packetIndex is relative to lap start
      if (packetIndex === 0) {
        displayIndex = selectedLap.endPacketIndex; // Show all lap packets
      } else {
        displayIndex = Math.min(
          selectedLap.startPacketIndex + packetIndex - 1,
          selectedLap.endPacketIndex
        );
      }
    } else {
      // Full recording mode
      displayIndex = packetIndex === 0 ? metadata.packets.length - 1 : packetIndex - 1;
    }

    const packet = metadata.packets[displayIndex];
    if (packet) {
      setSpeed(packet.speed);
      setPosition({ x: packet.x, y: packet.y });
    }

    if (selectedLap) {
      // Lap view: only show packets within this lap
      const lapPackets = metadata.packets.slice(selectedLap.startPacketIndex, selectedLap.endPacketIndex + 1);
      const visiblePackets = packetIndex === 0
        ? lapPackets
        : lapPackets.slice(0, displayIndex - selectedLap.startPacketIndex + 1);
      // For lap view, both allPackets and boundPackets are the lap packets only
      const dynamicSvg = generateTrackSVG(visiblePackets, lapPackets, packet, lapPackets);
      setSvgContent(dynamicSvg);
    } else {
      // Raw view: show all packets
      const visiblePackets = packetIndex === 0
        ? metadata.packets
        : metadata.packets.slice(0, displayIndex + 1);
      // For raw view, show all packets with no specific bounds constraint
      const dynamicSvg = generateTrackSVG(visiblePackets, metadata.packets, packet, undefined);
      setSvgContent(dynamicSvg);
    }
  }, [packetIndex, metadata, selectedLap]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="pb-4 border-b border-app-border mb-4">
        <h3 className="text-lg font-semibold text-app-text">E2E Test Viewer</h3>
        <p className="text-sm text-app-text-muted mt-1">
          View test recordings with packet scrubber for debugging
        </p>
      </div>

      {/* Left/Right split */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: File list */}
        <div className="w-64 shrink-0 flex flex-col">
          <Label className="text-sm font-medium mb-2">Recordings ({sortedFiles.length})</Label>
          <div className="space-y-1 flex-1 overflow-y-auto border border-app-border rounded p-2 bg-app-surface-alt">
            {sortedFiles.length === 0 ? (
              <p className="text-sm text-app-text-muted p-2">No recordings found</p>
            ) : (
              sortedFiles.map((file) => (
                <button
                  key={file.name}
                  onClick={() => handleSelectFile(file.name)}
                  className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${
                    selectedFile === file.name
                      ? "bg-app-accent text-app-surface"
                      : "bg-app-surface text-app-text hover:bg-app-surface-alt"
                  }`}
                >
                  <div className="font-mono truncate">{file.name}</div>
                  <div className="text-app-text-muted text-xs">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: Viewer and controls */}
        {selectedFile ? (
          <div className="flex-1 flex flex-col min-w-0">
            {/* SVG display */}
            <div className="flex-1 border border-app-border rounded bg-app-surface-alt p-4 overflow-hidden mb-4 flex flex-col min-h-0">
              {loading ? (
                <div className="h-full flex items-center justify-center text-app-text-muted">
                  Loading...
                </div>
              ) : svgContent ? (
                <>
                  {selectedLap && (
                    <div className="text-xs text-app-text-muted mb-2 pb-2 border-b border-app-border shrink-0">
                      Lap {selectedLap.lapNumber} • {selectedLap.lapTime.toFixed(2)}s
                    </div>
                  )}
                  {!selectedLap && laps.length > 0 && (
                    <div className="text-xs text-app-text-muted mb-2 pb-2 border-b border-app-border shrink-0">
                      Raw recording
                    </div>
                  )}
                  <div
                    className="flex-1 flex items-center justify-center w-full min-h-0 overflow-hidden"
                    dangerouslySetInnerHTML={{ __html: svgContent }}
                  />
                </>
              ) : (
                <div className="h-full flex items-center justify-center text-app-text-muted">
                  No SVG loaded
                </div>
              )}
            </div>

            {/* Packet scrubber and info */}
            <div className="space-y-3">
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Packet: <span className="text-app-accent font-mono">{packetIndex === 0 ? "all" : packetIndex}</span>
                  {metadata && (
                    <span className="text-app-text-muted ml-2">
                      / {selectedLap ? (selectedLap.endPacketIndex - selectedLap.startPacketIndex + 1) : (metadata.packetCount)}
                    </span>
                  )}
                </Label>
                <input
                  type="range"
                  min="0"
                  max={selectedLap ? (selectedLap.endPacketIndex - selectedLap.startPacketIndex + 1) : (metadata?.packetCount ?? 3000)}
                  value={packetIndex}
                  onChange={(e) => setPacketIndex(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex gap-4 text-xs text-app-text-muted flex-wrap">
                  <span>Speed: <span className="text-app-text">{speed.toFixed(1)}</span></span>
                  <span>Position: <span className="text-app-text">({position.x.toFixed(0)}, {position.y.toFixed(0)})</span></span>
                  {selectedLap && (
                    <>
                      <span>Lap: <span className="text-app-text">{selectedLap.lapNumber}</span></span>
                      <span>Elapsed: <span className="text-app-text">{selectedLap.lapTime > 0 ? ((packetIndex / (selectedLap.endPacketIndex - selectedLap.startPacketIndex + 1)) * selectedLap.lapTime).toFixed(2) : "0.00"}s</span></span>
                      <span>Total: <span className="text-app-text">{selectedLap.lapTime.toFixed(2)}s</span></span>
                    </>
                  )}
                  {!selectedLap && getCurrentLapInRawView() && (
                    <>
                      <span>Lap: <span className="text-app-text">{getCurrentLapInRawView()?.lapNumber}</span></span>
                      <span>Lap Time: <span className="text-app-text">{(getCurrentLapInRawView()?.lapTime ?? 0).toFixed(2)}s</span></span>
                    </>
                  )}
                </div>
              </div>

              {/* Lap buttons */}
              {laps.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-sm font-medium">Laps ({laps.length})</Label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setSelectedLap(null)}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                        selectedLap === null
                          ? "bg-app-accent text-app-surface"
                          : "bg-app-surface text-app-text hover:bg-app-surface-alt border border-app-border"
                      }`}
                    >
                      Raw
                    </button>
                    {laps.map((lap) => (
                      <button
                        key={lap.lapNumber}
                        onClick={() => handleSelectLap(lap)}
                        className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                          selectedLap?.lapNumber === lap.lapNumber
                            ? "bg-app-accent text-app-surface"
                            : "bg-app-surface text-app-text hover:bg-app-surface-alt border border-app-border"
                        } ${!lap.isValid ? "opacity-60" : ""}`}
                        title={`Lap ${lap.lapNumber}: ${lap.lapTime.toFixed(2)}s`}
                      >
                        L{lap.lapNumber} {lap.lapTime > 0 && `${lap.lapTime.toFixed(1)}s`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs text-app-text-muted p-3 bg-app-surface-alt rounded border border-app-border">
                <p className="mb-1">
                  <span className="font-mono text-app-text text-xs">{selectedFile}</span>
                </p>
                <p>{metadata?.packetCount ?? 0} packets</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-app-text-muted">
            Select a recording to view
          </div>
        )}
      </div>
    </div>
  );
}
