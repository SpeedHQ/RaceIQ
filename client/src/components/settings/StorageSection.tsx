import type { SessionCleanupRequest, SessionCleanupResult } from "@raceiq/shared/racing/sessions/cleanup"
import type { SessionDownsampleRequest } from "@raceiq/shared/racing/sessions/downsample"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SessionCleanupDialog } from "@/components/SessionCleanupDialog";
import { SessionDownsampleDialog } from "@/components/SessionDownsampleDialog";
import { useRecordingDirectoryStatus } from "@/hooks/recording-storage";
import { useSessionDownsampleStatus } from "@/hooks/session-downsample";
import { queryKeys } from "@/hooks/query-keys";
import { RecordingDirectoryControl } from "./RecordingDirectoryControl";
import { RecordingLayoutMigration } from "@/components/RecordingLayoutMigration";
import { SessionDownsampleSkipSummary } from "@/components/SessionDownsampleSkipSummary";
import { RecordingRetentionControls } from "./RecordingRetentionControls";
import { m } from "@/paraglide/messages";
import { formatBytes } from "@/lib/format-bytes";
import { authenticatedFetch, client } from "@/lib/rpc";
import { useSaveSettings, useSettings } from "../../hooks/settings";
interface CacheStatus {
  bytesUsed: number;
  maxBytes: number;
  entries: number;
}

interface GameStorageStats {
  binCount: number;
  gzCount: number;
  binBytes: number;
  gzBytes: number;
}

interface SessionStorageStats {
  total: number;
  binCount: number;
  gzCount: number;
  totalBytes: number;
  binBytes: number;
  gzBytes: number;
  byGame: Record<string, GameStorageStats>;
  diskTotal: number;
  diskFree: number;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-app-border/50 last:border-0">
      <span className="text-sm text-app-text-secondary">{label}</span>
      <span className="text-sm font-medium text-app-text">{value}</span>
    </div>
  );
}


