import { m } from "@/paraglide/messages";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatLapTime } from "@/lib/format";
import { evaluationReasonLabel, selectEvaluationLaps } from "@raceiq/shared/racing/laps/review-selection";

type Selection = { lapIds: number[]; primaryLapId: number };
type SortMode = "lapNumber" | "lapTime" | "status" | `sector:${number}`;

export interface SessionLapSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  laps: readonly LapMeta[];
  selectedLapIds: readonly number[];
  primaryLapId: number;
  onApply: (selection: Selection) => void;
}

export function SessionLapSelectionDialog({ open, onOpenChange, laps, selectedLapIds, primaryLapId, onApply }: SessionLapSelectionDialogProps) {
  const orderedLaps = useMemo(() => [...laps].sort((a, b) => a.lapNumber - b.lapNumber), [laps]);
  const reasons = useMemo(() => selectEvaluationLaps([...laps]).reasonById, [laps]);
  const [draftIds, setDraftIds] = useState<number[]>([]);
  const [draftPrimary, setDraftPrimary] = useState(0);
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
  const bestSectorTimes = Array.from({ length: sectorCount }, (_, index) =>
    Math.min(...laps.map((lap) => lap.sectorTimes?.[index] ?? 0).filter((time) => time > 0)),
  );
  const visibleLaps = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const filtered = laps.filter((lap) =>
      !query || `lap ${lap.lapNumber} ${lap.invalidReason ?? ""} ${lap.isValid ? "valid" : "invalid"}`.toLowerCase().includes(query),
    );
    return [...filtered].sort((a, b) => {
      if (sortMode === "status") {
        const aStatus = evaluationReasonLabel(reasons.get(a.id) ?? "invalid");
        const bStatus = evaluationReasonLabel(reasons.get(b.id) ?? "invalid");
        return aStatus.localeCompare(bStatus) * (sortDescending ? -1 : 1) || a.lapNumber - b.lapNumber;
      }
      const aValue = sortMode === "lapTime" ? a.lapTime : sortMode === "lapNumber" ? a.lapNumber : a.sectorTimes?.[Number(sortMode.slice(7))] ?? Number.POSITIVE_INFINITY;
      const bValue = sortMode === "lapTime" ? b.lapTime : sortMode === "lapNumber" ? b.lapNumber : b.sectorTimes?.[Number(sortMode.slice(7))] ?? Number.POSITIVE_INFINITY;
      return (aValue - bValue) * (sortDescending ? -1 : 1) || a.lapNumber - b.lapNumber;
    });
  }, [filter, laps, reasons, sortDescending, sortMode]);
  const gridTemplateColumns = `2rem 4rem 6rem 8rem 4rem repeat(${sectorCount}, minmax(4.5rem, 1fr))`;
  const chooseSort = (next: SortMode) => {
    setSortDescending(sortMode === next ? !sortDescending : false);
    setSortMode(next);
  };
  const toggleLap = (id: number, checked: boolean) => {
    setDraftIds((current) => checked ? (current.includes(id) ? current : [...current, id]) : current.filter((candidate) => candidate !== id));
    if (!checked && draftPrimary === id) setDraftPrimary(0);
  };
  const canApply = draftIds.length > 0 && draftIds.length <= 5 && draftIds.includes(draftPrimary);
  const apply = () => {
    if (!canApply) return;
    onApply({ lapIds: orderedLaps.filter((lap) => draftIds.includes(lap.id)).map((lap) => lap.id), primaryLapId: draftPrimary });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" showCloseButton={false} overlayClassName="bg-app-bg/60" className="@container/session-lap max-h-[85vh] max-w-[1100px] gap-0 overflow-hidden bg-app-bg p-0">
        <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-0 border-b border-app-border px-4 py-2.5">
          <div className="min-w-0"><DialogTitle className="text-sm font-semibold text-app-text">{m.review_choose_laps_title()}</DialogTitle><DialogDescription className="mt-1 text-xs text-app-text-muted">{m.review_choose_laps_description()}</DialogDescription></div>
          <Button variant="close-action" size="icon-sm" onClick={() => onOpenChange(false)} className="ml-3 shrink-0" aria-label={m.review_close()}><X className="size-4" /></Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <label className="mb-3 block max-w-sm"><span className="sr-only">{m.review_search_laps()}</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={m.review_search_laps_placeholder()} className="h-8 w-full rounded border border-app-border bg-app-surface px-2 text-sm text-app-text outline-none focus:border-app-accent" /></label>
          <fieldset><legend className="sr-only">{m.review_session_laps()}</legend>
            <div className="max-h-[55vh] overflow-auto overscroll-contain rounded border border-app-border">
              <div className="sticky top-0 z-10 grid min-w-max gap-x-2 border-b border-app-border bg-app-bg px-3 py-1 text-xs tracking-wider text-app-text-dim" style={{ gridTemplateColumns }}>
                <div /><div className="text-center">{m.review_primary()}</div><button type="button" className="text-right hover:text-app-text" onClick={() => chooseSort("lapTime")}>{m.review_time()} {sortMode === "lapTime" ? (sortDescending ? "↓" : "↑") : ""}</button><button type="button" className="text-left hover:text-app-text" onClick={() => chooseSort("status")}>{m.review_status()} {sortMode === "status" ? (sortDescending ? "↓" : "↑") : ""}</button><button type="button" className="text-right hover:text-app-text" onClick={() => chooseSort("lapNumber")}>{m.review_lap()} {sortMode === "lapNumber" ? (sortDescending ? "↓" : "↑") : ""}</button>
                {Array.from({ length: sectorCount }, (_, index) => {
                  const sectorSort: SortMode = `sector:${index}`;
                  return <button key={index} type="button" className="text-right hover:text-app-text" onClick={() => chooseSort(sectorSort)}>S{index + 1} {sortMode === sectorSort ? (sortDescending ? "↓" : "↑") : ""}</button>;
                })}
              </div>
              <div className="divide-y divide-app-border/30">
                {visibleLaps.map((lap) => {
                  const selected = draftIds.includes(lap.id);
                  const reason = reasons.get(lap.id);
                  return <div key={lap.id} className="grid min-w-max items-center gap-x-2 px-3 py-1.5 hover:bg-app-surface-hover/20" style={{ gridTemplateColumns }}>
                    <input type="checkbox" aria-label={m.review_display_lap({ lap: lap.lapNumber })} checked={selected} disabled={!selected && draftIds.length >= 5} onChange={(event) => toggleLap(lap.id, event.target.checked)} />
                    <label className="flex justify-center"><input type="radio" name="session-primary-lap" aria-label={m.review_primary_lap({ lap: lap.lapNumber })} checked={draftPrimary === lap.id} disabled={!selected} onChange={() => setDraftPrimary(lap.id)} /></label>
                    <span className={`text-right font-mono text-sm font-bold tabular-nums ${lap.lapTime === bestLapTime ? "text-(--lap-pace-best)" : "text-app-text"}`}>{formatLapTime(lap.lapTime)}</span>
                    <span><Badge variant={reason === "chosen" ? "success" : reason === "invalid" ? "danger" : "warning"} size="compact">{reason ? evaluationReasonLabel(reason) : m.review_invalid_lap()}</Badge></span>
                    <span className={`font-mono text-xs ${lap.isValid ? "text-app-text-muted" : "text-status-danger"}`}>{lap.lapNumber}</span>
                    {Array.from({ length: sectorCount }, (_, index) => { const time = lap.sectorTimes?.[index] ?? 0; const isBest = time > 0 && time === bestSectorTimes[index]; return <span key={index} className={`text-right font-mono text-sm tabular-nums ${isBest ? "text-(--lap-pace-best)" : "text-app-text-muted"}`}>{time > 0 ? formatLapTime(time) : "—"}</span>; })}
                  </div>;
                })}
              </div>
            </div>
          </fieldset>
          {visibleLaps.length === 0 && <p className="py-6 text-center text-sm text-app-text-muted">{m.review_no_laps_match()}</p>}
          {draftIds.length > 5 && <p role="alert" className="mt-3 text-sm text-status-danger">{m.review_choose_max_five_laps()}</p>}
          {draftIds.length === 0 && <p role="alert" className="mt-3 text-sm text-status-danger">{m.review_choose_at_least_one_lap()}</p>}
          {draftIds.length > 0 && !draftIds.includes(draftPrimary) && <p role="alert" className="mt-3 text-sm text-status-danger">{m.review_choose_primary_displayed_lap()}</p>}
        </div>
        <DialogFooter className="shrink-0 flex-row justify-end border-0 bg-transparent px-4 py-3 -mx-0 -mb-0">
          <Button variant="app-outline" size="app-sm" onClick={() => onOpenChange(false)}>{m.review_cancel()}</Button>
          <Button variant="app-primary" size="app-sm" disabled={!canApply} onClick={apply}>{m.review_apply()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
