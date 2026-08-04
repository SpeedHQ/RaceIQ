import { m } from "../../paraglide/messages";

interface AnalyseWorkspaceStatusProps {
  loading: boolean;
  lapError: unknown;
  parseError: string | null | undefined;
  selectedLapId: number | null;
}

export function AnalyseWorkspaceStatus({ loading, lapError, parseError, selectedLapId }: AnalyseWorkspaceStatusProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-muted text-sm">
      {loading ? (
        <span role="status">{m.analyse_loading_telemetry()}</span>
      ) : lapError ? (
        <div role="alert" className="flex flex-col items-center gap-2 max-w-xl text-center">
          <span className="text-status-danger font-medium">{m.common_error()}</span>
          <code className="text-xs text-app-text-muted whitespace-pre-wrap break-words">{lapError instanceof Error ? lapError.message : String(lapError)}</code>
        </div>
      ) : parseError ? (
        <div role="alert" className="flex flex-col items-center gap-2 max-w-xl text-center">
          <span className="text-status-danger font-medium">{m.analyse_parse_error()}</span>
          <code className="text-xs text-app-text-muted whitespace-pre-wrap break-words">{parseError}</code>
        </div>
      ) : selectedLapId ? (
        <span>{m.analyse_no_telemetry_data()}</span>
      ) : (
        <span>{m.analyse_select_to_start()}</span>
      )}
    </div>
  );
}
