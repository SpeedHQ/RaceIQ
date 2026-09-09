import type { LapMeta } from "@shared/racing/sessions/types";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatLapTime } from "@/lib/format";

type Selection = { lapIds: number[]; primaryLapId: number };
type SortMode = "lapTime" | `sector:${number}`;

export interface SessionLapSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  laps: readonly LapMeta[];
  selectedLapIds: readonly number[];
  primaryLapId: number;
  onApply: (selection: Selection) => void;
}

export function SessionLapSelectionDialog({ open, onOpenChange, laps, selectedLapIds, primaryLapId, onApply }: SessionLapSelectionDialogProps) {
  const [draftIds, setDraftIds] = useState<number[]>([...selectedLapIds]);
  const [draftPrimary, setDraftPrimary] = useState(primaryLapId);
  const [filter, setFilter] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("lapTime");
  const [sortDescending, setSortDescending] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraftIds([...selectedLapIds]);
    setDraftPrimary(primaryLapId);
    setSortDescending(false);
    setSortMode("lapTime");
  }, [open, primaryLapId, selectedLapIds]);
  const sectorCount = Math.max(0, ...laps.map((lap) => lap.sectorTimes?.length ?? 0));
  const bestLapTime = Math.min(...laps.map((lap) => lap.lapTime).filter((time) => time > 0));
  const bestSectorTimes = Array.from({ length: sectorCount }, (_, index) => Math.min(...laps.map((lap) => lap.sectorTimes?.[index] ?? 0).filter((time) => time > 0)));
  const visibleLaps = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const filtered = laps.filter((lap) => !query || `lap ${lap.lapNumber} ${lap.invalidReason ?? ""} ${lap.isValid ? "valid" : "invalid"}`.toLowerCase().includes(query));
    return [...filtered].sort((a, b) => {
      const aValue = sortMode === "lapTime" ? a.lapTime : a.sectorTimes?.[Number(sortMode.slice(7))] ?? Number.POSITIVE_INFINITY;
      const bValue = sortMode === "lapTime" ? b.lapTime : b.sectorTimes?.[Number(sortMode.slice(7))] ?? Number.POSITIVE_INFINITY;
      return (aValue - bValue) * (sortDescending ? -1 : 1) || a.lapNumber - b.lapNumber;
    });
  }, [filter, laps, sortDescending, sortMode]);
  const gridTemplateColumns = `2rem 4rem 6rem 8rem 4rem repeat(${sectorCount}, minmax(4.5rem, 1fr))`;
  const chooseSort = (next: SortMode) => {
    setSortDescending(sortMode === next ? !sortDescending : false);
    setSortMode(next);
  };
  const toggleLap = (id: number, checked: boolean) => {
    setDraftIds((current) => checked ? (current.includes(id) ? current : [...current, id]) : current.filter((candidate) => candidate !== id));
    if (!checked && draftPrimary === id) setDraftPrimary(draftIds.find((candidate) => candidate !== id) ?? 0);
  };
  const canApply = draftIds.length > 0 && draftIds.length <= 5 && draftIds.includes(draftPrimary);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" showCloseButton={false} overlayClassName="bg-app-bg/60" className="@container/session-lap max-h-[85vh] max-w-[1100px] gap-0 overflow-hidden bg-app-bg p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-0 border-b border-app-border px-4 py-2.5">
          <div className="min-w-0"><DialogTitle className="text-sm font-semibold text-app-text">Choose laps to display</DialogTitle><DialogDescription className="mt-1 text-xs text-app-text-muted">Select 1–5 laps and choose one primary lap.</DialogDescription></div>
          <Button variant="close-action" size="icon-sm" onClick={() => onOpenChange(false)} className="ml-3 shrink-0" aria-label="Close"><X className="size-4" /></Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <label className="mb-3 block max-w-sm"><span className="sr-only">Search laps</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search laps…" className="h-8 w-full rounded border border-app-border bg-app-surface px-2 text-sm text-app-text outline-none focus:border-app-accent" /></label>
          <fieldset><legend className="sr-only">Session laps</legend>
            <div className="overflow-x-auto rounded border border-app-border">
              <div className="grid min-w-max gap-x-2 border-b border-app-border px-3 py-1 text-xs uppercase tracking-wider text-app-text-dim" style={{ gridTemplateColumns }}>
                <div /><div className="text-center">Primary</div><button type="button" className="text-right hover:text-app-text" onClick={() => chooseSort("lapTime")}>Time {sortMode === "lapTime" ? (sortDescending ? "↓" : "↑") : ""}</button><div>Status</div><div>Lap</div>
                {Array.from({ length: sectorCount }, (_, index) => <button type="button" key={index} className="text-right hover:text-app-text" onClick={() => chooseSort(`sector:${index}`)}>S{index + 1} {sortMode === `sector:${index}` ? (sortDescending ? "↓" : "↑") : ""}</button>)}
              </div>
              <div className="divide-y divide-app-border/30">
                {visibleLaps.map((lap) => {
                  const selected = draftIds.includes(lap.id);
                  return <div key={lap.id} className="grid min-w-max items-center gap-x-2 px-3 py-1.5 hover:bg-app-surface-hover/20" style={{ gridTemplateColumns }}>
                    <input type="checkbox" aria-label={`Display Lap ${lap.lapNumber}`} checked={selected} onChange={(event) => toggleLap(lap.id, event.target.checked)} />
                    <label className="flex justify-center"><input type="radio" name="session-primary-lap" aria-label={`Primary Lap ${lap.lapNumber}`} checked={draftPrimary === lap.id} disabled={!selected} onChange={() => setDraftPrimary(lap.id)} /></label>
                    <span className={`text-right font-mono text-sm font-bold tabular-nums ${lap.lapTime === bestLapTime ? "text-(--lap-pace-best)" : "text-app-text"}`}>{formatLapTime(lap.lapTime)}</span>
                    <span><Badge variant={lap.isValid ? "success" : "danger"} size="compact">{lap.isValid ? "Valid" : "Invalid"}</Badge>{lap.experimentExcluded && <Badge variant="warning" size="compact" className="ml-1">Excluded</Badge>}</span>
                    <span className={`font-mono text-xs ${lap.isValid ? "text-app-text-muted" : "text-status-danger"}`}>{lap.lapNumber}</span>
                    {Array.from({ length: sectorCount }, (_, index) => { const time = lap.sectorTimes?.[index] ?? 0; const isBest = time > 0 && time === bestSectorTimes[index]; return <span key={index} className={`text-right font-mono text-sm tabular-nums ${isBest ? "text-(--lap-pace-best)" : "text-app-text-muted"}`}>{time > 0 ? formatLapTime(time) : "—"}</span>; })}
                  </div>;
                })}
              </div>
            </div>
          </fieldset>
          {visibleLaps.length === 0 && <p className="py-6 text-center text-sm text-app-text-muted">No laps match search.</p>}
          {draftIds.length > 5 && <p role="alert" className="mt-3 text-sm text-status-danger">Choose no more than five laps.</p>}{draftIds.length === 0 && <p role="alert" className="mt-3 text-sm text-status-danger">Choose at least one lap.</p>}{draftIds.length > 0 && !draftIds.includes(draftPrimary) && <p role="alert" className="mt-3 text-sm text-status-danger">Choose a primary lap from displayed laps.</p>}
        </div>
        <DialogFooter className="shrink-0 flex-row justify-end border-0 bg-transparent px-4 py-3 -mx-0 -mb-0"><Button variant="app-outline" size="app-sm" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="app-primary" size="app-sm" disabled={!canApply} onClick={() => { onApply({ lapIds: draftIds, primaryLapId: draftPrimary }); onOpenChange(false); }}>Apply</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
