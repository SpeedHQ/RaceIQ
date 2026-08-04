import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, HardDrive, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages";
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

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-app-border/50 last:border-0">
      <span className="text-sm text-app-text-secondary">{label}</span>
      <span className="text-sm font-medium text-app-text">{value}</span>
    </div>
  );
}

function DonutChart({ binCount, gzCount }: { binCount: number; gzCount: number }) {
  const total = binCount + gzCount;
  if (total === 0) return null;

  const r = 40;
  const cx = 60;
  const cy = 60;
  const circumference = 2 * Math.PI * r;
  const gzFraction = gzCount / total;
  const binFraction = binCount / total;

  const gzDash = gzFraction * circumference;
  const binDash = binFraction * circumference;
  const binOffset = -(gzFraction * circumference);

  return (
    <div className="flex items-center gap-6">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--storage-compressed)"
          strokeWidth="16"
          strokeDasharray={`${gzDash} ${circumference - gzDash}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="butt"
        />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--app-text)"
          strokeOpacity={0.13}
          strokeWidth="16"
          strokeDasharray={`${binDash} ${circumference - binDash}`}
          strokeDashoffset={circumference / 4 + binOffset}
          strokeLinecap="butt"
        />
        <text x={cx} y={cy - 6} textAnchor="middle" fill="var(--app-text)" fontSize="18" fontWeight="var(--font-weight-semibold)">
          {total}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--app-text)" fillOpacity={0.4} fontSize="10">
          {m.storage_files()}
        </text>
      </svg>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-sm flex-shrink-0" style={{ backgroundColor: "var(--storage-compressed)" }} />
          <span className="text-xs text-app-text-secondary">{m.storage_compressed()}</span>
          <span className="text-xs font-medium text-app-text ml-auto pl-4">{gzCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-sm bg-app-text/20 flex-shrink-0" />
          <span className="text-xs text-app-text-secondary">{m.storage_uncompressed()}</span>
          <span className="text-xs font-medium text-app-text ml-auto pl-4">{binCount}</span>
        </div>
      </div>
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
          {total} {m.storage_file_count()} — {fmt(totalBytes)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-app-text-muted flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-app-text/20 inline-block" />
          {m.storage_uncompressed()}
        </span>
        <span className="text-xs text-app-text-secondary">{stats.binCount > 0 ? `${stats.binCount} — ${fmt(stats.binBytes)}` : "—"}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-app-text-muted flex items-center gap-1.5">
          <span className="size-2 rounded-sm inline-block" style={{ backgroundColor: "var(--storage-compressed)" }} />
          {m.storage_compressed()}
        </span>
        <span className="text-xs text-app-text-secondary">{stats.gzCount > 0 ? `${stats.gzCount} — ${fmt(stats.gzBytes)}` : "—"}</span>
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
    queryKey: ["cache", "status"],
    queryFn: async () => {
      const response = await fetch("/api/cache/status");
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json() as Promise<CacheStatus>;
    },
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
              {fmt(cache.bytesUsed)} / {fmt(cache.maxBytes)} <span className="text-app-text-dim">({usedPct}%)</span>
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

export function StorageSection() {
  const { data, isLoading, isError, refetch } = useQuery<SessionStorageStats>({
    queryKey: ["storage", "sessions"],
    queryFn: async () => {
      const response = await fetch("/api/storage/sessions");
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json() as Promise<SessionStorageStats>;
    },
    refetchInterval: 30_000,
  });

  const compress = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/storage/compress", { method: "POST" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    },
    onSuccess: () => void refetch(),
  });

  const gameEntries = data?.byGame ? Object.entries(data.byGame) : [];

  return (
    <section className="space-y-6">
      <CacheSection />
      <div>
        <h3 className="text-sm font-semibold text-app-text mb-1 flex items-center gap-2">
          <HardDrive className="size-4 text-app-text-dim" />
          {m.storage_recording_files_title()}
        </h3>
        <p className="text-xs text-app-text-dim mb-4">
          {m.storage_recording_files_desc_prefix()} <code className="font-mono">data/sessions/</code>. {m.storage_recording_files_desc_suffix()}
        </p>
        {isLoading && <p className="text-sm text-app-text-dim">{m.common_loading()}</p>}
        {isError && (
          <p className="text-sm text-status-danger" role="alert">
            {m.storage_load_failed()}
          </p>
        )}
        {data && data.total > 0 && (
          <div className="mb-5">
            <DonutChart binCount={data.binCount} gzCount={data.gzCount} />
          </div>
        )}
        {data && (
          <div className="rounded-lg border border-app-border bg-app-surface-alt/50 px-4 divide-y divide-app-border/50 mb-4">
            <StatRow label={m.storage_total_size()} value={fmt(data.totalBytes)} />
            <StatRow label={m.storage_uncompressed_bin()} value={data.binCount > 0 ? `${data.binCount} ${m.storage_file_count()} — ${fmt(data.binBytes)}` : m.label_none()} />
            <StatRow label={m.storage_compressed_gz()} value={data.gzCount > 0 ? `${data.gzCount} ${m.storage_file_count()} — ${fmt(data.gzBytes)}` : m.label_none()} />
            {data.binCount > 0 && data.gzCount > 0 && <StatRow label={m.storage_space_saved()} value={`${((1 - data.gzBytes / (data.gzBytes + data.binBytes)) * 100).toFixed(0)}%`} />}
            {data.diskTotal > 0 && (
              <>
                <StatRow label={m.storage_disk_total()} value={fmt(data.diskTotal)} />
                <StatRow label={m.storage_disk_free()} value={fmt(data.diskFree)} />
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
        {data && data.total === 0 && <p className="text-sm text-app-text-dim">{m.storage_no_files()}</p>}
        {data && data.binCount > 0 && (
          <div className="mt-4">
            <button
              onClick={() => compress.mutate()}
              disabled={compress.isPending}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-app-surface-alt hover:bg-app-surface-hover/60 text-app-text disabled:opacity-50 transition-colors"
            >
              {compress.isPending && <Loader2 className="size-3 animate-spin" />}
              {m.storage_compress_now()}
            </button>
            {compress.isSuccess && <p className="text-xs text-status-success mt-2">{m.storage_compress_complete()}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
