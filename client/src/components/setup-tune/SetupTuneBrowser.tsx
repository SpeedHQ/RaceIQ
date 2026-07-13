import type { ComboOption } from "@/components/tune/browser/ComboBox";
import { type RawUserTune, buildRows } from "@/components/tune/browser/buildRows";
import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import type { CatalogTune } from "@/data/tune-catalog";
import { useCatalogTunes, useCloneCatalogTune, useDeleteTune, useDuplicateTune, useResolveNames, useUserTunes } from "@/hooks/queries";
import type { GameId } from "@shared/types";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { SetupSettingsPanel } from "./SetupSettingsPanel";
import type { GameCarOption } from "./use-game-cars";

const SOURCES: SourceTab[] = [
  { key: "all", label: "All" },
  { key: "community", label: "Community" },
  { key: "user", label: "Yours" },
];

/** Timing-tower style tune browser for ACC / AC-EVO — same layout, filters,
 *  and pagination as the FM browser, with a game-specific read-only settings
 *  summary and an "Import from file" link instead of the built-in JSON
 *  file-picker (ACC/AC-EVO import from the game's own Setups folder). */
export function SetupTuneBrowser({
  gameId,
  routePrefix,
  cars,
}: {
  gameId: GameId;
  routePrefix: string;
  gameLabel?: string;
  cars: GameCarOption[];
}) {
  const navigate = useNavigate();
  const { data: userTunes = [] } = useUserTunes(gameId);
  const { data: apiCatalog = [] } = useCatalogTunes();
  const clone = useCloneCatalogTune();
  const del = useDeleteTune();
  const duplicate = useDuplicateTune();

  const catalog: CatalogTune[] = apiCatalog;
  const rows = useMemo(() => buildRows(catalog, userTunes as RawUserTune[]), [catalog, userTunes]);

  const trackOrdinals = useMemo(() => [...new Set(rows.map((r) => r.trackOrdinal).filter((o): o is number => o != null))], [rows]);
  const carOrdinals = useMemo(() => [...new Set(rows.map((r) => r.carOrdinal))], [rows]);
  const { data: names } = useResolveNames(trackOrdinals, carOrdinals);

  const carNameLookup = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of cars) m.set(c.ordinal, c.name);
    return m;
  }, [cars]);

  const carNames: Record<number, string> = useMemo(() => {
    const map: Record<number, string> = {};
    for (const ord of carOrdinals) map[ord] = carNameLookup.get(ord) ?? names?.carNames[String(ord)] ?? `Car #${ord}`;
    return map;
  }, [carOrdinals, carNameLookup, names]);

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
      renderSettings={(row: TuneRow) => <SetupSettingsPanel gameId={gameId} settings={row.settings as Record<string, unknown>} />}
      onClone={(row: TuneRow) => clone.mutate(row.id)}
      onEdit={(row: TuneRow) => {
        if (row.dbId != null) navigate({ to: `${routePrefix}/setups/edit/${row.dbId}` });
      }}
      onDelete={(row: TuneRow) => {
        if (row.dbId != null) del.mutate(row.dbId);
      }}
      onDuplicate={(row: TuneRow) => {
        if (row.dbId != null) duplicate.mutate(row.dbId);
      }}
      isDuplicating={duplicate.isPending}
      onNewTune={() => navigate({ to: `${routePrefix}/setups/new` })}
      headerExtra={
        <Link
          to={`${routePrefix}/setups/import` as string}
          className="text-[11px] font-semibold uppercase tracking-wide border border-app-border text-app-text-secondary hover:text-app-text px-3.5 py-2 rounded no-underline"
        >
          Import from file
        </Link>
      }
    />
  );
}
