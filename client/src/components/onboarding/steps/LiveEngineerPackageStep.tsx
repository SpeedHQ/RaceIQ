import { useLiveEngineerVoicePackMutation, useLiveEngineerVoicePackStatus } from "@/hooks/live-engineer-voice-pack";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";

export function LiveEngineerPackageStep() {
  const status = useLiveEngineerVoicePackStatus(true);
  const install = useLiveEngineerVoicePackMutation("install");
  const busy = install.isPending || status.data?.installing;
  return <div className="space-y-3">
    <h2 className="text-sm font-semibold text-app-text">{m.live_engineer_package_title()}</h2>
    <p className="text-sm text-app-text-muted">{m.live_engineer_package_description()}</p>
    {status.isError && <p role="alert" className="text-sm text-status-danger">{m.live_engineer_package_error()}</p>}
    {status.data && <p className="text-sm text-app-text-muted">{status.data.state === "ready" ? m.live_engineer_package_installed({ version: status.data.installedVersion ?? "—" }) : m.live_engineer_package_required({ version: status.data.requiredVersion })}</p>}
    {install.error && <p role="alert" className="text-sm text-status-danger">{m.live_engineer_package_error()}</p>}
    <div className="flex gap-2">
      {status.data?.state !== "ready" && <Button size="sm" disabled={busy || status.isPending} onClick={() => install.mutate()}>{busy ? m.live_engineer_package_installing() : m.live_engineer_package_install()}</Button>}
      {status.isError && <Button size="sm" variant="outline" disabled={busy} onClick={() => void status.refetch()}>{m.label_retry()}</Button>}
    </div>
  </div>;
}
