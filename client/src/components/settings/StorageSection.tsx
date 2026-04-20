import { useQuery, useMutation } from "@tanstack/react-query";
import { HardDrive, Loader2 } from "lucide-react";

interface SessionStorageStats {
  total: number;
  binCount: number;
  gzCount: number;
  totalBytes: number;
  binBytes: number;
  gzBytes: number;
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
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <span className="text-sm text-white/60">{label}</span>
      <span className="text-sm font-medium text-white">{value}</span>
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

  // gz arc (compressed, blue) starts at top (-90deg), bin arc follows
  const gzDash = gzFraction * circumference;
  const binDash = binFraction * circumference;
  const binOffset = -(gzFraction * circumference);

  return (
    <div className="flex items-center gap-6">
      <svg width="120" height="120" viewBox="0 0 120 120">
        {/* gz segment */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="16"
          strokeDasharray={`${gzDash} ${circumference - gzDash}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="butt"
        />
        {/* bin segment */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="#ffffff22"
          strokeWidth="16"
          strokeDasharray={`${binDash} ${circumference - binDash}`}
          strokeDashoffset={circumference / 4 + binOffset}
          strokeLinecap="butt"
        />
        {/* center label */}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="white" fontSize="18" fontWeight="600">{total}</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="10">files</text>
      </svg>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-sm bg-blue-500 flex-shrink-0" />
          <span className="text-xs text-white/70">Compressed</span>
          <span className="text-xs font-medium text-white ml-auto pl-4">{gzCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="size-3 rounded-sm bg-white/20 flex-shrink-0" />
          <span className="text-xs text-white/70">Uncompressed</span>
          <span className="text-xs font-medium text-white ml-auto pl-4">{binCount}</span>
        </div>
      </div>
    </div>
  );
}

export function StorageSection() {
  const { data, isLoading, isError, refetch } = useQuery<SessionStorageStats>({
    queryKey: ["storage", "sessions"],
    queryFn: () => fetch("/api/storage/sessions").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const compress = useMutation({
    mutationFn: () => fetch("/api/storage/compress", { method: "POST" }).then((r) => r.json()),
    onSuccess: () => void refetch(),
  });

  return (
    <section className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
          <HardDrive className="size-4 text-white/40" />
          Recording Files
        </h3>
        <p className="text-xs text-white/40 mb-4">
          Raw session recordings stored in <code className="font-mono">data/sessions/</code>.
          Files older than 24 hours are automatically compressed in the background.
        </p>
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {isError && <p className="text-sm text-red-400">Failed to load storage stats.</p>}
        {data && data.total > 0 && (
          <div className="mb-5">
            <DonutChart binCount={data.binCount} gzCount={data.gzCount} />
          </div>
        )}
        {data && (
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 divide-y divide-white/5">
            <StatRow label="Total size" value={fmt(data.totalBytes)} />
            <StatRow
              label="Uncompressed (.bin)"
              value={data.binCount > 0 ? `${data.binCount} file${data.binCount !== 1 ? "s" : ""} — ${fmt(data.binBytes)}` : "None"}
            />
            <StatRow
              label="Compressed (.bin.gz)"
              value={data.gzCount > 0 ? `${data.gzCount} file${data.gzCount !== 1 ? "s" : ""} — ${fmt(data.gzBytes)}` : "None"}
            />
            {data.binCount > 0 && data.gzCount > 0 && (
              <StatRow
                label="Space saved"
                value={`${((1 - data.gzBytes / (data.gzBytes + data.binBytes)) * 100).toFixed(0)}%`}
              />
            )}
            {data.diskTotal > 0 && (
              <>
                <StatRow label="Disk total" value={fmt(data.diskTotal)} />
                <StatRow label="Disk free" value={fmt(data.diskFree)} />
              </>
            )}
          </div>
        )}
        {data && data.total === 0 && (
          <p className="text-sm text-white/40">No recording files yet.</p>
        )}
        {data && data.binCount > 0 && (
          <div className="mt-4">
            <button
              onClick={() => compress.mutate()}
              disabled={compress.isPending}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-white/10 hover:bg-white/15 text-white disabled:opacity-50 transition-colors"
            >
              {compress.isPending && <Loader2 className="size-3 animate-spin" />}
              Compress now
            </button>
            {compress.isSuccess && <p className="text-xs text-white/40 mt-2">Compression complete.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
