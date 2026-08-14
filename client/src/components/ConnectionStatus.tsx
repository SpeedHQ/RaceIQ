import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "../stores/telemetry";
import { deriveConnectionStatusView } from "./connection-status-logic";

interface Props {
  connected: boolean;
  packetsPerSec: number;
  forzaReceiving: boolean;
  collapsed?: boolean;
}

const DOT_CLASS: Record<"green" | "red" | "cyan" | "amber" | "dim", string> = {
  green: "status-dot-success",
  red: "status-dot-danger",
  cyan: "status-dot-info",
  amber: "status-dot-warning",
  dim: "status-dot-unavailable",
};

export function ConnectionStatus({ connected, packetsPerSec, forzaReceiving, collapsed = false }: Props) {
  const detectedGame = useTelemetryStore((s) => s.serverStatus?.detectedGame);
  const view = deriveConnectionStatusView({ connected, forzaReceiving, detectedGame });

  // Localize the display text here (connection-status-logic stays pure/testable).
  // gameLabel is the game's display name (proper noun) — kept verbatim.
  let statusText: string;
  switch (view.statusKind) {
    case "disconnected":
      statusText = m.status_disconnected();
      break;
    case "server":
      statusText = m.status_server();
      break;
    case "receiving":
      statusText = view.gameLabel ?? m.status_receiving();
      break;
    case "waiting":
      statusText = view.gameLabel ? `${view.gameLabel} — ${m.status_waiting()}` : m.status_waiting();
      break;
  }

  const packetText = forzaReceiving ? `${m.browser_source()}: ${packetsPerSec} Hz` : null;
  const accessibleLabel = packetText ? `${statusText}. ${packetText}` : statusText;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="status"
              // oxlint-disable-next-line a11y/noNoninteractiveTabindex: a non-action status needs keyboard focus to reveal its tooltip.
              tabIndex={0}
              aria-label={accessibleLabel}
              className="flex h-9 w-full items-center justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            />
          }
        >
          <span className={`size-2.5 rounded-full ${DOT_CLASS[view.dotColor]}`} />
        </TooltipTrigger>
        <TooltipContent side="right" role="tooltip">
          {accessibleLabel}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div role="status" aria-label={accessibleLabel} className="flex w-full flex-col gap-0.5 px-2 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`size-2.5 shrink-0 rounded-full ${DOT_CLASS[view.dotColor]}`} />
        <span className="truncate text-xs font-medium text-app-text">{statusText}</span>
      </div>
      {packetText && <span className="pl-[18px] text-xs font-mono tabular-nums text-app-text-muted">{packetText}</span>}
    </div>
  );
}
