import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useEffect, useState } from "react";
import type { OnlinePreferences, OnlineSyncBlock, OnlineVisibility } from "@raceiq/shared/integrations/raceiq-online";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useRaceIqOnline } from "@/hooks/raceiq-online";
import { m } from "@/paraglide/messages";
import { onlineErrorMessage } from "@/components/online/messages";

const accountUrl = "https://raceiq.snazzie.space/account";
const visibilityLabels: Record<OnlineVisibility, () => string> = {
  public: m.online_visibility_public,
  private: m.online_visibility_private,
};
const syncBlockMessages: Record<OnlineSyncBlock, () => string> = {
  signed_out: m.online_block_signed_out,
  consent_required: m.online_block_consent_required,
  private: m.online_block_private,
  preferences_unconfirmed: m.online_block_preferences_unconfirmed,
  offline: m.online_block_offline,
  service_unavailable: m.online_block_service_unavailable,
  account_unavailable: m.online_block_account_unavailable,
};

export function OnlineSection({ onboarding = false, stage = "permissions", onSkip, onComplete }: { onboarding?: boolean; stage?: "auth" | "permissions"; onSkip?: () => void; onComplete?: () => void } = {}) {
  const online = useRaceIqOnline();
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState<OnlinePreferences>({ visibility: "public", setupUploads: false });
  const [draftReady, setDraftReady] = useState(false);
  const [nameDraft, setNameDraft] = useState<{ accountEpoch: string; value: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signOutRequested, setSignOutRequested] = useState(false);
  const [retryReady, setRetryReady] = useState(true);
  const state = online.state;
  const settingsPreferences = draftReady ? draft : state?.preferences ?? draft;
  const settingsDirty = !state?.preferences || settingsPreferences.visibility !== state.preferences.visibility || settingsPreferences.setupUploads !== state.preferences.setupUploads;
  const account = state?.connection.status === "connected" ? state.connection.account : null;
  const leaderboardName = nameDraft?.accountEpoch === state?.accountEpoch ? nameDraft?.value ?? "" : account?.displayName ?? "";
  const nameDirty = !!account && leaderboardName.trim() !== account.displayName;
  const policy = state?.policy.status === "available" ? state.policy : null;
  const needsConsent = state?.consent.status === "required" || state?.consent.status === "not_accepted";
  const accountHidden = online.accountHidden || signOutRequested;
  const connected = state?.connection.status === "connected" && !accountHidden;
  const pending = online.isMutating || online.signOutPending;
  const failure = actionError ?? (online.commandError ? onlineErrorMessage(online.commandError.code) : online.transportError ? m.online_transport_error() : null);
  const confirmationKey = `${state?.accountEpoch ?? ""}:${policy?.versions.termsVersion ?? ""}:${policy?.versions.privacyVersion ?? ""}`;
  useEffect(() => { setConfirmed(false); }, [confirmationKey, draft.visibility, draft.setupUploads]);
  useEffect(() => { if (state?.connection.status === "signed_out") setSignOutRequested(false); }, [state?.accountEpoch, state?.connection.status]);
  useEffect(() => {
    setDraft(state?.preferences ?? { visibility: "public", setupUploads: false });
    setDraftReady(false);
    setActionError(null);
  }, [state?.accountEpoch, onboarding]);
  useEffect(() => {
    const retryAfter = online.commandError?.retryAfter;
    const delay = retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
    setRetryReady(delay <= 0);
    if (delay > 0) {
      const timer = window.setTimeout(() => setRetryReady(true), Math.min(delay, 2_147_483_647));
      return () => window.clearTimeout(timer);
    }
  }, [online.commandError?.retryAfter]);

  async function connect() {
    setActionError(null);
    await online.connect();
  }
  async function consent() {
    if (!confirmed) return false;
    setActionError(null);
    const result = await online.acceptConsent();
    if (!result?.ok) {
      if (!result) setActionError(m.online_transport_error());
      return false;
    }
    setConfirmed(false);
    return result.state.consent.status === "accepted";
  }
  async function acceptSettingsConsent() {
    if (!await consent()) return;
    if (state?.preferencePersistence !== "confirmed") await savePreferences(settingsPreferences);
  }
  async function savePreferences(next: OnlinePreferences) {
    setDraft(next);
    setDraftReady(true);
    setActionError(null);
    const result = await online.setPreferences(next);
    if (!result?.ok || result.state.preferencePersistence !== "confirmed") {
      if (!result || result.ok) setActionError(m.online_preferences_unconfirmed());
      return false;
    }
    setDraftReady(false);
    return true;
  }
  async function saveSettings() {
    if (pending || !online.canMutate || needsConsent || !state) return;
    setActionError(null);
    if (nameDirty) {
      const displayName = leaderboardName.trim();
      if (!displayName || Array.from(displayName).length > 80 || /\p{Cc}/u.test(displayName)) {
        setActionError(m.ob_profile_name_invalid());
        return;
      }
      const result = await online.setDisplayName(displayName);
      if (!result?.ok) {
        if (!result) setActionError(m.online_transport_error());
        return;
      }
      setNameDraft((current) => current?.accountEpoch === state.accountEpoch && current.value === leaderboardName ? null : current);
    }
    if (settingsDirty || state.preferencePersistence !== "confirmed") await savePreferences(settingsPreferences);
  }
  async function completePermissions() {
    if ((needsConsent && !confirmed) || !connected) return;
    if (needsConsent && !await consent()) return;
    if (!await savePreferences(draft)) return;
    setConfirmed(false);
    onComplete?.();
  }
  async function signOut() {
    setActionError(null);
    setSignOutRequested(true);
    await online.signOut();
  }
  async function retryPreferences() {
    await savePreferences(draftReady ? draft : state?.preferences ?? draft);
  }
  async function retryCommand() {
    const code = online.commandError?.code;
    if (code === "preferences_failed") return retryPreferences();
    if (["auth_failed", "auth_cancelled", "external_open_failed"].includes(code ?? "")) return connect();
    if (["stale_state", "policy_changed", "consent_required", "offline", "service_unavailable", "policy_unavailable", "rate_limited"].includes(code ?? "")) await online.refresh().catch(() => undefined);
  }
  const title = onboarding ? m.online_onboarding_title() : m.online_settings_title();
  async function abortSignIn() {
    if (onboarding) { onSkip?.(); return; }
    if (state?.connection.status === "signing_in") {
      const result = await online.cancelSignIn();
      if (!result?.ok) { setActionError(m.online_transport_error()); return; }
    }
    onSkip?.();
  }
  if (!onboarding && accountHidden) {
    return <section className="max-w-2xl" aria-busy={pending}>
      <h2 className="mb-1 text-lg font-semibold text-app-text">{title}</h2>
      {online.signOutPending && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_signout_pending()}</p>}
      {(online.transportError || online.commandError) && <p role="alert" className="mb-3 text-sm text-status-danger">{m.online_signout_unknown()}</p>}
      <Button variant="outline" disabled={online.isMutating} onClick={() => void signOut()}>{m.online_retry_signout()}</Button>
    </section>;
  }
  if ((onboarding && stage === "auth") || (!onboarding && !connected)) {
    return <section className="max-w-2xl" aria-busy={pending}>
      <h2 className="mb-1 text-lg font-semibold text-app-text">{title}</h2>
      <p className="mb-4 text-sm text-app-text-muted">{m.online_intro()}</p>
      {online.isPending && !state && <p role="status">{m.online_loading()}</p>}
      {failure && !online.transportError && <p role="alert" className="mb-3 text-sm text-status-danger">{failure}</p>}
      {!online.transportError && state?.service !== "available" && state && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_service_unavailable()}</p>}
      {state?.connection.status === "error" && <p role="alert" className="mb-3 text-sm text-status-danger">{onlineErrorMessage(state.connection.error.code)}</p>}
      {state?.connection.status === "signing_in"
        ? <div className="rounded-md border border-app-border p-3"><p role="status" className="text-sm">{m.online_signing_in()}</p><Button className="mt-2" variant="outline" disabled={pending} onClick={() => void abortSignIn()}>{m.online_cancel()}</Button></div>
        : <Button variant="app-primary" disabled={pending || !online.canAuthenticate} onClick={() => void connect()}>{m.online_connect()}</Button>}
      {(online.transportError || online.isCachedState) && <div role="alert" className="mt-3 text-sm text-status-danger"><p>{state ? m.online_transport_error() : m.online_service_unavailable()}</p><Button variant="outline" size="sm" className="mt-2" disabled={pending} onClick={() => void online.refresh().catch(() => undefined)}>{m.online_retry()}</Button></div>}
      {state?.preferences && <div className="my-4 space-y-4 border-y border-app-border py-4">
        <PreferenceControl title={m.online_public_title()} description={m.online_public_desc()} checked={state.preferences.visibility === "public"} disabled />
        <PreferenceControl title={m.online_setup_title()} description={m.online_setup_desc()} checked={state.preferences.setupUploads} disabled />
        <p role="status" className="text-sm text-app-text-muted">{m.online_preferences_effective({ visibility: visibilityLabels[state.preferences.visibility](), setup: state.preferences.setupUploads ? m.common_on() : m.common_off() })}</p>
      </div>}
      {onboarding && <Button className="ml-2" variant="outline" disabled={pending} onClick={() => void abortSignIn()}>{m.online_skip()}</Button>}
    </section>;
  }
  if (onboarding && stage === "permissions") {
    return <section className="max-w-2xl" aria-busy={pending}>
      <h2 className="mb-1 text-lg font-semibold text-app-text">{title}</h2>
      {connected && state.connection.status === "connected" && <p className="mb-4 text-sm text-app-text-muted">{m.online_connected_as({ name: state.connection.account.displayName })}</p>}
      {failure && <p role="alert" className="mb-3 text-sm text-status-danger">{failure}</p>}
      {!connected && !failure && <p role="status">{m.online_loading()}</p>}
      {state?.policy.status === "unavailable" && <div role="alert" className="mb-3 text-sm text-status-danger"><p>{m.online_policy_unavailable()}</p><Button variant="outline" size="sm" disabled={pending} onClick={() => void online.refresh()}>{m.online_retry()}</Button></div>}
      {connected && <>
        <PreferenceControl title={m.online_public_title()} description={m.online_public_desc()} checked={draft.visibility === "public"} disabled={pending || !online.canMutate} onChange={(checked) => { setDraft({ ...draft, visibility: checked ? "public" : "private" }); setDraftReady(true); }} />
        <PreferenceControl title={m.online_setup_title()} description={m.online_setup_desc()} checked={draft.setupUploads} disabled={pending || !online.canMutate} onChange={(checked) => { setDraft({ ...draft, setupUploads: checked }); setDraftReady(true); }} />
        {policy && <div className="my-4 flex gap-4 text-sm"><a className="text-app-accent underline" href={policy.termsUrl} target="_blank" rel="noopener noreferrer">{m.online_terms()}</a><a className="text-app-accent underline" href={policy.privacyUrl} target="_blank" rel="noopener noreferrer">{m.online_privacy()}</a></div>}
        <ul className="my-4 list-disc space-y-1 pl-5 text-sm text-app-text-muted"><li>{m.online_disclosure_public()}</li><li>{m.online_disclosure_private()}</li><li>{m.online_disclosure_setup()}</li><li>{m.online_disclosure_sanitization()}</li><li>{m.online_disclosure_withdrawal()}</li></ul>
        {needsConsent && <label className="my-4 flex items-start gap-3 text-sm text-app-text"><input type="checkbox" className="mt-1 accent-app-accent" checked={confirmed} disabled={!policy || pending || !online.canMutate} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>{m.online_confirm_policy()}</span></label>}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          {onboarding ? <Button className="min-h-11" variant="outline" disabled={pending} onClick={() => void abortSignIn()}>{m.ob_continue_offline()}</Button> : <Button className="min-h-11" variant="outline" disabled={pending} onClick={() => void signOut()}>{m.online_sign_out()}</Button>}
          <Button className="min-h-11" variant="app-primary" disabled={(needsConsent && !confirmed) || pending || !online.canMutate || !policy || state?.service !== "available"} onClick={() => void completePermissions()}>{needsConsent ? m.online_connect_accept() : m.common_next()}</Button>
        </div>
      </>}
    </section>;
  }

  return (
    <section className="max-w-2xl" aria-busy={pending}>
      <h2 className="text-lg font-semibold text-app-text mb-1">{title}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.online_intro()}</p>
      <>
        {online.signOutPending && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_signout_pending()}</p>}
        {accountHidden && (online.transportError || online.commandError) && <p role="alert" className="mb-3 text-sm text-status-danger">{m.online_signout_unknown()} <Button variant="outline" size="sm" disabled={online.isMutating} onClick={() => void signOut()}>{m.online_retry_signout()}</Button></p>}
        {online.isPending && !state && <p role="status" className="text-sm text-app-text-muted">{m.online_loading()}</p>}
        {(online.transportError || online.isCachedState) && <div role="alert" className="mb-4 rounded-md border border-status-danger/40 p-3 text-sm"><p>{m.online_transport_error()}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => void online.refresh().catch(() => undefined)}>{m.online_retry()}</Button></div>}
        {!online.transportError && !online.isCachedState && state?.service !== "available" && state && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_service_unavailable()}</p>}
        {failure && !online.transportError && <div role="alert" className="mb-3 text-sm text-status-danger"><p>{failure}</p>{online.commandError?.retryAfter && <p>{m.online_retry_after({ timestamp: online.commandError.retryAfter })}</p>}{online.commandError?.retryable && <Button variant="outline" size="sm" disabled={!retryReady || pending} onClick={() => void retryCommand()}>{m.online_retry()}</Button>}</div>}
        {state?.policy.status === "unavailable" && <p role="alert" className="mb-3 text-sm text-status-danger">{state.policy.error ? onlineErrorMessage(state.policy.error.code) : m.online_policy_unavailable()}</p>}
        {state?.connection.status === "error" && <div role="alert" className="mb-3 text-sm text-status-danger"><p>{onlineErrorMessage(state.connection.error.code)}</p><Button variant="outline" size="sm" className="mt-2" disabled={pending} onClick={() => void signOut()}>{m.online_sign_out()}</Button></div>}
        {connected && state.connection.status === "connected" && <div className="mb-4 rounded-lg border border-app-border bg-app-surface-alt/40 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-12 shrink-0">
              <AvatarImage src={state.connection.account.avatarUrl ?? undefined} alt={state.connection.account.discordUsername ?? m.online_discord_name_unavailable()} />
              <AvatarFallback>{(state.connection.account.discordUsername ?? state.connection.account.displayName).slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm text-app-text"><span className="text-app-text-muted">{m.online_discord_account_name()}:</span> {state.connection.account.discordUsername ?? m.online_discord_name_unavailable()}</p>
              <label className="mt-2 block text-sm text-app-text">
                <span className="text-app-text-muted">{m.online_leaderboard_name()}</span>
                <Input className="mt-1" value={leaderboardName} disabled={pending || !online.canMutate || needsConsent} onChange={(event) => { setNameDraft({ accountEpoch: state.accountEpoch, value: event.currentTarget.value }); setActionError(null); }} autoComplete="off" />
              </label>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-sm"><a className="text-app-accent underline" href={accountUrl} target="_blank" rel="noopener noreferrer">{m.online_manage_account()}</a>
          <button className="text-status-danger underline disabled:opacity-50" disabled={pending} onClick={() => void signOut()}>{m.online_sign_out()}</button></div>
        </div>}
        {connected && <div className="space-y-4 border-y border-app-border py-4">
          <PreferenceControl title={m.online_public_title()} description={m.online_public_desc()} checked={settingsPreferences.visibility === "public"} disabled={pending || !online.canMutate || needsConsent} onChange={(checked) => { setDraft({ visibility: checked ? "public" : "private", setupUploads: settingsPreferences.setupUploads }); setDraftReady(true); }} />
          <PreferenceControl title={m.online_setup_title()} description={m.online_setup_desc()} checked={settingsPreferences.setupUploads} disabled={pending || !online.canMutate || needsConsent} onChange={(checked) => { setDraft({ visibility: settingsPreferences.visibility, setupUploads: checked }); setDraftReady(true); }} />
          {state.preferencePersistence !== "confirmed" && <p role="status" className="text-sm text-status-warning">{state.preferencePersistence === "pending" ? m.online_preferences_pending() : state.preferencePersistence === "failed" ? m.online_preferences_failed() : m.online_preferences_unconfirmed()}</p>}
          {state.preferences && <p className="text-sm text-app-text-muted">{m.online_preferences_effective({ visibility: visibilityLabels[state.preferences.visibility](), setup: state.preferences.setupUploads ? m.common_on() : m.common_off() })}</p>}
          {state.persistedPreferences && <p className="text-sm text-app-text-muted">{m.online_preferences_persisted_values({ visibility: visibilityLabels[state.persistedPreferences.visibility](), setup: state.persistedPreferences.setupUploads ? m.common_on() : m.common_off() })}</p>}
          {!needsConsent && <Button variant="app-primary" size="sm" disabled={pending || !online.canMutate || (!settingsDirty && !nameDirty && state.preferencePersistence === "confirmed") || !retryReady || online.commandError?.retryable === false} onClick={() => void saveSettings()}>{pending ? m.common_saving() : state.preferencePersistence === "confirmed" ? m.common_save() : m.online_retry_preferences()}</Button>}
        </div>}
        {connected && needsConsent && <div className="my-4 border-b border-app-border pb-4">
          <ul className="my-4 list-disc space-y-1 pl-5 text-sm text-app-text-muted"><li>{m.online_disclosure_public()}</li><li>{m.online_disclosure_private()}</li><li>{m.online_disclosure_setup()}</li><li>{m.online_disclosure_sanitization()}</li><li>{m.online_disclosure_withdrawal()}</li></ul>
          <label className="my-4 flex items-start gap-3 text-sm text-app-text"><input type="checkbox" className="mt-1 accent-app-accent" checked={confirmed} disabled={!policy || pending || !online.canMutate} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>{m.online_confirm_policy()}</span></label>
          <Button variant="app-primary" disabled={!confirmed || pending || !online.canMutate || !policy} onClick={() => void acceptSettingsConsent()}>{m.online_connect_accept()}</Button>
        </div>}
        {!accountHidden && policy && <div className="my-4 flex gap-4 text-sm"><a className="text-app-accent underline" href={policy.termsUrl} target="_blank" rel="noopener noreferrer">{m.online_terms()}</a><a className="text-app-accent underline" href={policy.privacyUrl} target="_blank" rel="noopener noreferrer">{m.online_privacy()}</a></div>}
        {state && state.publicationWithdrawal.status !== "none" && <p role="status" className="mt-4 text-sm text-app-text-muted">{state.publicationWithdrawal.status === "pending" ? m.online_withdrawal_pending() : state.publicationWithdrawal.status === "failed" ? m.online_withdrawal_failed() : state.publicationWithdrawal.status === "unavailable" ? m.online_withdrawal_limited() : m.online_withdrawal_complete()}</p>}
        {state?.sync.status === "running" && <p role="status" className="mt-3 text-sm text-app-text-muted">{m.online_sync_running({ count: state.sync.queued })}</p>}
        {state?.sync.blockedBy && <p role="status" className="mt-3 text-sm text-app-text-muted">{m.online_sync_blocked({ reason: syncBlockMessages[state.sync.blockedBy]() })}</p>}
        {state?.sync.lastError && <p role="alert" className="mt-3 text-sm text-status-danger">{onlineErrorMessage(state.sync.lastError.code)}</p>}
        {!accountHidden && draftReady && (settingsDirty || !connected || online.isMutating || state?.preferencePersistence !== "confirmed" || !!online.transportError) && <p role="status" className="mt-2 text-sm text-app-text-muted">{m.online_draft_only()} {visibilityLabels[draft.visibility]()} · {m.online_setup_title()}: {draft.setupUploads ? m.common_on() : m.common_off()}</p>}
      </>
    </section>
  );
}

function PreferenceControl({ title, description, checked, disabled, onChange }: { title: string; description: string; checked: boolean; disabled: boolean; onChange?: (checked: boolean) => void }) {
  return <div className="flex items-start justify-between gap-4 py-3"><div><p className="font-medium text-app-text">{title}</p><p className="mt-1 max-w-xl text-sm text-app-text-muted">{description}</p></div><Switch aria-label={title} checked={checked} disabled={disabled} onCheckedChange={onChange} /></div>;
}
