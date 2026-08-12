import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { SessionOwnership } from "../../../../shared/racing/sessions/types";
import { client } from "../../lib/rpc";
import type { IbtImportPreview } from "./IbtImportPreviewModal";

export interface ImportedLap {
  lapId: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  carOrdinal: number;
  trackOrdinal: number;
}
export interface AnalyseImportResult {
  fileName: string;
  packetCount: number;
  laps: ImportedLap[];
  gameId: string;
  routePrefix: string;
}
export interface IbtPreviewState {
  token: string | null;
  preview: IbtImportPreview;
}

export function useAnalyseImports(args: {
  queryClient: QueryClient;
  gameId: string;
  setSelectedTrack: (value: number) => void;
  setSelectedCar: (value: number) => void;
  setSelectedLapId: (value: number) => void;
}) {
  const { queryClient, gameId, setSelectedTrack, setSelectedCar, setSelectedLapId } = args;
  const [exportingBin, setExportingBin] = useState(false);
  const [importingBin, setImportingBin] = useState(false);
  const [ownership, setOwnership] = useState<SessionOwnership>("mine");
  const [importResult, setImportResult] = useState<AnalyseImportResult | null>(null);
  const [ibtPreview, setIbtPreview] = useState<IbtPreviewState | null>(null);
  const selectLastLap = useCallback(
    (laps: ImportedLap[], importedGameId: string | undefined) => {
      if (importedGameId !== gameId || laps.length === 0) return;
      const last = laps[laps.length - 1];
      setSelectedTrack(last.trackOrdinal);
      setSelectedCar(last.carOrdinal);
      setSelectedLapId(last.lapId);
    },
    [gameId, setSelectedTrack, setSelectedCar, setSelectedLapId],
  );
  const handleExportBin = useCallback(async (selectedLapId: number | null) => {
    if (selectedLapId == null) return;
    setExportingBin(true);
    try {
      const res = await fetch(`/api/laps/${selectedLapId}/export-bin`);
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        window.alert(err?.error ?? `Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `lap-${selectedLapId}.bin`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingBin(false);
    }
  }, []);
  const handleImportBin = useCallback(
    async (file: File) => {
      setImportingBin(true);
      try {
        if (file.name.toLowerCase().endsWith(".ibt")) {
          const res = await fetch("/api/laps/import-ibt/preview", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Size": String(file.size) },
            body: file,
          });
          const data = (await res.json().catch(() => null)) as { error?: string; token?: string | null; preview?: IbtImportPreview } | null;
          if (!res.ok) {
            window.alert(data?.error ?? `IBT preview failed (${res.status})`);
            return;
          }
          if (data?.preview) setIbtPreview({ token: data.token ?? null, preview: data.preview });
          return;
        }
        const body = new FormData();
        body.append("file", file);
        body.append("ownership", ownership);
        const res = await fetch("/api/laps/import", { method: "POST", body });
        const data = (await res.json().catch(() => null)) as { error?: string; packetCount?: number; laps?: ImportedLap[]; gameId?: string; routePrefix?: string } | null;
        if (!res.ok) {
          window.alert(data?.error ?? `Import failed (${res.status})`);
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["laps"] });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["tracks"] });
        const laps = data?.laps ?? [];
        setImportResult({ fileName: file.name, packetCount: data?.packetCount ?? 0, laps, gameId: data?.gameId ?? "", routePrefix: data?.routePrefix ?? "" });
        selectLastLap(laps, data?.gameId);
      } catch (e) {
        window.alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setImportingBin(false);
      }
    },
    [queryClient, ownership, selectLastLap],
  );
  const handleCancelIbt = useCallback(() => {
    const token = ibtPreview?.token;
    setIbtPreview(null);
    if (token) void client.api.laps["import-ibt"].cancel.$post({ json: { token } }).catch(() => undefined);
  }, [ibtPreview]);
  const handleCommitIbt = useCallback(async () => {
    const staged = ibtPreview;
    if (!staged?.token) return;
    setImportingBin(true);
    try {
      const res = await client.api.laps["import-ibt"].commit.$post({ json: { token: staged.token, ownership } });
      const data = (await res.json().catch(() => null)) as { error?: string; packetCount?: number; laps?: ImportedLap[]; gameId?: string; routePrefix?: string } | null;
      if (!res.ok) {
        setIbtPreview(null);
        window.alert(data?.error ?? `IBT import failed (${res.status})`);
        return;
      }
      setIbtPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["laps"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["tracks"] });
      const laps = data?.laps ?? [];
      setImportResult({ fileName: staged.preview.fileName, packetCount: data?.packetCount ?? 0, laps, gameId: data?.gameId ?? "", routePrefix: data?.routePrefix ?? "" });
      selectLastLap(laps, data?.gameId);
    } catch (e) {
      setIbtPreview(null);
      window.alert(`IBT import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportingBin(false);
    }
  }, [ibtPreview, ownership, queryClient, selectLastLap]);
  return { exportingBin, importingBin, ownership, setOwnership, importResult, ibtPreview, handleExportBin, handleImportBin, handleCancelIbt, handleCommitIbt, setImportResult };
}
