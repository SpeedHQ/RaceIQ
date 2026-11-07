import { useLiveEngineerVoicePackMutation, useLiveEngineerVoicePackStatus } from "@/hooks/live-engineer-voice-pack";
import { clientReleaseFeatures } from "@/lib/release-features";
import { m } from "@/paraglide/messages";
import { RadioModal } from "@/components/live-engineer/RadioModal";
import { Button } from "@/components/ui/button";

export function LiveEngineerSection() {
  const status = useLiveEngineerVoicePackStatus(clientReleaseFeatures.liveSpotterEngineer);
  const check = useLiveEngineerVoicePackMutation("check");
  const install = useLiveEngineerVoicePackMutation("install");
  const busy = check.isPending || install.isPending || status.data?.installing;
  const error = check.error ?? install.error ?? (status.isError ? status.error : null) ?? status.data?.updateError;
  if (!clientReleaseFeatures.liveSpotterEngineer) return null;
  return <section className="space-y-5">
    <div><h2 className="mb-1 text-lg font-semibold text-app-text">{m.label_live_engineer()}</h2>
      <p className="text-sm text-app-text-muted">{m.live_engineer_package_description()}</p></div>
    <div className="space-y-2 rounded border border-app-border p-4 text-sm">
      <p>{m.live_engineer_package_installed({ version: status.data?.installedVersion ?? "—" })}</p>
      <p>{m.live_engineer_package_required({ version: status.data?.requiredVersion ?? "—" })}</p>
      <p>{m.live_engineer_package_latest({ version: status.data?.latestVersion ?? "—" })}</p>
      {status.data && <p>{m.live_engineer_package_contract({ engine: String(status.data.installedEngineVersion ?? "—"), catalog: status.data.installedCatalogVersion ?? "—", language: status.data.installedLanguage ?? "—" })}</p>}
      {status.data && <p>{m.live_engineer_package_required_contract({ engine: String(status.data.requiredEngineVersion), catalog: status.data.requiredCatalogVersion, language: status.data.language })}</p>}
      {status.data?.lastChecked && <p>{m.live_engineer_package_last_checked({ time: new Date(status.data.lastChecked).toLocaleString() })}</p>}
      {(status.isPending || check.isPending) && <p role="status">{m.radio_voice_pack_checking()}</p>}
      {install.isPending && <p role="status">{m.live_engineer_package_installing()}</p>}
      {!busy && !error && status.data?.state === "ready" && status.data.lastChecked && !status.data.updateAvailable && <p role="status">{m.live_engineer_package_up_to_date()}</p>}
      {error && <p role="alert" className="text-status-danger">{m.live_engineer_package_error()}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => check.mutate()}>{m.live_engineer_package_check()}</Button>
        <Button disabled={busy || (!status.data?.updateAvailable && status.data?.state === "ready")} onClick={() => install.mutate()}>{status.data?.state === "ready" ? m.live_engineer_package_update() : m.live_engineer_package_install()}</Button>
      </div>
    </div>
    <RadioModal showPackageGate={false} />
  </section>;
}
