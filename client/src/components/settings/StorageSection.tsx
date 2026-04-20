import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";

interface SessionStorageStats {
  total: number;
  binCount: number;
  gzCount: number;
  totalBytes: number;
  binBytes: number;
  gzBytes: number;
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

export function StorageSection() {
  const { data, isLoading, isError } = useQuery<SessionStorageStats>({
    queryKey: ["storage", "sessions"],
    queryFn: () => fetch("/api/storage/sessions").then((r) => r.json()),
    refetchInterval: 30_000,
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
        {data && (
          <div className="rounded-lg border border-white/10 bg-white/5 px-4 divide-y divide-white/5">
            <StatRow label="Total files" value={String(data.total)} />
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
                label="Compression ratio"
                value={`${((1 - data.gzBytes / (data.gzBytes + data.binBytes)) * 100).toFixed(0)}% saved`}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
