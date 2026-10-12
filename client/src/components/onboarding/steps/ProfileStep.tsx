import { useEffect, useRef, useState } from "react";
import type { OnlineCommandResult, OnlineState } from "@raceiq/shared/integrations/raceiq-online";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSaveSettings, useSettings } from "@/hooks/settings";
import { m } from "@/paraglide/messages";

export type ProfileStepHandle = { save(): Promise<boolean> };
export function ProfileStep({ onlineIntent, onlineState, canMutate = true, setDisplayName, handleRef, onSavingChange }: {
  onlineIntent: boolean;
  onlineState?: OnlineState;
  canMutate?: boolean;
  setDisplayName?: (name: string) => Promise<OnlineCommandResult | undefined>;
  handleRef: (handle: ProfileStepHandle | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { displaySettings, settingsLoaded } = useSettings();
  const saveSettings = useSaveSettings();
  const account = onlineIntent && onlineState?.connection.status === "connected" ? onlineState.connection.account : undefined;
  const accountKey = onlineIntent ? account ? `${onlineState!.accountEpoch}:${account.userId}` : `online:${onlineState?.accountEpoch ?? "pending"}` : "offline";
  const [name, setName] = useState(onlineIntent ? "" : displaySettings.driverName ?? "");
  const [error, setError] = useState<"invalid" | "save" | false>(false);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  const currentKey = useRef(accountKey);
  const latest = useRef({ name, accountKey, onlineIntent, onlineState, canMutate, setDisplayName });
  latest.current = { name, accountKey, onlineIntent, onlineState, canMutate, setDisplayName };
  useEffect(() => {
    if (currentKey.current !== accountKey) {
      currentKey.current = accountKey;
      dirty.current = false;
      setName(onlineIntent ? "" : displaySettings.driverName ?? "");
      setError(false);
    } else if (!dirty.current) {
      if (!onlineIntent && settingsLoaded) setName(displaySettings.driverName ?? "");
    }
  }, [accountKey, account?.displayName, displaySettings.driverName, onlineIntent, settingsLoaded]);
  const savingRef = useRef(false);
  const save = async (): Promise<boolean> => {
    if (savingRef.current || (latest.current.onlineIntent && !latest.current.canMutate)) return false;
    savingRef.current = true;
    const captured = latest.current;
    const originalKey = captured.accountKey;
    const trimmed = captured.name.trim();
    const connection = captured.onlineState?.connection;
    if (captured.onlineIntent && connection?.status === "connected" && trimmed && (Array.from(trimmed).length > 80 || /\p{Cc}/u.test(trimmed))) {
      setError("invalid");
      savingRef.current = false;
      return false;
    }
    setError(false);
    setSaving(true);
    onSavingChange(true);
    try {
      if (captured.onlineIntent) {
        if (connection?.status !== "connected") throw new Error("Online profile unavailable");
        let confirmedName = connection.account.displayName;
        if (trimmed) {
          if (!captured.setDisplayName) throw new Error("Online profile save unavailable");
          const response = await captured.setDisplayName(trimmed);
          const returned = response?.state;
          if (!response?.ok || !returned || returned.accountEpoch !== captured.onlineState?.accountEpoch || returned.connection.status !== "connected" || returned.connection.account.userId !== connection.account.userId) throw new Error("Online profile save failed");
          confirmedName = returned.connection.account.displayName;
        }
        if (latest.current.accountKey !== originalKey) return false;
        await saveSettings.mutateAsync({ driverName: confirmedName });
      } else {
        await saveSettings.mutateAsync({ driverName: trimmed });
      }
      if (latest.current.accountKey !== originalKey) return false;
      dirty.current = false;
      return true;
    } catch {
      setError("save");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  };
  useEffect(() => {
    handleRef({ save });
    return () => handleRef(null);
  }, [handleRef, accountKey]);
  return (
    <div>
      <h2 className="text-sm font-semibold text-app-text mb-1">{m.ob_profile_title()}</h2>
      <p className="text-sm text-app-text-muted mb-4">{onlineIntent ? m.ob_profile_online_desc() : m.ob_profile_desc()}</p>
      {onlineIntent && !canMutate && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_transport_error()}</p>}
      <div className="flex flex-col gap-1">
        <Label htmlFor="driver-name" className="text-xs text-app-text-muted">{m.ob_profile_name_label()}</Label>
        <Input id="driver-name" value={name} disabled={saving || (onlineIntent && !canMutate)} onChange={(e) => { dirty.current = true; setName(e.target.value); setError(false); }} placeholder={account?.displayName ?? m.ob_profile_name_placeholder()} className="max-w-xs" autoFocus />
        {error && <p role="alert" className="text-sm text-status-danger">{error === "invalid" ? m.ob_profile_name_invalid() : m.ob_profile_save_failed()}</p>}
        {saving && <p role="status" className="text-sm text-app-text-muted">{m.ob_profile_saving()}</p>}
      </div>
    </div>
  );
}
