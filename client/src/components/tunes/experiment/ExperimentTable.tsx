import { EXPERIMENT_FOCUS_LABELS, type ExperimentFocus } from "@shared/racing/experiments/focus";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";

function FocusBadge({ focus }: { focus: ExperimentFocus }) {
  return (
    <Badge
      variant="neutral"
      size="default"
      className={`whitespace-nowrap ${focus === "driver" ? "border-(--focus-driver)/30 bg-(--focus-driver)/15 text-(--focus-driver)" : "border-(--focus-setup)/30 bg-(--focus-setup)/15 text-(--focus-setup)"}`}
    >
      {EXPERIMENT_FOCUS_LABELS[focus]}
    </Badge>
  );
}

import { SortableTH, Table, TBody, TD, THead, TRow } from "@/components/ui/AppTable";
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
          result = compareText(EXPERIMENT_FOCUS_LABELS[left.focus], EXPERIMENT_FOCUS_LABELS[right.focus]);
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
          result = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
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
      <Table fit layout="auto">
        <THead>
          <SortableTH align="start" showFrom="workspace-sm" direction={direction("seq")} onSort={() => toggleSort("seq")}>
            #
          </SortableTH>
          <SortableTH direction={direction("name")} onSort={() => toggleSort("name")}>
            Session
          </SortableTH>
          <SortableTH showFrom="workspace-md" direction={direction("focus")} onSort={() => toggleSort("focus")}>
            Focus
          </SortableTH>
          <SortableTH showFrom="workspace-md" direction={direction("car")} onSort={() => toggleSort("car")}>
            Car
          </SortableTH>
          <SortableTH showFrom="workspace-lg" direction={direction("track")} onSort={() => toggleSort("track")}>
            Track
          </SortableTH>
          <SortableTH showFrom="workspace-lg" direction={direction("baseSetup")} onSort={() => toggleSort("baseSetup")}>
            Base setup
          </SortableTH>
          <SortableTH showFrom="workspace-xl" direction={direction("updatedAt")} onSort={() => toggleSort("updatedAt")}>
            Last active
          </SortableTH>
        </THead>
        <TBody>
          {isError && (
            <TRow variant="separator">
              <TD align="center" colSpan={7} tone="dim">
                <div role="alert" className="py-4 text-status-danger">
                  Could not load experiments. Try again.
                </div>
              </TD>
            </TRow>
          )}
          {!isError && sessions.length === 0 && (
            <TRow variant="separator">
              <TD align="center" colSpan={7} tone="dim">
                <div className="py-4">{isLoading ? "Loading experiments…" : "No experiments yet. Create one above to get started."}</div>
              </TD>
            </TRow>
          )}
          {sortedSessions.map((s) => {
            const base = s.baseSetupPath?.split(/[\\/]/).pop() ?? "—";
            return (
              <TRow key={s.id} onClick={() => onOpen(s.id)}>
                <TD align="start" showFrom="workspace-sm" numeric tone="dim">
                  {s.seq}
                </TD>
                <TD emphasis tone="primary" truncate="wide">
                  {s.name}
                </TD>
                <TD showFrom="workspace-md">
                  <FocusBadge focus={s.focus} />
                </TD>
                <TD showFrom="workspace-md" tone="dim">
                  {carName(s.carName)}
                </TD>
                <TD showFrom="workspace-lg" tone="dim">
                  {s.trackName ?? "—"}
                </TD>
                <TD showFrom="workspace-lg" numeric tone="dim" truncate="wide" title={s.baseSetupPath ?? undefined}>
                  {base}
                </TD>
                <TD showFrom="workspace-xl" nowrap tone="dim">
                  {new Date(s.updatedAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
