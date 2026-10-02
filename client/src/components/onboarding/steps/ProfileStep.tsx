import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export function ProfileStep() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const serverName = displaySettings.driverName ?? "";
  const [name, setName] = useState(serverName);
  const latestName = useRef(name);
  const committedName = useRef(serverName);
  useEffect(() => {
    latestName.current = name;
  }, [name]);
  useEffect(() => {
    if (serverName && !latestName.current) {
      setName(serverName);
      committedName.current = serverName;
    }
  }, [serverName]);
  useEffect(
    () => () => {
      const trimmed = latestName.current.trim();
      if (trimmed !== committedName.current) saveSettings.mutate({ driverName: trimmed });
    },
    [],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const handleBlur = () => {
    const trimmed = name.trim();
    if (trimmed !== committedName.current) {
      committedName.current = trimmed;
      saveSettings.mutate({ driverName: trimmed });
    }
  };
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.ob_profile_title()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.ob_profile_desc()}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="driver-name" className="text-xs text-app-text-muted">
          {m.ob_profile_name_label()}
        </Label>
        <Input
          id="driver-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder={m.ob_profile_name_placeholder()}
          className="max-w-xs"
          autoFocus
        />
      </div>
    </div>
  );
}
