import { EXPERIMENT_FOCUS_LABELS, type ExperimentFocus } from "@shared/racing/experiments/focus";
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

import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Card } from "@/components/ui/card";
import { useAccCarName } from "@/hooks/catalog-queries";
import type { Experiment, ExperimentGameId } from "@/hooks/experiments";

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

  return (
    <Card className="min-w-0 max-w-full overflow-x-auto">
      <Table fit layout="fixed">
        <THead>
          <TH align="end" showFrom="workspace-sm">
            #
          </TH>
          <TH>Session</TH>
          <TH showFrom="workspace-md">Varying</TH>
          <TH showFrom="workspace-md">Car</TH>
          <TH showFrom="workspace-lg">Track</TH>
          <TH showFrom="workspace-lg">Base setup</TH>
          <TH showFrom="workspace-xl">Last active</TH>
          <TH visuallyHidden>Actions</TH>
        </THead>
        <TBody>
          {isError && (
            <TRow variant="separator">
              <TD align="center" colSpan={8} tone="dim">
                <div role="alert" className="py-4 text-status-danger">
                  Could not load experiments. Try again.
                </div>
              </TD>
            </TRow>
          )}
          {!isError && sessions.length === 0 && (
            <TRow variant="separator">
              <TD align="center" colSpan={8} tone="dim">
                <div className="py-4">{isLoading ? "Loading experiments…" : "No experiments yet. Create one above to get started."}</div>
              </TD>
            </TRow>
          )}
          {sessions.map((s) => {
            const base = s.baseSetupPath?.split(/[\\/]/).pop() ?? "—";
            return (
              <TRow key={s.id} onClick={() => onOpen(s.id)}>
                <TD align="end" showFrom="workspace-sm" numeric tone="dim">
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
                  {new Date(s.updatedAt).toLocaleDateString()}
                </TD>
                <TD align="end">
                  <span className="text-xs font-semibold text-app-accent">Resume →</span>
                </TD>
              </TRow>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}
