import type { ProcessingMetadata } from "@raceiq/shared/racing/sessions/types";
import { LoaderCircle } from "lucide-react";
import { m } from "@/paraglide/messages";
import { Button } from "./ui/button";

export function ProcessingStatus({ processing, loading = false, onRefresh, className = "" }: {
  processing: ProcessingMetadata | undefined;
  loading?: boolean;
  onRefresh?: () => void;
  className?: string;
}) {
  const unresolved = loading || processing == null;
  if (!unresolved && processing.state === "ready") return null;
  const pending = unresolved || processing?.state === "queued" || processing?.state === "processing";
  const failed = !unresolved && processing?.state === "failed";
  const label = unresolved ? m.recording_processing_loading()
    : processing.state === "queued" ? m.recording_processing_queued()
      : processing.state === "processing" ? m.recording_processing_running()
        : processing.state === "failed" ? m.recording_processing_failed({ error: processing.error })
          : null;
  return (
    <div className={`flex flex-wrap items-center gap-1 text-app-label text-app-text-muted ${className}`} role={failed ? "alert" : "status"} aria-live={failed ? "assertive" : "polite"} aria-busy={pending}>
      {pending && <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />}
      {label && <span>{label}</span>}
      {failed && onRefresh && <Button type="button" variant="app-ghost" size="app-sm" onClick={onRefresh}>{m.recording_processing_refresh()}</Button>}
    </div>
  );
}
