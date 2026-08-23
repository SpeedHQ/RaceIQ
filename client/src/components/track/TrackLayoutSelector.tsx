import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import type { TrackInfo } from "./types";

export function TrackLayoutSelector({ layouts, selectedOrdinal, onSelect }: { layouts: TrackInfo[]; selectedOrdinal: number; onSelect: (track: TrackInfo) => void }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="track-layouts-heading">
      <div id="track-layouts-heading" className="text-app-label text-app-text-muted">
        {m.track_layouts_heading()} ({layouts.length})
      </div>
      <div className="grid grid-cols-1 gap-2 @3xl/workspace:grid-cols-2">
        {layouts.map((layout) => {
          const selected = layout.ordinal === selectedOrdinal;
          return (
            <Button key={layout.ordinal} variant={selected ? "focus-option-selected" : "focus-option"} size="content" aria-current={selected ? "page" : undefined} onClick={() => onSelect(layout)}>
              <span className="flex w-full items-center justify-between gap-2">
                <span className="truncate text-app-body font-medium">{layout.variant || layout.name}</span>
                <span className="shrink-0 text-app-label text-app-text-muted">#{layout.ordinal}</span>
              </span>
              <span className="text-app-label text-app-text-muted">
                {layout.lengthKm > 0 ? `${layout.lengthKm} km · ` : ""}
                {layout.lapCount ?? 0} {(layout.lapCount ?? 0) === 1 ? m.trackcard_lap_singular() : m.pitwindow_laps()}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
