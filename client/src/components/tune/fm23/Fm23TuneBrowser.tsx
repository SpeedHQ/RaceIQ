import { withDefaults } from "@/components/TuneForm";
import { TuneSettingsPanel } from "@/components/tune/TuneSettingsPanel";
import type { ComboOption } from "@/components/tune/browser/ComboBox";
import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import { type RawUserTune, buildRows } from "@/components/tune/browser/buildRows";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import type { CatalogTune, TuneSettings } from "@/data/tune-catalog";
import { useCatalogTunes, useCloneCatalogTune, useCreateTune, useDeleteTune, useDuplicateTune, useRefreshCommunityTunes, useResolveNames, useUserTunes } from "@/hooks/queries";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

const REQUIRED_SECTIONS = ["tires", "gearing", "alignment", "antiRollBars", "springs", "damping", "aero", "differential", "brakes"] as const;

const SOURCES: SourceTab[] = [
  { key: "all", label: "All" },
  { key: "community", label: "Community" },
  { key: "user", label: "Yours" },
];

export function Fm23TuneBrowser() {
  const navigate = useNavigate();
  const { data: userTunes = [] } = useUserTunes();
  const { data: apiCatalog = [] } = useCatalogTunes();
  const clone = useCloneCatalogTune();
  const del = useDeleteTune();
  const duplicate = useDuplicateTune();
  const refresh = useRefreshCommunityTunes();
  const createTune = useCreateTune();

  // Import a tune from a JSON file (same shape the tune editor exports).
  const handleImportFile = async (file: File) => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: importing arbitrary user-provided tune JSON
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
        name: parsed.name || file.name.replace(/\.json$/i, "") || "Imported Tune",
        author: parsed.author || "Imported",
        carOrdinal: Number(parsed.carOrdinal ?? 2860),
        category: parsed.category || "circuit",
        description: parsed.description || "Imported from JSON",
        settings: withDefaults(normalizedSettings),
        unitSystem: parsed.unitSystem === "imperial" ? "imperial" : "metric",
        // biome-ignore lint/suspicious/noExplicitAny: create-tune mutation accepts a loose payload
      } as any);
    } catch (err) {
      console.error("[TuneImport] failed:", err);
    }
  };

  const catalog: CatalogTune[] = apiCatalog;
  const rows = useMemo(() => buildRows(catalog, userTunes as RawUserTune[]), [catalog, userTunes]);

  const trackOrdinals = useMemo(() => [...new Set(rows.map((r) => r.trackOrdinal).filter((o): o is number => o != null))], [rows]);
  const carOrdinals = useMemo(() => [...new Set(rows.map((r) => r.carOrdinal))], [rows]);
  const { data: names } = useResolveNames(trackOrdinals, carOrdinals);

  const carNames: Record<number, string> = useMemo(() => {
    const map: Record<number, string> = {};
    for (const ord of carOrdinals) map[ord] = names?.carNames[String(ord)] ?? `Car #${ord}`;
    return map;
  }, [carOrdinals, names]);

  const trackNames: Record<number, string> = useMemo(() => {
    const map: Record<number, string> = {};
    for (const ord of trackOrdinals) map[ord] = names?.trackNames[String(ord)] ?? `Track #${ord}`;
    return map;
  }, [trackOrdinals, names]);

  const carOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.carOrdinal, (counts.get(r.carOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: carNames[ord] ?? `Car #${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any car", count: rows.length }, ...opts];
  }, [rows, carNames]);

  const trackOptions: ComboOption[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) if (r.trackOrdinal != null) counts.set(r.trackOrdinal, (counts.get(r.trackOrdinal) ?? 0) + 1);
    const opts = [...counts.entries()].map(([ord, count]) => ({ value: String(ord), label: names?.trackNames[String(ord)] ?? `Track ${ord}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: "Any track", count: rows.length }, ...opts];
  }, [rows, names]);

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
