import type { ComboOption } from "@/components/tune/browser/ComboBox";
import { TuneBrowser } from "@/components/tune/browser/TuneBrowser";
import { type RawUserTune, buildRows } from "@/components/tune/browser/buildRows";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import { type CatalogTune, TUNE_CATALOG, getCatalogCar } from "@/data/tune-catalog";
import { useCatalogTunes, useCloneCatalogTune, useDeleteTune, useRefreshCommunityTunes, useResolveNames, useUserTunes } from "@/hooks/queries";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

const SOURCES: SourceTab[] = [
  { key: "all", label: "All" },
  { key: "builtin", label: "Built-in" },
  { key: "community", label: "Community" },
  { key: "user", label: "Yours" },
];

export function Fm23TuneBrowser() {
  const navigate = useNavigate();
  const { data: userTunes = [] } = useUserTunes();
  const { data: apiCatalog = [] } = useCatalogTunes();
  const clone = useCloneCatalogTune();
  const del = useDeleteTune();
  const refresh = useRefreshCommunityTunes();

  const catalog: CatalogTune[] = apiCatalog.length > 0 ? apiCatalog : TUNE_CATALOG;
  const rows = useMemo(() => buildRows(catalog, userTunes as RawUserTune[]), [catalog, userTunes]);

  const trackOrdinals = useMemo(() => [...new Set(rows.map((r) => r.trackOrdinal).filter((o): o is number => o != null))], [rows]);
  const { data: names } = useResolveNames(trackOrdinals, []);

  const carOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.carOrdinal, (counts.get(r.carOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: getCatalogCar(ord)?.name ?? `Car ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any car", count: rows.length }, ...opts];
  }, [rows]);

  const trackOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) if (r.trackOrdinal != null) counts.set(r.trackOrdinal, (counts.get(r.trackOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: names?.trackNames[String(ord)] ?? `Track ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any track", count: rows.length }, ...opts];
  }, [rows, names]);

  return (
    <TuneBrowser
      title="Tunes"
      rows={rows}
      trackOptions={trackOptions}
      carOptions={carOptions}
      sources={SOURCES}
      onClone={(row: TuneRow) => clone.mutate(row.id)}
      onEdit={(row: TuneRow) => {
        if (row.dbId != null) navigate({ to: `/fm23/tunes/edit/${row.dbId}` });
      }}
      onDelete={(row: TuneRow) => {
        if (row.dbId != null) del.mutate(row.dbId);
      }}
      onNewTune={() => navigate({ to: "/fm23/tunes/new" })}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending}
    />
  );
}
