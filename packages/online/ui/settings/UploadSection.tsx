import { useRef, useState } from "react";
import type { DeliveryStatus, OnlineSyncBlock, PublicationStatus, ValidationStatus, UploadItem } from "@raceiq/online/contracts";
import type { OnlineMessages } from "../../contracts/ui-host";
import { onlineErrorMessage } from "../messages";
import { useOnlineUploads } from "../hooks/online-activity";
import { useOnlineHost, useRaceIqOnline } from "../hooks/raceiq-online";
import { OnlineTimestamp } from "../components/OnlineTimestamp";

function getDeliveryLabels(m: OnlineMessages): Record<DeliveryStatus, () => string> {
  return {
    queued: m.online_queue_queued, awaiting: m.online_queue_queued, preparing: m.online_delivery_preparing, uploading: m.online_queue_uploading,
    retry_wait: m.online_delivery_retry_wait, blocked: m.online_queue_blocked, ambiguous: m.online_delivery_ambiguous,
    accepted: m.online_delivery_accepted, rejected: m.online_queue_rejected, withdrawn: m.online_delivery_withdrawn, superseded: m.online_delivery_superseded,
  };
}
function getValidationLabels(m: OnlineMessages): Record<ValidationStatus, () => string> {
  return { not_requested: m.online_not_requested, pending: m.online_validation_pending, validated: m.online_validation_validated, rejected: m.online_queue_rejected, unavailable: m.online_queue_unavailable };
}
function getPublicationLabels(m: OnlineMessages): Record<PublicationStatus, () => string> {
  return { not_requested: m.online_not_requested, pending: m.online_publication_pending, public: m.online_publication_public, withdrawn: m.online_delivery_withdrawn, failed: m.online_publication_failed, unavailable: m.online_queue_unavailable };
}
function getBlockLabels(m: OnlineMessages): Record<OnlineSyncBlock, () => string> {
  return { signed_out: m.online_block_signed_out, consent_required: m.online_block_consent_required, private: m.online_block_private, preferences_unconfirmed: m.online_block_preferences_unconfirmed, offline: m.online_block_offline, service_unavailable: m.online_block_service_unavailable, account_unavailable: m.online_block_account_unavailable };
}

