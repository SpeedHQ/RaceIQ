import { LaunchOnLoginControl } from "@/components/settings/general/LaunchOnLoginControl";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function StartupStep() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const desktopOwned = displaySettings.launchOnLoginOwner === "desktop";
  const supported = displaySettings.launchOnLoginSupported ?? !!displaySettings.isCompiled;
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_launch_on_login()}</h2>
      {!desktopOwned && <p className="text-sm text-app-text-muted mb-4">{m.ob_startup_desc()}</p>}
      <LaunchOnLoginControl
        desktopOwned={desktopOwned}
        supported={supported}
        checked={!!displaySettings.launchOnLogin}
        onChange={(checked) => saveSettings.mutate({ launchOnLogin: checked })}
      />
    </div>
  );
}
