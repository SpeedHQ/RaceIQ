import { m } from "@/paraglide/messages";

export function RecordingStep() {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <h2 className="mb-2 text-2xl font-bold tracking-tight text-app-text">{m.ob_recording_title()}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-app-text-muted">{m.ob_community_recording()}</p>
    </div>
  );
}
