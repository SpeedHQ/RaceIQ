import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { Point, TrackInfo, TrackSectors } from "../types";

type Pan = { x: number; z: number };
type DragState = { startX: number; startY: number; startPanX: number; startPanZ: number };
interface TrackCanvasPanelProps {
  track: TrackInfo;
  outline: Point[] | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  dragging: MutableRefObject<DragState | null>;
  pan: Pan;
  setPan: Dispatch<SetStateAction<Pan>>;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  sectorStarts: number[] | null;
  displaySectors: TrackSectors | null;
  mapDisplayMode: "segments" | "sectors";
  setMapDisplayMode: Dispatch<SetStateAction<"segments" | "sectors">>;
  corners: TrackSectors["segments"];
  straights: TrackSectors["segments"];
}

export function TrackCanvasPanel(props: TrackCanvasPanelProps) {
  const { track, outline, canvasRef, dragging, pan, setPan, zoom, setZoom, sectorStarts, displaySectors, mapDisplayMode, setMapDisplayMode, corners, straights } = props;
  return (
    <div className="relative order-1 h-[260px] min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg @3xl/workspace:order-2 @3xl/workspace:h-auto">
      {outline ? (
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseDown={(e) => {
            dragging.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanZ: pan.z };
          }}
          onMouseMove={(e) => {
            if (!dragging.current) return;
            const dx = e.clientX - dragging.current.startX;
            const dy = e.clientY - dragging.current.startY;
            setPan({ x: dragging.current.startPanX + dx, z: dragging.current.startPanZ + dy });
          }}
          onMouseUp={() => {
            dragging.current = null;
          }}
          onMouseLeave={() => {
            dragging.current = null;
          }}
        />
      ) : track.mapUrl ? (
        <img src={track.mapUrl} alt={`${track.name} ${track.variant} map`} className="w-full h-full object-contain p-5" />
      ) : (
        <div className="flex items-center justify-center h-full text-app-subtext text-app-text-dim">{m.trackdetail_no_outline_available()}</div>
      )}
      {outline && (
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          <Button
            type="button"
            onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
            className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
          >
            +
          </Button>
          <Button
            type="button"
            onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
            className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
          >
            -
          </Button>
          {zoom !== 1 && (
            <Button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, z: 0 });
              }}
              className="px-1.5 py-1 text-app-micro font-mono bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded"
            >
              {zoom % 1 === 0 ? `${zoom}x` : `${zoom.toFixed(2)}x`}
            </Button>
          )}
          {(sectorStarts || displaySectors) && (
            <>
              <div className="h-px" />
              <Button
                type="button"
                onClick={() => setMapDisplayMode((m) => (m === "segments" ? "sectors" : "segments"))}
                className={`px-1.5 py-1 text-app-micro font-mono rounded border transition-colors ${
                  mapDisplayMode === "sectors" ? "map-sectors-active" : "bg-app-surface-alt/80 border-app-border-input text-app-text-secondary hover:text-app-text"
                }`}
                title={mapDisplayMode === "sectors" ? m.track_detail_show_segments() : m.track_detail_show_sectors()}
              >
                {mapDisplayMode === "sectors" ? m.overlay_sectors() : m.overlay_segments()}
              </Button>
            </>
          )}
        </div>
      )}
      {/* Track info overlay — bottom left */}
      <div className="absolute bottom-2 left-2 flex items-center gap-2.5 text-app-caption font-mono text-app-text-dim bg-app-surface/70 backdrop-blur-sm rounded px-2 py-1 pointer-events-none">
        {track.lengthKm > 0 && <span>{track.lengthKm} km</span>}
        {corners.length > 0 && (
          <>
            <span className="text-app-text-dim/40">·</span>
            <span>{corners.length} corners</span>
          </>
        )}
        {straights.length > 0 && (
          <>
            <span className="text-app-text-dim/40">·</span>
            <span>{straights.length} straights</span>
          </>
        )}
        {track.createdAt && (
          <>
            <span className="text-app-text-dim/40">·</span>
            <span>{new Date(track.createdAt).toLocaleDateString()}</span>
          </>
        )}
      </div>
    </div>
  );
}
