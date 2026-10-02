import { Switch } from "@/components/ui/switch";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function StartupStep() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const enabled = !!displaySettings.isCompiled;
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.label_launch_on_login()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_startup_desc()}</p>
      <div className="flex items-center gap-3">
        <Switch
          disabled={!enabled}
          checked={!!displaySettings.launchOnLogin}
          aria-label={m.label_launch_on_login()}
          onCheckedChange={(checked) => enabled && saveSettings.mutate({ launchOnLogin: checked })}
        />
        <span className="text-sm text-app-text-muted">{!enabled ? m.settings_launch_installed_only() : displaySettings.launchOnLogin ? m.common_enabled() : m.common_disabled()}</span>
      </div>
    </div>
  );
}
