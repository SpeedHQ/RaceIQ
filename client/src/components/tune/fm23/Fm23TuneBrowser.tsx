import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { buildRows, type RawUserTune } from "@/components/tune/browser/buildRows";
import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import { withDefaults } from "@/components/tune/form/TuneForm";
import { TuneSettingsPanel } from "@/components/tune/TuneSettingsPanel";
import type { CatalogTune, TuneSettings } from "@/data/tune-catalog";
import { useCatalogTunes, useCloneCatalogTune, useCreateTune, useDeleteTune, useDuplicateTune, useRefreshCommunityTunes, useUserTunes } from "@/hooks/tunes";
import { m } from "@/paraglide/messages";

const REQUIRED_SECTIONS = ["tires", "gearing", "alignment", "antiRollBars", "springs", "damping", "aero", "differential", "brakes"] as const;

export function Fm23TuneBrowser() {
  const navigate = useNavigate();
  const { data: userTunes = [] } = useUserTunes();
  const { data: apiCatalog = [] } = useCatalogTunes();
  const clone = useCloneCatalogTune();
  const del = useDeleteTune();
  const duplicate = useDuplicateTune();
  const refresh = useRefreshCommunityTunes();
  const createTune = useCreateTune();

  const SOURCES: SourceTab[] = [
    { key: "all", label: m.browser_all() },
    { key: "community", label: m.browser_community() },
    { key: "user", label: m.tune_source_yours() },
  ];

  // Import a tune from a JSON file (same shape the tune editor exports).
  const handleImportFile = async (file: File) => {
    try {
      const parsed: any = JSON.parse(await file.text());
      const s = parsed.settings ?? parsed;
      for (const key of REQUIRED_SECTIONS) {
        if (!s?.[key]) throw new Error(`Missing section: ${key}`);
      }
      const normalizedSettings = {
        ...s,
        springs: { ...s.springs, ...(parsed.unitSystem === "imperial" ? { unit: "lb/in" } : parsed.unitSystem === "metric" ? { unit: "kgf/mm" } : {}) },
        aero: { ...s.aero, ...(parsed.unitSystem === "imperial" ? { unit: "lb" } : parsed.unitSystem === "metric" ? { unit: "kgf" } : {}) },
      };
      await createTune.mutateAsync({
        gameId: "fm-2023",
        name: parsed.name || file.name.replace(/\.json$/i, "") || m.tune_source_imported_tune(),
        author: parsed.author || m.tune_source_imported(),
        carId: String(parsed.carId ?? parsed.carOrdinal ?? 2860),
        category: parsed.category || "circuit",
        description: parsed.description || m.tune_source_imported_from_json(),
        settings: withDefaults(normalizedSettings),
        unitSystem: parsed.unitSystem === "imperial" ? "imperial" : "metric",
      } as any);
    } catch (err) {
      console.error("[TuneImport] failed:", err);
    }
  };

  const catalog: CatalogTune[] = apiCatalog;
  const rows = useMemo(() => buildRows(catalog, userTunes as RawUserTune[]), [catalog, userTunes]);

  const trackIds = useMemo(() => [...new Set(rows.map((r) => r.trackId).filter((id): id is string => id != null))], [rows]);
  const carIds = useMemo(() => [...new Set(rows.map((r) => r.carId))], [rows]);
  const carNames: Record<string, string> = useMemo(() => Object.fromEntries(carIds.map((id) => [id, `Car #${id}`])), [carIds]);
  const trackNames: Record<string, string> = useMemo(() => Object.fromEntries(trackIds.map((id) => [id, `Track ${id}`])), [trackIds]);

  const carOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.carId, (counts.get(row.carId) ?? 0) + 1);
    const opts = [...counts.entries()].map(([id, count]) => ({ value: id, label: carNames[id] ?? `Car #${id}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: m.tune_filter_any_car(), count: rows.length }, ...opts];
  }, [rows, carNames]);

  const trackOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.trackId != null) counts.set(row.trackId, (counts.get(row.trackId) ?? 0) + 1);
    const opts = [...counts.entries()].map(([id, count]) => ({ value: id, label: trackNames[id] ?? `Track ${id}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: m.tune_filter_any_track(), count: rows.length }, ...opts];
  }, [rows, trackNames]);

  return (
    <SetupBrowser
      rows={rows}
      carNames={carNames}
      trackNames={trackNames}
      trackOptions={trackOptions}
      carOptions={carOptions}
      sources={SOURCES}
      renderSettings={(row: TuneRow) => <TuneSettingsPanel settings={row.settings as TuneSettings} />}
      onClone={(row: TuneRow) => clone.mutate(row.id)}
      onEdit={(row: TuneRow) => {
        if (row.dbId != null) navigate({ to: `/fm23/setups/edit/${row.dbId}` });
      }}
      onDelete={(row: TuneRow) => {
        if (row.dbId != null) del.mutate(row.dbId);
      }}
      onDuplicate={(row: TuneRow) => {
        if (row.dbId != null) duplicate.mutate(row.dbId);
      }}
      isDuplicating={duplicate.isPending}
      onNewTune={() => navigate({ to: "/fm23/setups/new" })}
      onImportFile={handleImportFile}
      importing={createTune.isPending}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending}
    />
  );
}
