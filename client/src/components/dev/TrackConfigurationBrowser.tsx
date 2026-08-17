import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { KNOWN_GAME_IDS, type GameId } from "../../../../shared/games/ids";
import type { TrackConfiguration, TrackConfigurationConfirmation } from "../../../../shared/racing/tracks/configuration";
import type { TrackImageryConfigurationIndex } from "../../../../shared/racing/tracks/imagery";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";

interface CatalogTrack {
  ordinal: number;
  name: string;
  variant?: string | null;
  location?: string | null;
  country?: string | null;
}

export interface TrackConfigurationSelection {
  gameId: GameId;
  trackOrdinal: number;
  name: string;
}

interface TrackRecord extends TrackConfigurationSelection {
  variant: string;
  location: string;
  configuration: TrackConfiguration | null;
  hasImagery: boolean;
}

type StatusFilter = "all" | "unassigned" | "unconfirmed" | "confirmed";

interface VenueNode {
  segment: string;
  path: string;
  children: Map<string, VenueNode>;
  tracks: TrackRecord[];
}

const VENUE_ID = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

function key(gameId: GameId, trackOrdinal: number): string {
  return `${gameId}:${trackOrdinal}`;
}

function normalizeVenueInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/]+/, "");
}

function displaySegment(segment: string): string {
  if (segment === "unassigned") return "Unassigned";
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

async function responseJson<T>(response: Response): Promise<T> {
  const result = (await response.json()) as T | { error?: string };
  if (!response.ok) throw new Error((result as { error?: string }).error ?? `Request failed (${response.status})`);
  return result as T;
}

function insertVenue(root: Map<string, VenueNode>, venueId: string): VenueNode {
  let children = root;
  let path = "";
  let node: VenueNode | null = null;
  for (const segment of venueId.split("/")) {
    path = path ? `${path}/${segment}` : segment;
    node = children.get(segment) ?? { segment, path, children: new Map(), tracks: [] };
    children.set(segment, node);
    children = node.children;
  }
  return node!;
}

function countNodeTracks(node: VenueNode): number {
  let count = node.tracks.length;
  for (const child of node.children.values()) count += countNodeTracks(child);
  return count;
}

function statusFor(record: TrackRecord): Exclude<StatusFilter, "all"> {
  if (!record.configuration) return "unassigned";
  return record.configuration.confirmation ? "confirmed" : "unconfirmed";
}

function statusBadge(record: TrackRecord): { label: string; className: string } {
  const status = statusFor(record);
  if (status === "confirmed") return { label: "Confirmed", className: "border-severity-nominal/50 bg-severity-nominal/10 text-severity-nominal" };
  if (status === "unconfirmed") return { label: "Needs confirmation", className: "border-severity-caution/50 bg-severity-caution/10 text-severity-caution" };
  return { label: "Unassigned", className: "border-app-border bg-app-surface-alt text-app-text-muted" };
}

function TrackRow({
  record,
  selected,
  confirmedBy,
  commitId,
  onConfirmedByChange,
  onCommitIdChange,
  onSelect,
  onChanged,
}: {
  record: TrackRecord;
  selected: boolean;
  confirmedBy: string;
  commitId: string;
  onConfirmedByChange: (value: string) => void;
  onCommitIdChange: (value: string) => void;
  onSelect: (selection: TrackConfigurationSelection) => void;
  onChanged: () => Promise<void>;
}) {
  const [venueId, setVenueId] = useState(record.configuration?.venueId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setVenueId(record.configuration?.venueId ?? ""), [record.configuration?.venueId]);
  const badge = statusBadge(record);
  const selection = { gameId: record.gameId, trackOrdinal: record.trackOrdinal, name: record.name };

  const saveVenue = async () => {
    if (!VENUE_ID.test(venueId)) return;
    setSaving(true);
    setError(null);
    try {
      await responseJson<TrackConfiguration>(
        await fetch(`/api/dev/track-configurations/${record.trackOrdinal}?gameId=${encodeURIComponent(record.gameId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, gameId: record.gameId, trackOrdinal: record.trackOrdinal, venueId, confirmation: null }),
        }),
      );
      await onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save venue assignment");
    } finally {
      setSaving(false);
    }
  };

  const confirm = async () => {
    if (!record.configuration || !confirmedBy.trim()) return;
    setSaving(true);
    setError(null);
    const confirmation: TrackConfigurationConfirmation = {
      confirmedAt: new Date().toISOString().slice(0, 10),
      confirmedBy: confirmedBy.trim(),
      ...(commitId.trim() ? { commitId: commitId.trim() } : {}),
    };
    try {
      await responseJson<TrackConfiguration>(
        await fetch(`/api/dev/track-configurations/${record.trackOrdinal}/confirmation?gameId=${encodeURIComponent(record.gameId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(confirmation),
        }),
      );
      await onChanged();
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Unable to confirm track configuration");
    } finally {
      setSaving(false);
    }
  };

  const clearConfirmation = async () => {
    setSaving(true);
    setError(null);
    try {
      await responseJson<TrackConfiguration>(await fetch(`/api/dev/track-configurations/${record.trackOrdinal}/confirmation?gameId=${encodeURIComponent(record.gameId)}`, { method: "DELETE" }));
      await onChanged();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "Unable to clear confirmation");
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className={`rounded border ${selected ? "border-app-accent" : "border-app-border"} bg-app-surface`}>
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-app-text">{record.name}</span>
          <span className="block truncate text-[10px] text-app-text-muted">
            {record.variant ? `${record.variant} · ` : ""}#{record.trackOrdinal}
            {record.location ? ` · ${record.location}` : ""}
          </span>
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-[9px] font-medium ${badge.className}`}>{badge.label}</span>
      </summary>
      <div className="border-t border-app-border px-2 py-2">
        <div className="mb-2 flex flex-wrap gap-1 text-[10px] text-app-text-muted">
          <span className="rounded bg-app-surface-alt px-1.5 py-0.5 font-mono">{record.gameId}</span>
          {record.hasImagery && <span className="rounded bg-app-accent/10 px-1.5 py-0.5 text-app-accent">Imagery configured</span>}
        </div>
        <label className="mb-2 block text-[10px] font-medium text-app-text-secondary">
          Venue path
          <input
            className="mt-0.5 w-full rounded border border-app-border-input bg-app-bg px-2 py-1 font-mono text-xs text-app-text"
            value={venueId}
            onChange={(event) => setVenueId(normalizeVenueInput(event.target.value))}
            placeholder="daytona/historical/2011/road-course"
          />
        </label>
        <div className="mb-2 flex flex-wrap gap-1">
          <Button type="button" onClick={() => void saveVenue()} disabled={!VENUE_ID.test(venueId) || saving}>
            Save venue
          </Button>
          <Button type="button" onClick={() => onSelect(selection)}>
            {selected ? "Selected for calibration" : "Open calibration"}
          </Button>
        </div>
        {record.configuration?.confirmation ? (
          <div className="rounded border border-severity-nominal/30 bg-severity-nominal/5 p-2 text-[10px] text-app-text-secondary">
            <div>
              Confirmed {record.configuration.confirmation.confirmedAt} by {record.configuration.confirmation.confirmedBy}
              {record.configuration.confirmation.commitId ? ` · ${record.configuration.confirmation.commitId}` : ""}
            </div>
            <button className="mt-1 text-severity-caution hover:underline" type="button" onClick={() => void clearConfirmation()} disabled={saving}>
              Clear confirmation
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-1">
            <input
              className="min-w-0 rounded border border-app-border-input bg-app-bg px-2 py-1 text-[10px] text-app-text"
              value={confirmedBy}
              onChange={(event) => onConfirmedByChange(event.target.value)}
              placeholder="Confirmed by"
            />
            <input
              className="min-w-0 rounded border border-app-border-input bg-app-bg px-2 py-1 font-mono text-[10px] text-app-text"
              value={commitId}
              onChange={(event) => onCommitIdChange(event.target.value)}
              placeholder="Commit ID (optional)"
            />
            <Button type="button" onClick={() => void confirm()} disabled={!record.configuration || !confirmedBy.trim() || saving}>
              Confirm
            </Button>
          </div>
        )}
        {error && <p className="mt-1 text-[10px] text-severity-critical">{error}</p>}
      </div>
    </details>
  );
}

function VenueNodeView({
  node,
  filterActive,
  selectedKey,
  confirmedBy,
  commitId,
  onConfirmedByChange,
  onCommitIdChange,
  onSelect,
  onChanged,
}: {
  node: VenueNode;
  filterActive: boolean;
  selectedKey: string | null;
  confirmedBy: string;
  commitId: string;
  onConfirmedByChange: (value: string) => void;
  onCommitIdChange: (value: string) => void;
  onSelect: (selection: TrackConfigurationSelection) => void;
  onChanged: () => Promise<void>;
}) {
  const games = new Map<GameId, TrackRecord[]>();
  for (const track of node.tracks) {
    const records = games.get(track.gameId) ?? [];
    records.push(track);
    games.set(track.gameId, records);
  }
  const children = [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
  return (
    <details key={`${node.path}:${filterActive}`} className="ml-2 border-l border-app-border pl-2" open={filterActive || node.segment === "unassigned" ? true : undefined}>
      <summary className="cursor-pointer list-none py-1 text-xs font-semibold text-app-text-secondary [&::-webkit-details-marker]:hidden">
        <span className="mr-1 text-app-text-muted">›</span>
        {displaySegment(node.segment)} <span className="font-normal text-app-text-muted">({countNodeTracks(node)})</span>
      </summary>
      <div className="space-y-1 pb-1">
        {[...games.entries()].map(([gameId, records]) => (
          <details key={`${node.path}:${gameId}:${filterActive}`} className="ml-2" open={filterActive ? true : undefined}>
            <summary className="cursor-pointer list-none py-1 font-mono text-[10px] font-semibold text-app-accent [&::-webkit-details-marker]:hidden">
              {gameId} <span className="font-sans font-normal text-app-text-muted">({records.length})</span>
            </summary>
            <div className="space-y-1 pl-2">
              {records.map((record) => (
                <TrackRow
                  key={key(record.gameId, record.trackOrdinal)}
                  record={record}
                  selected={selectedKey === key(record.gameId, record.trackOrdinal)}
                  confirmedBy={confirmedBy}
                  commitId={commitId}
                  onConfirmedByChange={onConfirmedByChange}
                  onCommitIdChange={onCommitIdChange}
                  onSelect={onSelect}
                  onChanged={onChanged}
                />
              ))}
            </div>
          </details>
        ))}
        {children.map((child) => (
          <VenueNodeView
            key={child.path}
            node={child}
            filterActive={filterActive}
            selectedKey={selectedKey}
            confirmedBy={confirmedBy}
            commitId={commitId}
            onConfirmedByChange={onConfirmedByChange}
            onCommitIdChange={onCommitIdChange}
            onSelect={onSelect}
            onChanged={onChanged}
          />
        ))}
      </div>
    </details>
  );
}

export function TrackConfigurationBrowser({
  selection,
  onSelect,
  onConfigurationChange,
}: {
  selection: TrackConfigurationSelection | null;
  onSelect: (selection: TrackConfigurationSelection) => void;
  onConfigurationChange: () => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [confirmedBy, setConfirmedBy] = useLocalStorage("track-configuration-confirmed-by", "");
  const [commitId, setCommitId] = useLocalStorage("track-configuration-commit-id", "");
  const catalogQueries = useQueries({
    queries: KNOWN_GAME_IDS.map((gameId) => ({
      queryKey: ["tracks", gameId],
      queryFn: async () => responseJson<CatalogTrack[]>(await fetch(`/api/tracks?gameId=${encodeURIComponent(gameId)}`)),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const configurationQuery = useQuery({
    queryKey: ["track-configurations"],
    queryFn: async () => responseJson<TrackConfiguration[]>(await fetch("/api/dev/track-configurations")),
  });
  const imageryQuery = useQuery({
    queryKey: ["track-imagery-configurations"],
    queryFn: async () => responseJson<TrackImageryConfigurationIndex>(await fetch("/api/dev/track-imagery")),
  });

  const records = useMemo(() => {
    const configurations = new Map((configurationQuery.data ?? []).map((configuration) => [key(configuration.gameId, configuration.trackOrdinal), configuration]));
    const imagery = new Set((imageryQuery.data?.layouts ?? []).map((layout) => key(layout.gameId, layout.trackOrdinal)));
    return catalogQueries.flatMap((query, index) => {
      const gameId = KNOWN_GAME_IDS[index]!;
      return (query.data ?? []).map((track) => ({
        gameId,
        trackOrdinal: track.ordinal,
        name: track.name,
        variant: track.variant ?? "",
        location: track.location ?? "",
        configuration: configurations.get(key(gameId, track.ordinal)) ?? null,
        hasImagery: imagery.has(key(gameId, track.ordinal)),
      }));
    });
  }, [catalogQueries, configurationQuery.data, imageryQuery.data]);

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredRecords = records.filter((record) => {
    if (statusFilter !== "all" && statusFor(record) !== statusFilter) return false;
    if (!normalizedFilter) return true;
    return [record.name, record.variant, record.location, record.gameId, String(record.trackOrdinal), record.configuration?.venueId ?? ""].some((value) =>
      value.toLowerCase().includes(normalizedFilter),
    );
  });
  const venueTree = new Map<string, VenueNode>();
  for (const venue of imageryQuery.data?.venues ?? []) insertVenue(venueTree, venue.venueId);
  for (const configuration of configurationQuery.data ?? []) insertVenue(venueTree, configuration.venueId);
  for (const record of filteredRecords) insertVenue(venueTree, record.configuration?.venueId ?? "unassigned").tracks.push(record);
  const statusCounts = { unassigned: 0, unconfirmed: 0, confirmed: 0 };
  for (const record of records) statusCounts[statusFor(record)] += 1;
  const selectedKey = selection ? key(selection.gameId, selection.trackOrdinal) : null;
  const loading = catalogQueries.some((query) => query.isLoading) || configurationQuery.isLoading || imageryQuery.isLoading;
  const loadError = catalogQueries.find((query) => query.error)?.error ?? configurationQuery.error ?? imageryQuery.error;
  const changed = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["track-configurations"] }), queryClient.invalidateQueries({ queryKey: ["track-imagery-configurations"] })]);
    onConfigurationChange();
  };

  return (
    <section className="flex min-h-0 flex-col border-r border-app-border bg-app-bg">
      <div className="border-b border-app-border p-3">
        <h1 className="text-base font-semibold text-app-text">Track configuration</h1>
        <p className="mb-2 text-[11px] text-app-text-muted">All catalog tracks grouped by expandable venue path, then game ID.</p>
        <input
          className="mb-2 w-full rounded border border-app-border-input bg-app-surface px-2 py-1.5 text-xs text-app-text"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter track, venue, game, or ordinal…"
        />
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["all", `All ${records.length}`],
              ["unassigned", `Unassigned ${statusCounts.unassigned}`],
              ["unconfirmed", `Needs confirmation ${statusCounts.unconfirmed}`],
              ["confirmed", `Confirmed ${statusCounts.confirmed}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded border px-1.5 py-1 text-[10px] ${statusFilter === value ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-app-border text-app-text-muted"}`}
              onClick={() => setStatusFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && <p className="p-2 text-xs text-app-text-muted">Loading track catalogs…</p>}
        {loadError && <p className="p-2 text-xs text-severity-critical">{loadError instanceof Error ? loadError.message : "Unable to load track catalogs"}</p>}
        {!loading && !loadError && filteredRecords.length === 0 && <p className="p-2 text-xs text-app-text-muted">No tracks match filter.</p>}
        {[...venueTree.values()]
          .sort((a, b) => (a.segment === "unassigned" ? 1 : b.segment === "unassigned" ? -1 : a.segment.localeCompare(b.segment)))
          .map((node) => (
            <VenueNodeView
              key={node.path}
              node={node}
              filterActive={!!normalizedFilter || statusFilter !== "all"}
              selectedKey={selectedKey}
              confirmedBy={confirmedBy}
              commitId={commitId}
              onConfirmedByChange={setConfirmedBy}
              onCommitIdChange={setCommitId}
              onSelect={onSelect}
              onChanged={changed}
            />
          ))}
      </div>
    </section>
  );
}
