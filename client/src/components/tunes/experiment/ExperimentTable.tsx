import { m } from "@/paraglide/messages";
import type { ExperimentFocus } from "@raceiq/shared/racing/experiments/focus";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { parseUtcTimestamp } from "@/lib/utc-date";

function FocusBadge({ focus }: { focus: ExperimentFocus }) {
  return (
    <Badge
      variant="neutral"
      size="default"
      className={`whitespace-nowrap ${focus === "driver" ? "border-(--focus-driver)/30 bg-(--focus-driver)/15 text-(--focus-driver)" : "border-(--focus-setup)/30 bg-(--focus-setup)/15 text-(--focus-setup)"}`}
    >
      {focus === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup()}
    </Badge>
  );
}

import { Table, TableBody as TBody, TableCell as TD, TableHeader as THead, TableRow as TRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useAccCarName } from "@/hooks/catalog-queries";
import type { Experiment, ExperimentGameId } from "@/hooks/experiments";

type ExperimentSortKey = "seq" | "name" | "focus" | "car" | "track" | "baseSetup" | "updatedAt";
type SortDirection = "ascending" | "descending";

function compareText(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}

export function ExperimentTable({
  sessions,
  onOpen,
  isLoading,
  isError,
  gameId,
}: {
  sessions: Experiment[];
  onOpen: (id: number) => void;
  isLoading: boolean;
  isError: boolean;
  gameId: ExperimentGameId;
}) {
  const accCarName = useAccCarName();
  const carName = (n: string | null | undefined) => (gameId === "acc" ? accCarName(n) : n) ?? "—";
  const [sortKey, setSortKey] = useState<ExperimentSortKey>("updatedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("descending");
  const direction = (key: ExperimentSortKey) => (sortKey === key ? sortDirection : undefined);
  const sortedSessions = useMemo(() => {
    const sorted = [...sessions].sort((left, right) => {
      let result = 0;
      switch (sortKey) {
        case "seq":
          result = left.seq - right.seq;
          break;
        case "name":
          result = compareText(left.name, right.name);
          break;
        case "focus":
          result = compareText(left.focus === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup(), right.focus === "driver" ? m.experiment_focus_driver() : m.experiment_focus_setup());
          break;
        case "car":
          result = compareText(carName(left.carName), carName(right.carName));
          break;
        case "track":
          result = compareText(left.trackName, right.trackName);
          break;
        case "baseSetup":
          result = compareText(left.baseSetupPath?.split(/[\\/]/).pop(), right.baseSetupPath?.split(/[\\/]/).pop());
          break;
        case "updatedAt":
          result = parseUtcTimestamp(left.updatedAt).getTime() - parseUtcTimestamp(right.updatedAt).getTime();
          break;
      }
      return (sortDirection === "ascending" ? result : -result) || left.seq - right.seq;
    });
    return sorted;
  }, [carName, sessions, sortDirection, sortKey]);

  const toggleSort = (key: ExperimentSortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === "ascending" ? "descending" : "ascending"));
      return;
    }
    setSortKey(key);
    setSortDirection(key === "updatedAt" ? "descending" : "ascending");
  };

  return (
    <div className="min-w-0 max-w-full overflow-x-auto">
      <Table className="w-full min-w-0 text-app-detail [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-surface [&_thead>tr]:border-b [&_thead>tr]:border-app-border [&_thead>tr]:text-app-label [&_thead>tr]:uppercase [&_thead>tr]:tracking-wider [&_thead>tr]:text-app-text-muted [&_tbody]:divide-y [&_tbody]:divide-app-border/40">
        <THead>
          <TRow className="border-b border-app-border">
          <SortableTableHead className="hidden @sm/workspace:table-cell px-2 py-1.5 text-left" direction={direction("seq")} onSort={() => toggleSort("seq")}>
            #
          </SortableTableHead>
          <SortableTableHead className="px-2 py-1.5 text-left" direction={direction("name")} onSort={() => toggleSort("name")}>
            Session
          </SortableTableHead>
          <SortableTableHead className="hidden @3xl/workspace:table-cell px-2 py-1.5 text-left" direction={direction("focus")} onSort={() => toggleSort("focus")}>
            Focus
          </SortableTableHead>
          <SortableTableHead className="hidden @3xl/workspace:table-cell px-2 py-1.5 text-left" direction={direction("car")} onSort={() => toggleSort("car")}>
            Car
          </SortableTableHead>
          <SortableTableHead className="hidden @5xl/workspace:table-cell px-2 py-1.5 text-left" direction={direction("track")} onSort={() => toggleSort("track")}>
            Track
          </SortableTableHead>
          <SortableTableHead className="hidden @5xl/workspace:table-cell px-2 py-1.5 text-left" direction={direction("baseSetup")} onSort={() => toggleSort("baseSetup")}>
            Base setup
          </SortableTableHead>
          <SortableTableHead className="hidden @7xl/workspace:table-cell px-2 py-1.5 text-left" direction={direction("updatedAt")} onSort={() => toggleSort("updatedAt")}>
            Last active
          </SortableTableHead>
          </TRow>
        </THead>
        <TBody>
          {isError && (
            <TRow className="text-app-label text-app-text-dim">
              <TD className="px-2 py-1.5 text-center" colSpan={7}>
                <div role="alert" className="py-4 text-status-danger">
                  Could not load experiments. Try again.
                </div>
              </TD>
            </TRow>
          )}
          {!isError && sessions.length === 0 && (
            <TRow className="text-app-label text-app-text-dim">
              <TD className="px-2 py-1.5 text-center" colSpan={7}>
                <div className="py-4">{isLoading ? "Loading experiments…" : "No experiments yet. Create one above to get started."}</div>
              </TD>
            </TRow>
          )}
          {sortedSessions.map((s) => {
            const base = s.baseSetupPath?.split(/[\\/]/).pop() ?? "—";
            return (
              <TRow key={s.id} onClick={() => onOpen(s.id)} className="group/row relative cursor-pointer transition-colors hover:bg-app-surface-hover/50">
                <TD className="hidden @sm/workspace:table-cell px-2 py-1.5 text-left font-mono tabular-nums text-app-text-dim">
                  {s.seq}
                </TD>
                <TD className="max-w-[200px] truncate px-2 py-1.5 font-semibold text-app-text">
                  {s.name}
                </TD>
                <TD className="hidden @3xl/workspace:table-cell px-2 py-1.5 text-app-text-secondary">
                  <FocusBadge focus={s.focus} />
                </TD>
                <TD className="hidden @3xl/workspace:table-cell px-2 py-1.5 text-app-text-dim">
                  {carName(s.carName)}
                </TD>
                <TD className="hidden @5xl/workspace:table-cell px-2 py-1.5 text-app-text-dim">
                  {s.trackName ?? "—"}
                </TD>
                <TD className="hidden @5xl/workspace:table-cell max-w-[200px] truncate px-2 py-1.5 font-mono tabular-nums text-app-text-dim" title={s.baseSetupPath ?? undefined}>
                  {base}
                </TD>
                <TD className="hidden @7xl/workspace:table-cell whitespace-nowrap px-2 py-1.5 text-app-text-dim">
                  {parseUtcTimestamp(s.updatedAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
