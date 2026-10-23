import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { iratingApi, type RatingHistory } from "./irating-api";
import { m } from "@/paraglide/messages";


const statusKey = ["iracing-rating", "status"] as const;
const historyKey = ["iracing-rating", "history"] as const;

function readableError(error: unknown): string {
  if (error instanceof Error && error.message.includes("409")) return m.irating_not_connected();
  return m.irating_request_failed();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function IRatingTracker() {
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(() => new URL("/api/iracing-rating/callback", window.location.origin).toString());
  const [saveError, setSaveError] = useState(false);
  const status = useQuery({ queryKey: statusKey, queryFn: iratingApi.status });
  const history = useQuery({ queryKey: historyKey, enabled: status.data?.connected === true, queryFn: iratingApi.history, retry: false });
  const save = useMutation({
    mutationFn: () => iratingApi.saveClient({ clientId, clientSecret, redirectUri }),
    onSuccess: async () => { setClientSecret(""); setClientId(""); setSaveError(false); await queryClient.invalidateQueries({ queryKey: statusKey }); },
    onError: () => { setClientSecret(""); setSaveError(true); },
  });
  const removeClient = useMutation({ mutationFn: iratingApi.removeClient, onSuccess: async () => { setClientSecret(""); await Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), queryClient.invalidateQueries({ queryKey: historyKey })]); } });
  const sync = useMutation({ mutationFn: iratingApi.sync, onSuccess: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), queryClient.invalidateQueries({ queryKey: historyKey })]); } });
  const disconnect = useMutation({ mutationFn: iratingApi.disconnect, onSuccess: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: statusKey }), queryClient.invalidateQueries({ queryKey: historyKey })]); } });
  const authorizationFailed = new URLSearchParams(window.location.search).get("rating") === "error";

  if (status.isLoading) return <main className="mx-auto max-w-5xl p-6" aria-busy="true"><p role="status">{m.irating_loading()}</p></main>;
  if (status.isError || !status.data) return <main className="mx-auto max-w-5xl space-y-4 p-6"><h1 className="text-2xl font-semibold">{m.irating_title()}</h1><p role="alert">{m.irating_request_failed()}</p><Button onClick={() => void status.refetch()}>{m.irating_retry()}</Button></main>;

  const data = status.data;
  const entriesByCategory = new Map<number, { name: string; entries: RatingHistory["entries"] }>();
  for (const entry of history.data?.entries ?? []) {
    const category = entriesByCategory.get(entry.categoryId) ?? { name: entry.categoryName, entries: [] };
    category.entries.push(entry);
    entriesByCategory.set(entry.categoryId, category);
  }

  return <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold">{m.irating_title()}</h1><p className="mt-1 text-app-text-secondary">{m.irating_description()}</p></div>{data.connected && <div className="text-sm text-app-text-secondary">{m.irating_connected_as()} <strong className="text-app-text">{data.displayName || data.customerId}</strong></div>}</header>
    {authorizationFailed && <p role="alert">{m.irating_auth_failed()}</p>}
    <Card className="space-y-4 p-4">
      <h2 className="text-lg font-medium">{m.irating_oauth_settings()}</h2>
      <p className="text-sm text-app-text-secondary">{m.irating_oauth_help()}</p>
      {data.configured && <p role="status" className="text-sm">{m.irating_credentials_configured()}</p>}
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void save.mutateAsync(); }}>
        <div className="space-y-1"><Label htmlFor="iracing-client-id">{m.irating_client_id()}</Label><input required id="iracing-client-id" autoComplete="off" value={clientId} onChange={(event) => setClientId(event.target.value)} className="w-full rounded border border-app-border bg-app-surface px-3 py-2" /></div>
        <div className="space-y-1"><Label htmlFor="iracing-client-secret">{m.irating_client_secret()}</Label><input required type="password" id="iracing-client-secret" autoComplete="new-password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} className="w-full rounded border border-app-border bg-app-surface px-3 py-2" /></div>
        <div className="space-y-1 sm:col-span-2"><Label htmlFor="iracing-redirect-uri">{m.irating_redirect_uri()}</Label><input required type="url" id="iracing-redirect-uri" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} className="w-full rounded border border-app-border bg-app-surface px-3 py-2" /></div>
        <div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit" disabled={save.isPending}>{save.isPending ? m.irating_saving() : m.irating_save_credentials()}</Button>{data.configured && <Button type="button" variant="app-ghost" disabled={removeClient.isPending} onClick={() => removeClient.mutate()}>{m.irating_remove_credentials()}</Button>}</div>
      </form>
      {(saveError || save.isError) && <p role="alert">{m.irating_save_failed()}</p>}{removeClient.isError && <p role="alert">{m.irating_request_failed()}</p>}
    </Card>
    {data.configured && <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-medium">{m.irating_connection()}</h2><p className="text-sm text-app-text-secondary">{data.connected ? m.irating_connected() : m.irating_disconnected()}</p></div><div className="flex flex-wrap gap-2">{!data.connected ? <Button onClick={() => { window.location.assign("/api/iracing-rating/authorize"); }}>{m.irating_connect()}</Button> : <><Button disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? m.irating_syncing() : m.irating_sync()}</Button><Button variant="app-ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>{m.irating_disconnect()}</Button></>}</div></div>
      {(sync.isError || disconnect.isError) && <p role="alert">{readableError(sync.error ?? disconnect.error)}</p>}
      {data.connected && <>
        <p className="text-sm text-app-text-secondary">{m.irating_last_synced()} {data.lastSyncedAt ? formatDate(data.lastSyncedAt) : m.irating_never_synced()}</p>
        {history.isLoading && <p role="status">{m.irating_loading()}</p>}
        {history.isError && <div role="alert" className="space-y-2"><p>{readableError(history.error)}</p><Button variant="app-ghost" onClick={() => void history.refetch()}>{m.irating_retry()}</Button></div>}
        {history.data && history.data.entries.length === 0 && <p className="text-sm text-app-text-secondary">{m.irating_empty_history()}</p>}
        {history.data && Array.from(entriesByCategory, ([categoryId, category]) => <section key={categoryId} className="space-y-2"><h3 className="font-medium">{category.name}</h3><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-app-border text-app-text-secondary"><th className="py-2 pr-4">{m.irating_date()}</th><th className="py-2 pr-4">{m.irating_rating()}</th><th className="py-2">{m.irating_change()}</th></tr></thead><tbody>{category.entries.map((entry) => <tr key={`${entry.categoryId}-${entry.observedAt}-${entry.irating}`} className="border-b border-app-border"><td className="py-2 pr-4">{formatDate(entry.observedAt)}</td><td className="py-2 pr-4 tabular-nums">{entry.irating}</td><td className={`py-2 tabular-nums ${entry.change == null ? "text-app-text-secondary" : entry.change > 0 ? "text-emerald-600" : entry.change < 0 ? "text-red-600" : "text-app-text-secondary"}`}>{entry.change == null ? "—" : `${entry.change > 0 ? "+" : ""}${entry.change}`}</td></tr>)}</tbody></table></div></section>)}
      </>}
    </Card>}
  </main>;
}
