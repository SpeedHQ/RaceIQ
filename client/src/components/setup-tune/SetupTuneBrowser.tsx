import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { buildRows, type RawUserTune } from "@/components/tune/browser/buildRows";
import { SetupBrowser } from "@/components/tune/browser/SetupBrowser";
import type { SourceTab, TuneRow } from "@/components/tune/browser/types";
import type { CatalogTune } from "@/data/tune-catalog";
import { useResolveNames } from "@/hooks/catalog-queries";
import { useCatalogTunes, useCloneCatalogTune, useDeleteTune, useDuplicateTune, useUserTunes } from "@/hooks/tunes";
import { m } from "@/paraglide/messages";
import { useUiStore } from "@/stores/ui";
import type { GameId } from "@raceiq/shared/games/ids";
import { SetupSettingsPanel } from "./SetupSettingsPanel";
import type { GameCarOption } from "./use-game-cars";

const SOURCE_KEYS: Pick<SourceTab, "key">[] = [{ key: "all" }, { key: "community" }, { key: "user" }];

const SOURCE_LABELS: Record<string, () => string> = {
  all: m.browser_all,
  community: m.browser_community,
  user: m.browser_yours,
};

/** Timing-tower style tune browser for ACC / AC-EVO — same layout, filters,
 *  and pagination as the FM browser, with a game-specific read-only settings
 *  summary and an "Import from file" link instead of the built-in JSON
 *  file-picker (ACC/AC-EVO import from the game's own Setups folder). */
export function SetupTuneBrowser({ gameId, routePrefix, cars }: { gameId: GameId; routePrefix: string; cars: GameCarOption[] }) {
  const navigate = useNavigate();
  const { data: userTunes = [] } = useUserTunes(gameId);
  const { data: apiCatalog = [] } = useCatalogTunes();
  const clone = useCloneCatalogTune();
  const del = useDeleteTune();
  const duplicate = useDuplicateTune();
  const uiLocale = useUiStore((s) => s.uiLocale);

  const catalog: CatalogTune[] = apiCatalog;
  const rows = useMemo(() => buildRows(catalog, userTunes as RawUserTune[]), [catalog, userTunes]);

  const trackIds = useMemo(() => [...new Set(rows.map((r) => r.trackId).filter((id): id is string => id != null))], [rows]);
  const carIds = useMemo(() => [...new Set(rows.map((r) => r.carId))], [rows]);
  const { data: names } = useResolveNames(trackIds, carIds);

  const carNameLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cars) m.set(c.id, c.name);
    return m;
  }, [cars]);

  const carNames: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of carIds) map[id] = carNameLookup.get(id) ?? names?.carNames[id] ?? `Car #${id}`;
    return map;
  }, [carIds, carNameLookup, names]);

  const trackNames: Record<string, string> = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of trackIds) map[id] = names?.trackNames[id] ?? `Track #${id}`;
    return map;
  }, [trackIds, names]);

  const carOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.carId, (counts.get(r.carId) ?? 0) + 1);
    const opts = [...counts.entries()].map(([id, count]) => ({ value: id, label: carNames[id] ?? `Car #${id}`, count })).sort((a, b) => b.count - a.count);
    return opts;
  }, [rows, carNames, uiLocale]);

  const trackOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) if (r.trackId != null) counts.set(r.trackId, (counts.get(r.trackId) ?? 0) + 1);
    const opts = [...counts.entries()].map(([id, count]) => ({ value: id, label: names?.trackNames[id] ?? `Track ${id}`, count })).sort((a, b) => b.count - a.count);
    return [{ value: "any", label: m.setup_any_track(), count: rows.length }, ...opts];
  }, [rows, names, uiLocale]);

  const sources: SourceTab[] = useMemo(() => SOURCE_KEYS.map((s) => ({ ...s, label: SOURCE_LABELS[s.key]() })), [uiLocale]);

  return (
    <SetupBrowser
      rows={rows}
      carNames={carNames}
      trackNames={trackNames}
      trackOptions={trackOptions}
      carOptions={carOptions}
      sources={sources}
      renderSettings={(row: TuneRow) => <SetupSettingsPanel gameId={gameId} settings={row.settings as Record<string, unknown>} />}
      onClone={(row: TuneRow) => clone.mutate(row.id)}
      onEdit={(row: TuneRow) => {
        if (row.dbId != null) navigate({ to: `${routePrefix}/setups/edit/${row.dbId}` });
      }}
      onDelete={async (row: TuneRow) => {
        if (row.dbId != null) await del.mutateAsync({ id: row.dbId, confirmInUse: true });
      }}
      onDuplicate={(row: TuneRow) => {
        if (row.dbId != null) duplicate.mutate(row.dbId);
      }}
      isDuplicating={duplicate.isPending}
      onNewTune={() => navigate({ to: `${routePrefix}/setups/new` })}
      headerExtra={
        <Link
          to={`${routePrefix}/setups/import` as string}
          className="text-app-compact font-semibold uppercase tracking-wide border border-app-border text-app-text-secondary hover:text-app-text px-3.5 py-2 rounded no-underline"
        >
          {m.setuptune_import_from_file()}
        </Link>
      }
    />
  );
}
