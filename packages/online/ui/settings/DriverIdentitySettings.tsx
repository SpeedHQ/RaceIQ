import { useEffect, useState } from "react";
import type { GameIdentityCandidate } from "@raceiq/online/contracts";
import { onlineErrorMessage } from "../messages";
import { OnlineTimestamp } from "../components/OnlineTimestamp";
import { useOnlineHost } from "../hooks/raceiq-online";
import { useDriverBindings } from "../hooks/driver-bindings";

export function DriverIdentitySettings() {
  const { m } = useOnlineHost();
  const bindings = useDriverBindings();
  const state = bindings.online.state;
  return <section className="my-4 space-y-3 rounded-md border border-app-border p-4 text-sm" aria-label={m.online_identity_title()} aria-busy={bindings.isFetching || bindings.confirming}>
    <h3 className="font-medium text-app-text">{m.online_identity_title()}</h3>
    <p className="text-app-text-muted">{m.online_identity_description()}</p>
    {bindings.isPending && <p role="status">{m.online_loading()}</p>}
    {(bindings.isError || !bindings.data && !bindings.isPending) && <p role="status">{m.online_queue_unavailable()}</p>}
    {bindings.confirmationError && <p role="alert" className="text-status-danger">{m.online_transport_error()}</p>}
    {bindings.result && !bindings.result.ok && <p role="alert" className="text-status-danger">{onlineErrorMessage(bindings.result.error.code, m)}</p>}
    {bindings.data && <>
      <ul className="space-y-2">{bindings.data.bindings.map((binding) => <li key={binding.gameId} className="flex flex-wrap justify-between gap-2 border-b border-app-border pb-2">
        <span className="break-words font-medium">{binding.gameId}</span>
        <span>{binding.confirmation === "native_verified" ? m.online_identity_native() : m.online_identity_user_confirmed()}</span>
        <span className="w-full break-words text-xs text-app-text-muted">{m.online_identity_source({ source: binding.sourceKind })} · {m.online_identity_revision({ revision: binding.revision })}</span>
      </li>)}</ul>
      {bindings.data.candidates.length === 0 && <p role="status" className="text-app-text-muted">{m.online_identity_no_candidate()}</p>}
      {bindings.data.candidates.map((candidate) => <IdentityCandidate key={`${state?.accountEpoch}:${state?.revision}:${candidate.candidateId}:${candidate.expiresAt}`} candidate={candidate} disabled={!bindings.canConfirm} onConfirm={() => bindings.confirm(candidate.candidateId)} />)}
    </>}
  </section>;
}

function IdentityCandidate({ candidate, disabled, onConfirm }: { candidate: GameIdentityCandidate; disabled: boolean; onConfirm: () => void }) {
  const { Button, m } = useOnlineHost();
  const [confirmed, setConfirmed] = useState(false);
  const expiresAt = Date.parse(candidate.expiresAt);
  const [expired, setExpired] = useState(() => !Number.isFinite(expiresAt) || expiresAt <= Date.now());
  useEffect(() => {
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setExpired(true); return; }
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  return <div className="space-y-2 rounded-md border border-app-border bg-app-surface-alt/40 p-3">
    <p className="break-words font-medium">{candidate.gameId}</p>
    <p className="break-words text-app-text-muted">{m.online_identity_source({ source: candidate.sourceKind })}</p>
    <p className="text-xs text-app-text-muted">{m.online_identity_expires()} <OnlineTimestamp value={candidate.expiresAt} /></p>
    {expired ? <p role="status">{m.online_identity_expired()}</p> : <>
      <label className="flex items-start gap-3"><input className="mt-1 accent-app-accent" type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>{m.online_identity_confirm_label()}</span></label>
      <Button variant="outline" size="sm" disabled={disabled || !confirmed} onClick={onConfirm}>{m.online_identity_confirm_action()}</Button>
    </>}
  </div>;
}
