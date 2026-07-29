interface Props {
  missingVariables: readonly string[];
}

export function IbtTelemetryWarning({ missingVariables }: Props) {
  if (missingVariables.length === 0) return null;

  const channelLabel = missingVariables.length === 1 ? "channel" : "channels";

  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300/90">
      <p>
        This .ibt recording does not contain {missingVariables.length} optional RaceIQ telemetry {channelLabel}. iRacing does not save every live SDK channel in every .ibt file, so RaceIQ cannot
        restore data that was not recorded. Affected views will show fallback values.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">
          Missing {channelLabel} ({missingVariables.length})
        </summary>
        <p className="mt-1 break-words font-mono text-[11px] text-amber-200/80">{missingVariables.join(", ")}</p>
      </details>
    </div>
  );
}
