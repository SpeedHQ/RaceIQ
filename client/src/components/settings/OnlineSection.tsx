import { useEffect, useState } from "react";
import type { OnlinePreferences, OnlineSyncBlock, OnlineVisibility } from "@raceiq/shared/integrations/raceiq-online";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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

export function OnlineSection({ onboarding = false, onSkip }: { onboarding?: boolean; onSkip?: () => void } = {}) {
  const [started, setStarted] = useState(!onboarding);
  const online = useRaceIqOnline({ enabled: !onboarding || started });
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState<OnlinePreferences>({ visibility: onboarding ? "public" : "private", setupUploads: false });
  const [draftReady, setDraftReady] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signOutRequested, setSignOutRequested] = useState(false);
  const [retryReady, setRetryReady] = useState(true);
  const state = online.state;
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
    setDraft({ visibility: onboarding ? "public" : "private", setupUploads: false });
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

  function begin() {
    setStarted(true);
    if (onboarding) void online.refresh().catch(() => undefined);
  }
  async function connect() {
    if (!policy || !confirmed) return;
    setActionError(null);
    try { await online.connect(draft); } catch (error) { setActionError(error instanceof Error && error.message === "external_open_failed" ? m.online_error_external_open_failed() : m.online_error_internal_error()); }
  }
  async function consent() {
    if (!confirmed) return;
    setActionError(null);
    try { await online.acceptConsent(); setConfirmed(false); } catch { setActionError(m.online_transport_error()); }
  }

  async function savePreferences(next: OnlinePreferences) {
    setDraft(next);
    setDraftReady(true);
    setActionError(null);
    try { await online.setPreferences(next); } catch { setActionError(m.online_transport_error()); }
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
    if (["auth_failed", "auth_cancelled", "external_open_failed"].includes(code ?? "") && confirmed) return connect();
    if (["stale_state", "policy_changed", "consent_required", "offline", "service_unavailable", "policy_unavailable", "rate_limited"].includes(code ?? "")) await online.refresh().catch(() => undefined);
  }
  const title = onboarding ? m.online_onboarding_title() : m.online_settings_title();

  return (
    <section className="max-w-2xl" aria-busy={pending}>
      <h2 className="text-lg font-semibold text-app-text mb-1">{title}</h2>
      <p className="text-sm text-app-text-muted mb-4">{m.online_intro()}</p>
      {!started ? (
        <div className="flex gap-2">
          <Button variant="app-primary" onClick={begin}>{m.online_start()}</Button>
          <Button variant="outline" onClick={onSkip}>{m.online_skip()}</Button>
        </div>
      ) : <>
        {online.signOutPending && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_signout_pending()}</p>}
        {accountHidden && (online.transportError || online.commandError) && <p role="alert" className="mb-3 text-sm text-status-danger">{m.online_signout_unknown()} <Button variant="outline" size="sm" disabled={online.isMutating} onClick={() => void signOut()}>{m.online_retry_signout()}</Button></p>}
        {online.isPending && !state && <p role="status" className="text-sm text-app-text-muted">{m.online_loading()}</p>}
        {online.transportError && <div role="alert" className="mb-4 rounded-md border border-status-danger/40 p-3 text-sm"><p>{m.online_transport_error()}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => void online.refresh().catch(() => undefined)}>{m.online_retry()}</Button></div>}
        {state?.service !== "available" && state && <p role="status" className="mb-3 text-sm text-app-text-muted">{m.online_service_unavailable()}</p>}
        {failure && !online.transportError && <div role="alert" className="mb-3 text-sm text-status-danger"><p>{failure}</p>{online.commandError?.retryAfter && <p>{m.online_retry_after({ timestamp: online.commandError.retryAfter })}</p>}{online.commandError?.retryable && <Button variant="outline" size="sm" disabled={!retryReady || pending} onClick={() => void retryCommand()}>{m.online_retry()}</Button>}</div>}
        {state?.policy.status === "unavailable" && <p role="alert" className="mb-3 text-sm text-status-danger">{state.policy.error ? onlineErrorMessage(state.policy.error.code) : m.online_policy_unavailable()}</p>}
        {state?.connection.status === "error" && <div role="alert" className="mb-3 text-sm text-status-danger"><p>{onlineErrorMessage(state.connection.error.code)}</p><Button variant="outline" size="sm" className="mt-2" disabled={pending} onClick={() => void signOut()}>{m.online_sign_out()}</Button></div>}
        {connected && state.connection.status === "connected" && <div className="mb-4 rounded-lg border border-app-border bg-app-surface-alt/40 p-4">
          <p className="font-medium text-app-text">{m.online_connected_as({ name: state.connection.account.displayName })}</p>
          {state.consent.status === "accepted" && <p className="mt-1 text-xs text-app-text-muted">{m.online_consent_accepted()}</p>}
          <div className="mt-3 flex flex-wrap gap-3 text-sm"><a className="text-app-accent underline" href={accountUrl} target="_blank" rel="noopener noreferrer">{m.online_manage_account()}</a>
          <button className="text-status-danger underline disabled:opacity-50" disabled={pending} onClick={() => void signOut()}>{m.online_sign_out()}</button></div>
        </div>}
        {connected && <div className="space-y-4 border-y border-app-border py-4">
          <PreferenceControl title={m.online_public_title()} description={m.online_public_desc()} checked={state.preferences?.visibility === "public"} disabled={pending} onChange={(checked) => void savePreferences({ visibility: checked ? "public" : "private", setupUploads: state.preferences?.setupUploads ?? draft.setupUploads })} />
          <PreferenceControl title={m.online_setup_title()} description={m.online_setup_desc()} checked={state.preferences?.setupUploads === true} disabled={pending} onChange={(checked) => void savePreferences({ visibility: state.preferences?.visibility ?? draft.visibility, setupUploads: checked })} />
          {state.preferencePersistence !== "confirmed" && <p role="status" className="text-sm text-status-warning">{state.preferencePersistence === "pending" ? m.online_preferences_pending() : state.preferencePersistence === "failed" ? m.online_preferences_failed() : m.online_preferences_unconfirmed()}</p>}
          {state.preferences && <p className="text-sm text-app-text-muted">{m.online_preferences_effective({ visibility: visibilityLabels[state.preferences.visibility](), setup: state.preferences.setupUploads ? m.common_on() : m.common_off() })}</p>}
          {state.persistedPreferences && <p className="text-sm text-app-text-muted">{m.online_preferences_persisted_values({ visibility: visibilityLabels[state.persistedPreferences.visibility](), setup: state.persistedPreferences.setupUploads ? m.common_on() : m.common_off() })}</p>}
          {state.preferencePersistence !== "confirmed" && <Button variant="outline" size="sm" disabled={pending || !retryReady || online.commandError?.retryable === false} onClick={() => void retryPreferences()}>{m.online_retry_preferences()}</Button>}
        </div>}
        {!accountHidden && !connected && state?.connection.status !== "signing_in" && <PreferenceControl title={m.online_public_title()} description={m.online_public_desc()} checked={draft.visibility === "public"} disabled={pending} onChange={(checked) => { setDraft({ ...draft, visibility: checked ? "public" : "private" }); setDraftReady(true); }} />}
        {!accountHidden && !connected && state?.connection.status !== "signing_in" && <PreferenceControl title={m.online_setup_title()} description={m.online_setup_desc()} checked={draft.setupUploads} disabled={pending} onChange={(checked) => { setDraft({ ...draft, setupUploads: checked }); setDraftReady(true); }} />}
        {!accountHidden && policy && <div className="my-4 flex gap-4 text-sm"><a className="text-app-accent underline" href={policy.termsUrl} target="_blank" rel="noopener noreferrer">{m.online_terms()}</a><a className="text-app-accent underline" href={policy.privacyUrl} target="_blank" rel="noopener noreferrer">{m.online_privacy()}</a></div>}
        {(!connected || needsConsent) && <ul className="my-4 list-disc space-y-1 pl-5 text-sm text-app-text-muted"><li>{m.online_disclosure_public()}</li><li>{m.online_disclosure_private()}</li><li>{m.online_disclosure_setup()}</li><li>{m.online_disclosure_sanitization()}</li><li>{m.online_disclosure_withdrawal()}</li></ul>}
        {!accountHidden && !connected && state?.connection.status !== "signing_in" && <label className="my-4 flex items-start gap-3 text-sm text-app-text"><input type="checkbox" className="mt-1 accent-app-accent" checked={confirmed} disabled={!policy || pending} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>{m.online_confirm_policy()}</span></label>}
        {state?.connection.status === "signing_in" && <div className="my-3 rounded-md border border-app-border p-3"><p role="status" className="text-sm">{m.online_signing_in()}</p><Button className="mt-2" variant="outline" size="sm" disabled={pending} onClick={() => void online.cancelSignIn().catch(() => undefined)}>{m.online_cancel()}</Button></div>}
        {!accountHidden && !connected && state?.connection.status !== "signing_in" && <Button variant="app-primary" disabled={!policy || !confirmed || pending || state?.service !== "available"} onClick={() => void connect()}>{needsConsent ? m.online_connect_accept() : m.online_connect()}</Button>}
        {connected && needsConsent && policy && <div className="mt-4 border-t border-app-border pt-4"><h3 className="font-medium text-app-text">{m.online_reconsent_title()}</h3><div className="my-3 flex gap-4 text-sm"><a className="text-app-accent underline" href={policy.termsUrl} target="_blank" rel="noopener noreferrer">{m.online_terms()}</a><a className="text-app-accent underline" href={policy.privacyUrl} target="_blank" rel="noopener noreferrer">{m.online_privacy()}</a></div><label className="mb-3 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-app-accent" checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>{m.online_confirm_policy()}</span></label><Button variant="app-primary" disabled={!confirmed || pending} onClick={() => void consent()}>{m.online_accept_consent()}</Button></div>}
        {state && state.publicationWithdrawal.status !== "none" && <p role="status" className="mt-4 text-sm text-app-text-muted">{state.publicationWithdrawal.status === "pending" ? m.online_withdrawal_pending() : state.publicationWithdrawal.status === "failed" ? m.online_withdrawal_failed() : state.publicationWithdrawal.status === "unavailable" ? m.online_withdrawal_limited() : m.online_withdrawal_complete()}</p>}
        {state?.sync.status === "running" && <p role="status" className="mt-3 text-sm text-app-text-muted">{m.online_sync_running({ count: state.sync.queued })}</p>}
        {state?.sync.blockedBy && <p role="status" className="mt-3 text-sm text-app-text-muted">{m.online_sync_blocked({ reason: syncBlockMessages[state.sync.blockedBy]() })}</p>}
        {state?.sync.lastError && <p role="alert" className="mt-3 text-sm text-status-danger">{onlineErrorMessage(state.sync.lastError.code)}</p>}
        {!accountHidden && draftReady && (!connected || online.isMutating || state?.preferencePersistence !== "confirmed" || !!online.transportError) && <p role="status" className="mt-2 text-sm text-app-text-muted">{m.online_draft_only()} {visibilityLabels[draft.visibility]()} · {m.online_setup_title()}: {draft.setupUploads ? m.common_on() : m.common_off()}</p>}
        {onboarding && <div className="mt-5"><Button variant="outline" onClick={onSkip}>{m.online_skip()}</Button></div>}
      </>}
    </section>
  );
}

function PreferenceControl({ title, description, checked, disabled, onChange }: { title: string; description: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <div className="flex items-start justify-between gap-4 py-3"><div><p className="font-medium text-app-text">{title}</p><p className="mt-1 max-w-xl text-sm text-app-text-muted">{description}</p></div><Switch aria-label={title} checked={checked} disabled={disabled} onCheckedChange={onChange} /></div>;
}