export function UploadSection({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { Button, m } = useOnlineHost();
  const blockLabels = getBlockLabels(m);
  const online = useRaceIqOnline();
  const state = online.state;
  const sync = state?.sync;
  const stale = online.isCachedState || !!online.transportError && !!state;
  const accountEpoch = useRef(state?.accountEpoch);
  if (state?.accountEpoch) accountEpoch.current = state.accountEpoch;
  const contextKey = accountEpoch.current;

  return <section className="max-w-4xl space-y-5" aria-label={m.online_upload_title()}>
    <header><h2 className="text-lg font-semibold text-app-text">{m.online_upload_title()}</h2><p className="mt-1 text-sm text-app-text-muted">{m.online_upload_description()}</p></header>
    <Button variant="outline" size="sm" onClick={onOpenAccount}>{m.online_upload_account_settings()}</Button>
    <div className="rounded-md border border-app-border p-4 text-sm" role="status">
      <p className="font-medium">{stale || !state || state.service !== "available" ? m.online_queue_unavailable() : sync?.status === "blocked" ? m.online_queue_blocked() : m.online_queue_idle()}</p>
      {stale && <p className="mt-1 text-app-text-muted">{m.online_queue_stale()}</p>}
      {state?.service === "offline" && <p>{m.online_block_offline()}</p>}
      {state?.connection.status === "signed_out" && <p>{m.online_block_signed_out()}</p>}
      {sync?.blockedBy && <p className="mt-2">{m.online_sync_blocked({ reason: blockLabels[sync.blockedBy]() })}</p>}
      {sync && <p className="mt-2">{m.online_queue_queued()}: {sync.queued ?? m.online_queue_unknown()} · {m.online_queue_in_flight()}: {sync.inFlight ?? m.online_queue_unknown()} · {m.online_queue_rejected()}: {sync.rejected ?? m.online_queue_unknown()}</p>}
      {sync && <p className="mt-1">{m.online_queue_last_synced()}: {sync.lastSyncedAt ? <OnlineTimestamp value={sync.lastSyncedAt} /> : state?.service === "unavailable" || sync.lastError ? m.online_queue_unknown() : m.online_queue_never_synced()}</p>}
      {sync?.lastError && <p className="mt-1 text-status-danger">{onlineErrorMessage(sync.lastError.code, m)}</p>}
    </div>
    <p className="text-sm text-app-text-muted">{m.online_upload_automatic_note()} {m.online_queue_acceptance_note()}</p>
    <UploadPages key={contextKey} />
  </section>;
}

function UploadPages() {
  const { Button, m } = useOnlineHost();
  const [view, setView] = useState<"queue" | "history">("queue");
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2" role="group" aria-label={m.online_upload_title()}>
      <Button variant={view === "queue" ? "app-primary" : "outline"} aria-pressed={view === "queue"} onClick={() => setView("queue")}>{m.online_queue_title()}</Button>
      <Button variant={view === "history" ? "app-primary" : "outline"} aria-pressed={view === "history"} onClick={() => setView("history")}>{m.online_upload_history()}</Button>
    </div>
    <UploadPageView key={view} view={view} />
  </div>;
}

function UploadPageView({ view }: { view: "queue" | "history" }) {
  const { Button, m } = useOnlineHost();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const query = useOnlineUploads(view, cursors[cursors.length - 1]);
  const page = query.data;
  return <section aria-busy={query.isFetching} className="space-y-3">
    {query.isLoading && !page && <p role="status">{m.online_queue_checking()}</p>}
    {(query.isError || !page && !query.isLoading) && <p role="alert">{m.online_queue_unavailable()}</p>}
    {page?.stale && <p role="status" className="text-sm text-status-warning">{m.online_queue_stale()}</p>}
    {page && <p className="text-xs text-app-text-muted">{m.online_upload_observed()} <OnlineTimestamp value={page.observedAt} /></p>}
    {page?.items.length === 0 && !query.isError && <p role="status">{view === "queue" ? m.online_queue_empty() : m.online_upload_history_empty()}</p>}
    <ul className="space-y-3">{page?.items.map((item) => <UploadRow key={item.id} item={item} />)}</ul>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors((current) => current.slice(0, -1))}>{m.online_page_previous()}</Button>
      <Button variant="outline" size="sm" disabled={!page?.nextCursor || query.isFetching} onClick={() => { if (page?.nextCursor) setCursors((current) => [...current, page.nextCursor]); }}>{m.online_page_next()}</Button>
    </div>
  </section>;
}

function UploadRow({ item }: { item: UploadItem }) {
  const { m } = useOnlineHost();
  const deliveryLabels = getDeliveryLabels(m);
  const validationLabels = getValidationLabels(m);
  const publicationLabels = getPublicationLabels(m);
  return <li className="rounded-md border border-app-border p-4 text-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="font-medium">{m.online_upload_lap()}</h4><span>{deliveryLabels[item.delivery]()}</span></div>
    <p className="mt-1 break-words text-app-text-muted">{[item.gameId, item.trackId, item.carId].map((value) => value ?? m.online_queue_unknown()).join(" · ")}</p>
    <p className="mt-1 break-all text-xs">{m.online_upload_guid({ guid: item.lapGuid ?? m.online_queue_unknown() })}</p>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
      <div><dt className="text-app-text-muted">{m.online_upload_updated()}</dt><dd><OnlineTimestamp value={item.updatedAt} /></dd></div>
      <div><dt className="text-app-text-muted">{m.online_upload_attempts()}</dt><dd>{item.attemptCount ?? m.online_queue_unknown()}</dd></div>
      {item.nextAttemptAt && <div><dt className="text-app-text-muted">{m.online_upload_retry_at()}</dt><dd><OnlineTimestamp value={item.nextAttemptAt} /></dd></div>}
      {item.acceptedAt && <div><dt className="text-app-text-muted">{m.online_upload_last_receipt()}</dt><dd><OnlineTimestamp value={item.acceptedAt} /></dd></div>}
      <div><dt className="text-app-text-muted">{m.online_upload_validation()}</dt><dd>{validationLabels[item.validation]()}</dd></div>
      <div><dt className="text-app-text-muted">{m.online_upload_publication()}</dt><dd>{publicationLabels[item.publication]()}</dd></div>
    </dl>
    {item.error && <p className="mt-2 text-status-danger">{onlineErrorMessage(item.error.code, m)}</p>}
  </li>;
}
