import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { KNOWN_GAME_IDS, type GameId } from "../../../../shared/games/ids";
import { trackConfigurationCanonicalId, type TrackConfiguration, type TrackConfigurationConfirmation, type TrackIdentityNode } from "../../../../shared/racing/tracks/configuration";
import type { TrackImageryConfigurationIndex } from "../../../../shared/racing/tracks/imagery";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { client, devClient } from "../../lib/rpc";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

interface CatalogTrack {
  ordinal: number;
  name: string;
  variant?: string | null;
  location?: string | null;
  country?: string | null;
  commonTrackName?: string | null;
}

export interface TrackConfigurationSelection {
  gameId: GameId;
  trackOrdinal: number;
}

interface TrackRecord extends TrackConfigurationSelection {
  name: string;
  variant: string;
  location: string;
  commonTrackName: string;
  configuration: TrackConfiguration | null;
  hasImagery: boolean;
}

type StatusFilter = "all" | "unassigned" | "unconfirmed" | "confirmed";

interface VenueNode {
  segment: TrackIdentityNode;
  path: string;
  children: Map<string, VenueNode>;
  tracks: TrackRecord[];
}

interface AssignmentSuggestions {
  venues: string[];
  subVenues: string[];
  tracks: string[];
}

function key(gameId: GameId, trackOrdinal: number): string {
  return `${gameId}:${trackOrdinal}`;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function node(name: string): TrackIdentityNode {
  return { id: slug(name), name: name.trim() };
}

function displaySegment(segment: string): string {
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

function jsonRequestInit(value: unknown): RequestInit {
  return { body: JSON.stringify(value), headers: { "Content-Type": "application/json" } };
}

function insertVenue(root: Map<string, VenueNode>, segments: readonly TrackIdentityNode[]): VenueNode {
  let children = root;
  let path = "";
  let current: VenueNode | null = null;
  for (const segment of segments) {
    path = path ? `${path}/${segment.id}` : segment.id;
    current = children.get(segment.id) ?? { segment, path, children: new Map(), tracks: [] };
    children.set(segment.id, current);
    children = current.children;
  }
  return current!;
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

function AssignmentModal({
  record,
  suggestions,
  onClose,
  onSave,
}: {
  record: TrackRecord;
  suggestions: AssignmentSuggestions;
  onClose: () => void;
  onSave: (record: TrackRecord, configuration: Omit<TrackConfiguration, "confirmation">) => Promise<void>;
}) {
  const [venue, setVenue] = useState("");
  const [subVenues, setSubVenues] = useState<string[]>([]);
  const [track, setTrack] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const configuration = record.configuration;
    setVenue(configuration?.venue.name ?? record.name);
    setSubVenues(configuration?.subVenues.map((entry) => entry.name) ?? []);
    setTrack(configuration?.track.name ?? (record.variant || "Main"));
    setError(null);
  }, [record]);
  const venueNode = node(venue);
  const subVenueNodes = subVenues.map(node);
  const trackNode = node(track);
  const valid = !!venueNode.id && !!venueNode.name && subVenueNodes.every((entry) => !!entry.id && !!entry.name) && !!trackNode.id && !!trackNode.name;
  const preview = valid ? [venueNode, ...subVenueNodes, trackNode].map((entry) => entry.name).join(" / ") : "Complete venue and track names";

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(record, {
        version: 1,
        gameId: record.gameId,
        trackOrdinal: record.trackOrdinal,
        venue: venueNode,
        subVenues: subVenueNodes,
        track: trackNode,
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save track assignment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" showCloseButton={false} overlayClassName="bg-app-bg/60">
        <DialogHeader>
          <DialogTitle>Assign canonical track</DialogTitle>
          <DialogDescription>
            {record.gameId} #{record.trackOrdinal} · {record.name}
            {record.variant ? ` · ${record.variant}` : ""}
          </DialogDescription>
        </DialogHeader>

        <label className="block text-xs font-medium text-app-text-secondary">
          Venue
          <input
            className="mt-1 w-full rounded border border-app-border-input bg-app-bg px-2 py-1.5 text-sm text-app-text"
            list="track-configuration-venue-options"
            value={venue}
            onChange={(event) => setVenue(event.target.value)}
            placeholder="Daytona"
            autoFocus
          />
        </label>

        <fieldset className="rounded border border-app-border p-3">
          <legend className="px-1 text-xs font-medium text-app-text-secondary">Sub-venues (optional)</legend>
          {subVenues.length === 0 && <p className="mb-2 text-app-compact text-app-text-muted">None. Add levels for historical versions, years, complexes, or sub-venues.</p>}
          <div className="space-y-2">
            {subVenues.map((subVenue, index) => (
              <div key={index} className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  className="min-w-0 rounded border border-app-border-input bg-app-bg px-2 py-1.5 text-sm text-app-text"
                  list="track-configuration-sub-venue-options"
                  value={subVenue}
                  onChange={(event) => setSubVenues((current) => current.map((value, currentIndex) => (currentIndex === index ? event.target.value : value)))}
                  placeholder={index === 0 ? "Historical" : "2011"}
                />
                <Button type="button" onClick={() => setSubVenues((current) => current.filter((_, currentIndex) => currentIndex !== index))}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" className="mt-2" onClick={() => setSubVenues((current) => [...current, ""])} disabled={subVenues.length >= 8}>
            Add sub-venue
          </Button>
        </fieldset>

        <label className="block text-xs font-medium text-app-text-secondary">
          Track / layout
          <input
            className="mt-1 w-full rounded border border-app-border-input bg-app-bg px-2 py-1.5 text-sm text-app-text"
            list="track-configuration-track-options"
            value={track}
            onChange={(event) => setTrack(event.target.value)}
            placeholder="Road Course"
          />
        </label>

        <div className="rounded border border-app-border bg-app-surface-alt p-2">
          <div className="text-app-caption uppercase tracking-wide text-app-text-muted">Canonical identity</div>
          <div className="mt-1 text-sm text-app-text">{preview}</div>
          {valid && <div className="mt-0.5 font-mono text-app-caption text-app-text-muted">{[venueNode, ...subVenueNodes, trackNode].map((entry) => entry.id).join("/")}</div>}
        </div>
        {error && <p className="text-xs text-severity-critical">{error}</p>}

        <datalist id="track-configuration-venue-options">
          {suggestions.venues.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <datalist id="track-configuration-sub-venue-options">
          {suggestions.subVenues.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <datalist id="track-configuration-track-options">
          {suggestions.tracks.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>

        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!valid || saving}>
            {saving ? "Saving…" : "Save assignment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrackRow({
  record,
  selected,
  confirmedBy,
  commitId,
  onConfirmedByChange,
  onCommitIdChange,
  onAssign,
  onSelect,
  onChanged,
}: {
  record: TrackRecord;
  selected: boolean;
  confirmedBy: string;
  commitId: string;
  onConfirmedByChange: (value: string) => void;
  onCommitIdChange: (value: string) => void;
  onAssign: (record: TrackRecord) => void;
  onSelect: (selection: TrackConfigurationSelection) => void;
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badge = statusBadge(record);
  const selection = { gameId: record.gameId, trackOrdinal: record.trackOrdinal };
  const canonical = record.configuration ? trackConfigurationCanonicalId(record.configuration) : null;

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
        await devClient.api.dev["track-configurations"][":ordinal"].confirmation.$put(
          { param: { ordinal: String(record.trackOrdinal) }, query: { gameId: record.gameId } },
          { init: jsonRequestInit(confirmation) },
        ),
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
      await responseJson<TrackConfiguration>(
        await devClient.api.dev["track-configurations"][":ordinal"].confirmation.$delete({
          param: { ordinal: String(record.trackOrdinal) },
          query: { gameId: record.gameId },
        }),
      );
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
          <span className="block truncate font-mono text-xs font-semibold text-app-accent">{record.gameId}</span>
          <span className="block truncate text-app-caption text-app-text-muted">
            {record.name}
            {record.variant ? ` · ${record.variant}` : ""} · #{record.trackOrdinal}
            {record.location ? ` · ${record.location}` : ""}
          </span>
        </span>
        <span className={`rounded border px-1.5 py-0.5 text-app-micro font-medium ${badge.className}`}>{badge.label}</span>
      </summary>
      <div className="border-t border-app-border px-2 py-2">
        <div className="mb-2 flex flex-wrap gap-1 text-app-caption text-app-text-muted">
          {canonical && <span className="rounded bg-app-surface-alt px-1.5 py-0.5 font-mono">{canonical}</span>}
          {record.hasImagery && <span className="rounded bg-app-accent/10 px-1.5 py-0.5 text-app-accent">Imagery configured</span>}
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          <Button type="button" onClick={() => onAssign(record)}>
            {record.configuration ? "Edit assignment" : "Assign track"}
          </Button>
          <Button type="button" onClick={() => onSelect(selection)}>
            {selected ? "Workbench open" : "Open workbench"}
          </Button>
        </div>
        {record.configuration?.confirmation ? (
          <div className="rounded border border-severity-nominal/30 bg-severity-nominal/5 p-2 text-app-caption text-app-text-secondary">
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
              className="min-w-0 rounded border border-app-border-input bg-app-bg px-2 py-1 text-app-caption text-app-text"
              value={confirmedBy}
              onChange={(event) => onConfirmedByChange(event.target.value)}
              placeholder="Confirmed by"
            />
            <input
              className="min-w-0 rounded border border-app-border-input bg-app-bg px-2 py-1 font-mono text-app-caption text-app-text"
              value={commitId}
              onChange={(event) => onCommitIdChange(event.target.value)}
              placeholder="Commit ID (optional)"
            />
            <Button type="button" onClick={() => void confirm()} disabled={!record.configuration || !confirmedBy.trim() || saving}>
              Confirm
            </Button>
          </div>
        )}
        {error && <p className="mt-1 text-app-caption text-severity-critical">{error}</p>}
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
  onAssign,
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
  onAssign: (record: TrackRecord) => void;
  onSelect: (selection: TrackConfigurationSelection) => void;
  onChanged: () => Promise<void>;
}) {
  const layouts = new Map<string, { segment: TrackIdentityNode; records: TrackRecord[] }>();
  for (const record of node.tracks) {
    const segment = record.configuration?.track ?? { id: slug(record.variant || "Main"), name: record.variant || "Main" };
    const layout = layouts.get(segment.id) ?? { segment, records: [] };
    layout.records.push(record);
    layouts.set(segment.id, layout);
  }
  const children = [...node.children.values()].sort((a, b) => a.segment.name.localeCompare(b.segment.name));
  return (
    <details key={`${node.path}:${filterActive}`} className="ml-2 border-l border-app-border pl-2" open={filterActive || node.segment.id === "unassigned" ? true : undefined}>
      <summary className="cursor-pointer list-none py-1 text-xs font-semibold text-app-text-secondary [&::-webkit-details-marker]:hidden">
        <span className="mr-1 text-app-text-muted">›</span>
        {node.segment.name} <span className="font-normal text-app-text-muted">({countNodeTracks(node)})</span>
      </summary>
      <div className="space-y-1 pb-1">
        {[...layouts.values()]
          .sort((a, b) => a.segment.name.localeCompare(b.segment.name))
          .map((layout) => (
            <details key={`${node.path}:${layout.segment.id}:${filterActive}`} className="ml-2" open={filterActive ? true : undefined}>
              <summary className="cursor-pointer list-none py-1 text-app-compact font-semibold text-app-text [&::-webkit-details-marker]:hidden">
                {layout.segment.name} <span className="font-normal text-app-text-muted">({layout.records.length})</span>
              </summary>
              <div className="space-y-1 pl-2">
                {layout.records
                  .sort((a, b) => a.gameId.localeCompare(b.gameId) || a.trackOrdinal - b.trackOrdinal)
                  .map((record) => (
                    <TrackRow
                      key={key(record.gameId, record.trackOrdinal)}
                      record={record}
                      selected={selectedKey === key(record.gameId, record.trackOrdinal)}
                      confirmedBy={confirmedBy}
                      commitId={commitId}
                      onConfirmedByChange={onConfirmedByChange}
                      onCommitIdChange={onCommitIdChange}
                      onAssign={onAssign}
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
            onAssign={onAssign}
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
  className,
}: {
  selection: TrackConfigurationSelection | null;
  onSelect: (selection: TrackConfigurationSelection) => void;
  onConfigurationChange: () => void;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [assigning, setAssigning] = useState<TrackRecord | null>(null);
  const [confirmedBy, setConfirmedBy] = useLocalStorage("track-configuration-confirmed-by", "");
  const [commitId, setCommitId] = useLocalStorage("track-configuration-commit-id", "");
  const catalogQueries = useQueries({
    queries: KNOWN_GAME_IDS.map((gameId) => ({
      queryKey: ["tracks", gameId],
      queryFn: async () => responseJson<CatalogTrack[]>(await client.api.tracks.$get({ query: { gameId } })),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const configurationQuery = useQuery({
    queryKey: ["track-configurations"],
    queryFn: async () => responseJson<TrackConfiguration[]>(await devClient.api.dev["track-configurations"].$get()),
  });
  const imageryQuery = useQuery({
    queryKey: ["track-imagery-configurations"],
    queryFn: async () => responseJson<TrackImageryConfigurationIndex>(await devClient.api.dev["track-imagery"].$get()),
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
        commonTrackName: track.commonTrackName ?? "",
        configuration: configurations.get(key(gameId, track.ordinal)) ?? null,
        hasImagery: imagery.has(key(gameId, track.ordinal)),
      }));
    });
  }, [catalogQueries, configurationQuery.data, imageryQuery.data]);

  const suggestions = useMemo<AssignmentSuggestions>(() => {
    const venues = new Set<string>();
    const subVenues = new Set<string>();
    const tracks = new Set<string>(["Main"]);
    for (const record of records) {
      if (record.name) venues.add(record.name);
      if (record.variant) tracks.add(record.variant);
      if (record.commonTrackName) tracks.add(displaySegment(record.commonTrackName));
      const configuration = record.configuration;
      if (!configuration) continue;
      venues.add(configuration.venue.name);
      for (const entry of configuration.subVenues) subVenues.add(entry.name);
      tracks.add(configuration.track.name);
    }
    return {
      venues: [...venues].sort((a, b) => a.localeCompare(b)),
      subVenues: [...subVenues].sort((a, b) => a.localeCompare(b)),
      tracks: [...tracks].sort((a, b) => a.localeCompare(b)),
    };
  }, [records]);

  const normalizedFilter = filter.trim().toLowerCase();
  const filteredRecords = records.filter((record) => {
    if (statusFilter !== "all" && statusFor(record) !== statusFilter) return false;
    if (!normalizedFilter) return true;
    const configuration = record.configuration;
    return [
      record.name,
      record.variant,
      record.location,
      record.commonTrackName,
      record.gameId,
      String(record.trackOrdinal),
      configuration ? trackConfigurationCanonicalId(configuration) : "",
      configuration?.venue.name ?? "",
      ...(configuration?.subVenues.map((entry) => entry.name) ?? []),
      configuration?.track.name ?? "",
    ].some((value) => value.toLowerCase().includes(normalizedFilter));
  });
  const venueTree = new Map<string, VenueNode>();
  for (const venue of imageryQuery.data?.venues ?? []) {
    insertVenue(
      venueTree,
      venue.venueId.split("/").map((id) => ({ id, name: displaySegment(id) })),
    );
  }
  for (const configuration of configurationQuery.data ?? []) insertVenue(venueTree, [configuration.venue, ...configuration.subVenues]);
  for (const record of filteredRecords) {
    const segments = record.configuration ? [record.configuration.venue, ...record.configuration.subVenues] : [{ id: "unassigned", name: "Unassigned" }];
    insertVenue(venueTree, segments).tracks.push(record);
  }
  const statusCounts = { unassigned: 0, unconfirmed: 0, confirmed: 0 };
  for (const record of records) statusCounts[statusFor(record)] += 1;
  const selectedKey = selection ? key(selection.gameId, selection.trackOrdinal) : null;
  const loading = catalogQueries.some((query) => query.isLoading) || configurationQuery.isLoading || imageryQuery.isLoading;
  const loadError = catalogQueries.find((query) => query.error)?.error ?? configurationQuery.error ?? imageryQuery.error;
  const changed = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["track-configurations"] }),
      queryClient.invalidateQueries({ queryKey: ["track-imagery-configurations"] }),
      ...KNOWN_GAME_IDS.map((gameId) => queryClient.invalidateQueries({ queryKey: ["tracks", gameId] })),
    ]);
    onConfigurationChange();
  };
  const saveAssignment = async (record: TrackRecord, configuration: Omit<TrackConfiguration, "confirmation">) => {
    await responseJson<TrackConfiguration>(
      await devClient.api.dev["track-configurations"][":ordinal"].$put(
        { param: { ordinal: String(record.trackOrdinal) }, query: { gameId: record.gameId } },
        { init: jsonRequestInit({ ...configuration, confirmation: null }) },
      ),
    );
    await changed();
  };

  return (
    <section className={`flex min-h-0 flex-col border-r border-app-border bg-app-bg ${className ?? ""}`}>
      <div className="border-b border-app-border p-3">
        <h1 className="text-base font-semibold text-app-text">Track configuration</h1>
        <p className="mb-2 text-app-compact text-app-text-muted">All simulator catalogs grouped by canonical track, layout, then game ID.</p>
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
              className={`rounded border px-1.5 py-1 text-app-caption ${statusFilter === value ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-app-border text-app-text-muted"}`}
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
          .sort((a, b) => (a.segment.id === "unassigned" ? 1 : b.segment.id === "unassigned" ? -1 : a.segment.name.localeCompare(b.segment.name)))
          .map((venue) => (
            <VenueNodeView
              key={venue.path}
              node={venue}
              filterActive={!!normalizedFilter || statusFilter !== "all"}
              selectedKey={selectedKey}
              confirmedBy={confirmedBy}
              commitId={commitId}
              onConfirmedByChange={setConfirmedBy}
              onCommitIdChange={setCommitId}
              onAssign={setAssigning}
              onSelect={onSelect}
              onChanged={changed}
            />
          ))}
      </div>
      {assigning && <AssignmentModal record={assigning} suggestions={suggestions} onClose={() => setAssigning(null)} onSave={saveAssignment} />}
    </section>
  );
}