function GameBreakdown({ gameId, stats }: { gameId: string; stats: GameStorageStats }) {
  const total = stats.binCount + stats.gzCount;
  const totalBytes = stats.binBytes + stats.gzBytes;
  return (
    <div className="rounded-lg border border-app-border bg-app-surface-alt/50 px-4 py-3 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-app-text uppercase tracking-wide">{gameId}</span>
        <span className="text-xs text-app-text-dim">
          {total} {m.storage_file_count()} — {formatBytes(totalBytes)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-app-text-muted flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-app-text/20 inline-block" />
          {m.storage_uncompressed()}
        </span>
        <span className="text-xs text-app-text-secondary">{stats.binCount > 0 ? `${stats.binCount} — ${formatBytes(stats.binBytes)}` : "—"}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-app-text-muted flex items-center gap-1.5">
          <span className="size-2 rounded-sm inline-block" style={{ backgroundColor: "var(--storage-compressed)" }} />
          {m.storage_compressed()}
        </span>
        <span className="text-xs text-app-text-secondary">{stats.gzCount > 0 ? `${stats.gzCount} — ${formatBytes(stats.gzBytes)}` : "—"}</span>
      </div>
    </div>
  );
}

function CacheSection() {
  const { displaySettings } = useSettings();
  const saveSettings = useSaveSettings();
  const [draftMB, setDraftMB] = useState(String(displaySettings.cacheMaxMB ?? 256));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    setDraftMB(String(displaySettings.cacheMaxMB ?? 256));
  }, [displaySettings.cacheMaxMB]);

  const { data: cache, isError: cacheError } = useQuery<CacheStatus>({
    queryFn: async () => {
      const response = await fetch("/api/cache/status");
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json() as Promise<CacheStatus>;
    },
    queryKey: queryKeys.cacheStatus,
    refetchInterval: 5_000,
  });

  const usedFraction = cache && cache.maxBytes > 0 ? Math.min(1, cache.bytesUsed / cache.maxBytes) : 0;
  const usedPct = (usedFraction * 100).toFixed(1);

  const onSave = () => {
    const n = Number(draftMB);
    if (!Number.isFinite(n) || n < 16 || n > 2048) {
      setStatus("error");
      setErrorMsg(m.storage_cache_range_error());
      return;
    }
    setStatus("saving");
    setErrorMsg("");
    saveSettings.mutate(
      { cacheMaxMB: n },
      {
        onSuccess: () => {
          setStatus("saved");
          setTimeout(() => setStatus("idle"), 1500);
        },
        onError: (e) => {
          setStatus("error");
          setErrorMsg(e instanceof Error ? e.message : m.storage_save_failed());
        },
      },
    );
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-app-text mb-1 flex items-center gap-2">
        <Database className="size-4 text-app-text-dim" />
        {m.storage_cache_title()}
      </h3>
      <p className="text-xs text-app-text-dim mb-4">{m.storage_cache_desc()}</p>
      {cacheError && (
        <p className="text-sm text-status-danger" role="alert">
          {m.storage_load_failed()}
        </p>
      )}

      {cache && (
        <div className="rounded-lg border border-app-border bg-app-surface-alt/50 px-4 py-3 mb-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-app-text-secondary">{m.storage_used()}</span>
            <span className="text-sm font-medium text-app-text">
              {formatBytes(cache.bytesUsed)} / {formatBytes(cache.maxBytes)} <span className="text-app-text-dim">({usedPct}%)</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-app-text/10 overflow-hidden">
            <div className="h-full transition-all" style={{ backgroundColor: "var(--storage-compressed)", width: `${usedFraction * 100}%` }} />
          </div>
          <div className="flex items-center justify-between pt-1 text-xs text-app-text-muted">
            <span>
              {cache.entries} {m.storage_cached_laps()}
            </span>
          </div>
        </div>
      )}
      <div className="max-w-xs">
        <Label htmlFor="cache-size-limit" className="text-app-text-secondary">
          {m.storage_cache_size_limit()}
        </Label>
        <div className="mt-1.5 flex items-center gap-2">
          <Input id="cache-size-limit" type="number" min={16} max={2048} value={draftMB} onChange={(e) => setDraftMB(e.target.value)} className="bg-app-surface border border-app-border-input" />
          <Button onClick={onSave} disabled={status === "saving" || draftMB === String(displaySettings.cacheMaxMB)} size="sm">
            {status === "saving" ? m.common_saving() : m.common_save()}
          </Button>
        </div>
        {status === "saved" && <p className="text-xs text-status-success mt-2">{m.storage_saved()}</p>}
        {status === "error" && <p className="text-xs text-status-danger mt-2">{errorMsg}</p>}
        <p className="text-xs text-app-text-dim mt-2">{m.storage_cache_range_hint()}</p>
      </div>
    </div>
  );
}

