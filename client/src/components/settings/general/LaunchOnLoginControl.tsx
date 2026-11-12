import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages";

interface LaunchOnLoginControlProps {
  desktopOwned: boolean;
  supported: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
}

/** The native desktop app owns startup separately from the backend setting. */
export function LaunchOnLoginControl({ desktopOwned, supported, checked, onChange, id }: LaunchOnLoginControlProps) {
  if (desktopOwned) {
    return <p className="text-sm text-app-text-muted">{m.settings_launch_desktop_owned()}</p>;
  }

  return (
    <div className="flex items-center gap-3">
      <Switch
        id={id}
        aria-label={m.label_launch_on_login()}
        disabled={!supported}
        checked={checked}
        onCheckedChange={(value) => supported && onChange(value)}
      />
      <span className="text-sm text-app-text-muted">
        {!supported ? m.settings_launch_installed_only() : checked ? m.common_enabled() : m.common_disabled()}
      </span>
    </div>
  );
}