function StorageFilesSection() {
  const { data, isLoading, isError, refetch } = useQuery<SessionStorageStats>({
    queryFn: async () => {
      const response = await client.api.storage.sessions.$get();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json() as Promise<SessionStorageStats>;
    },
    queryKey: queryKeys.storageSessions,
    refetchInterval: 30_000,
  });
  const queryClient = useQueryClient();
  const [cleanupRequest, setCleanupRequest] = useState<SessionCleanupRequest | null>(null);
  const [downsampleOpen, setDownsampleOpen] = useState(false);
  const [retryRequest, setRetryRequest] = useState<SessionDownsampleRequest | null>(null);
  const downsampleQuery = useSessionDownsampleStatus();
  const downsampleStatus = downsampleQuery.data;
  const busy = downsampleStatus?.status === "running";
  const operationBlocked = busy || downsampleQuery.isLoading || downsampleQuery.isError;
  const directoryStatus = useRecordingDirectoryStatus();
  const movingDirectory = directoryStatus.data?.state === "moving";

  const compress = useMutation({
    mutationFn: async () => {
      const response = await authenticatedFetch("/api/storage/compress", { method: "POST" });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error
          : `${response.status} ${response.statusText}`;
        throw new Error(message);
      }
      return response.json();
    },
    onSuccess: () => void refetch(),
  });
  const completeCleanup = (result: SessionCleanupResult) => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
      queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
      queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.userTunes }),
    ]);
    if (result.failed.length === 0) setCleanupRequest(null);
  };

  const gameEntries = data?.byGame
    ? Object.entries(data.byGame).filter(([, stats]) => stats.binCount + stats.gzCount > 0)
    : [];

  return (
    <section className="space-y-6">
      <div>
        <div className="mb-1 flex items-center justify-between gap-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-app-text">
            <HardDrive className="size-4 text-app-text-dim" aria-hidden="true" />
            {m.storage_recording_files_title()}
          </h3>
        </div>
        {data && !isLoading && <p className="mb-4 text-sm font-medium text-app-text">{m.storage_recording_summary({ files: data.total, size: formatBytes(data.totalBytes) })}</p>}
        <RecordingDirectoryControl disabled={isLoading || isError || operationBlocked || movingDirectory} />
        
        <p className="my-3 text-sm text-app-text-secondary">{m.storage_recording_files_desc_suffix()}</p>
        <fieldset disabled={operationBlocked} className="min-w-0">
          <RecordingLayoutMigration compact />
        </fieldset>
        {isLoading && <p className="text-sm text-app-text-dim">{m.common_loading()}</p>}
        {isError && (
          <p className="text-sm text-status-danger" role="alert">
            {m.storage_load_failed()}
          </p>
        )}
        {data && (
          <div className="rounded-lg border border-app-border bg-app-surface-alt/50 px-4 divide-y divide-app-border/50 mb-4">
            <StatRow label={m.storage_total_size()} value={formatBytes(data.totalBytes)} />
            <StatRow label={m.storage_uncompressed_bin()} value={data.binCount > 0 ? `${data.binCount} ${m.storage_file_count()} — ${formatBytes(data.binBytes)}` : m.label_none()} />
            <StatRow label={m.storage_compressed_gz()} value={data.gzCount > 0 ? `${data.gzCount} ${m.storage_file_count()} — ${formatBytes(data.gzBytes)}` : m.label_none()} />
            {data.binCount > 0 && data.gzCount > 0 && <StatRow label={m.storage_space_saved()} value={`${((1 - data.gzBytes / (data.gzBytes + data.binBytes)) * 100).toFixed(0)}%`} />}
            {data.diskTotal > 0 && (
              <>
                <StatRow label={m.storage_disk_total()} value={formatBytes(data.diskTotal)} />
                <StatRow label={m.storage_disk_free()} value={formatBytes(data.diskFree)} />
              </>
            )}
          </div>
        )}
        {gameEntries.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-app-text-dim uppercase tracking-wide">{m.storage_by_game()}</p>
            {gameEntries.map(([gameId, stats]) => (
              <GameBreakdown key={gameId} gameId={gameId} stats={stats} />
            ))}
          </div>
        )}
        <SessionCleanupDialog request={cleanupRequest} onClose={() => setCleanupRequest(null)} onCompleted={completeCleanup} />
        {downsampleOpen && <SessionDownsampleDialog key={JSON.stringify(retryRequest)} open={downsampleOpen} busy={operationBlocked} initialRequest={retryRequest} onClose={() => { setDownsampleOpen(false); setRetryRequest(null); }} onStarted={() => { setRetryRequest(null); void downsampleQuery.refetch(); }} />}
        {downsampleQuery.isLoading && <p role="status" className="text-sm text-app-text-dim">{m.common_loading()}</p>}
        {downsampleQuery.isError && <p role="alert" className="text-sm text-status-danger">{m.storage_load_failed()} {downsampleQuery.error.message}</p>}
        {downsampleStatus && downsampleStatus.status !== "idle" && <section aria-live="polite" aria-label={busy ? m.storage_downsample_running() : undefined} className="my-4 flex flex-col gap-2 border-y border-app-border py-3">
          <p className={busy ? "font-medium text-app-text" : downsampleStatus.status === "success" ? "font-medium text-status-success" : "font-medium text-status-danger"}>{busy ? m.storage_downsample_running() : downsampleStatus.status === "success" ? m.storage_downsample_success() : downsampleStatus.status === "partial" ? m.storage_downsample_partial() : m.storage_downsample_error()}</p>
          <p className="text-sm text-app-text-secondary">{m.storage_downsample_progress({ done: downsampleStatus.done, total: downsampleStatus.total })}</p>
          <p className="text-sm text-app-text-secondary">{m.storage_downsample_results({ files: downsampleStatus.convertedFiles, size: formatBytes(downsampleStatus.freedBytes) })}</p>
          {downsampleStatus.error && <p role="alert" className="text-sm text-status-danger">{downsampleStatus.error}</p>}
          <SessionDownsampleSkipSummary skips={downsampleStatus.skipped} title={m.storage_downsample_skipped()} />
          {downsampleStatus.failed.length > 0 && <div role="alert"><p className="text-sm font-medium">{m.storage_downsample_failed()}</p><ul className="text-sm text-status-danger">{downsampleStatus.failed.map((item, index) => <li key={`${item.sessionIds.join("-")}-${index}`}>{item.message}</li>)}</ul></div>}
          {!busy && (downsampleStatus.status === "partial" || downsampleStatus.status === "error") && downsampleStatus.request && <Button variant="app-outline" size="app-sm" disabled={operationBlocked} onClick={() => { setRetryRequest(downsampleStatus.request); setDownsampleOpen(true); }}>{m.storage_downsample_retry()}</Button>}
        </section>}
        {data && data.total === 0 && <p className="text-sm text-app-text-dim">{m.storage_no_files()}</p>}
        {data && data.binCount > 0 && (
          <div className="mt-4">
            <Button
              onClick={() => compress.mutate()}
              disabled={compress.isPending || movingDirectory || operationBlocked}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-app-surface-alt hover:bg-app-surface-hover/60 text-app-text disabled:opacity-50 transition-colors"
            >
              {compress.isPending && <Loader2 className="size-3 animate-spin" />}
              {m.storage_compress_now()}
            </Button>
            {compress.isSuccess && <p className="text-xs text-status-success mt-2">{m.storage_compress_complete()}</p>}
            {compress.isError && <p role="alert" className="text-xs text-status-danger mt-2">{compress.error.message}</p>}
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2 border-t border-app-border pt-5">
          <Button variant="app-outline" size="app-sm" disabled={operationBlocked || movingDirectory || isLoading} onClick={() => { setRetryRequest(null); setDownsampleOpen(true); }}>{m.storage_downsample_action()}</Button>
          <Button variant="app-outline" size="app-sm" disabled={operationBlocked || movingDirectory} onClick={() => setCleanupRequest({ mode: "older-than", olderThanDays: 30 })}>{m.sessions_cleanup_free_space()}</Button>
        </div>
        <RecordingRetentionControls disabled={operationBlocked} />
        
      </div>
    </section>
  );
}

export function StorageSection() {
  return (
    <Tabs defaultValue="cache" className="flex flex-col gap-5">
      <TabsList variant="underline" aria-label={m.storage_category_tabs_label()}>
        <TabsTrigger value="cache" variant="underline">
          {m.storage_category_cache()}
        </TabsTrigger>
        <TabsTrigger value="storage" variant="underline">
          {m.storage_category_storage()}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="cache">
        <CacheSection />
      </TabsContent>
      <TabsContent value="storage">
        <StorageFilesSection />
      </TabsContent>
    </Tabs>
  );
}
