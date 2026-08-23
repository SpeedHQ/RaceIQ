import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GameId } from "@shared/games/ids";
import type { CornerFact } from "@shared/racing/tracks/facts";
import type { TrackGuideCornerFile, TrackGuideFile } from "@shared/racing/tracks/guide/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchMultiSelect } from "@/components/ui/SearchMultiSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { devClient } from "@/lib/rpc";
import { cloneTrackGuide, emptyTrackGuide, type TrackGuideDraft, type TrackGuideEnvelope, publicTrackGuideQueryKey } from "./track-guide-types";

export interface TrackGuideEditorProps {
  gameId: GameId;
  trackOrdinal: number;
}

export class TrackGuideMissingSlugError extends Error {
  constructor() {
    super("Track slug not found for selected track");
    this.name = "TrackGuideMissingSlugError";
  }
}

interface GuideQueryError extends Error {
  status?: number;
}

interface GuideValidation {
  character?: string;
  corners: Record<number, string[]>;
  priority?: string;
  valid: boolean;
}

function guideQueryKey(trackOrdinal: number, gameId: GameId) {
  return ["dev-track-guide", trackOrdinal, gameId] as const;
}

async function readGuideEnvelope(trackOrdinal: number, gameId: GameId): Promise<TrackGuideEnvelope> {
  const response = await devClient.api.dev["track-guides"][":ordinal"].$get({
    param: { ordinal: String(trackOrdinal) },
    query: { gameId },
  });
  const body = (await response.json().catch(() => null)) as TrackGuideEnvelope | { error?: string } | null;
  if (response.status === 404 && (body as { error?: string } | null)?.error === "Track slug not found for selected track") {
    throw new TrackGuideMissingSlugError();
  }
  if (!response.ok) {
    const error = new Error((body as { error?: string } | null)?.error ?? `Unable to load track guide (${response.status})`) as GuideQueryError;
    error.status = response.status;
    throw error;
  }
  return body as TrackGuideEnvelope;
}

export function useTrackGuideEnvelope(gameId: GameId, trackOrdinal: number) {
  return useQuery<TrackGuideEnvelope, GuideQueryError>({
    queryKey: guideQueryKey(trackOrdinal, gameId),
    queryFn: () => readGuideEnvelope(trackOrdinal, gameId),
    staleTime: 0,
  });
}

function cornerNumbers(corner: CornerFact): number[] {
  return [corner.number, ...(corner.covers ?? [])];
}

function validateDraft(draft: TrackGuideDraft): GuideValidation {
  const corners: Record<number, string[]> = {};
  const keys = new Set<string>();
  const duplicateKeys = new Set<string>();
  if (draft.character.trim().length === 0) return { character: "Character is required", corners, valid: false };
  if (draft.corners.length === 0) {
    corners[-1] = ["At least one corner is required"];
    return { corners, valid: false };
  }
  for (const [index, corner] of draft.corners.entries()) {
    const errors: string[] = [];
    const key = corner.key.trim();
    if (!key) errors.push("Key is required");
    else if (keys.has(key)) {
      duplicateKeys.add(key);
      errors.push(`Duplicate key: ${key}`);
    }
    keys.add(key);
    for (const field of ["name", "type", "technique", "trap"] as const) {
      if (!corner[field].trim()) errors.push(`${field[0].toUpperCase()}${field.slice(1)} is required`);
    }
    if (corner.numbers && corner.numbers.length === 0) errors.push("Remove empty turn anchor selection");
    if (errors.length > 0) corners[index] = errors;
  }
  const prioritySeen = new Set<string>();
  for (const key of draft.priorityCorners) {
    if (!keys.has(key)) {
      corners[-1] ??= [];
      corners[-1].push(`Priority key does not match a corner: ${key}`);
    }
    if (prioritySeen.has(key)) {
      corners[-1] ??= [];
      corners[-1].push(`Priority key listed twice: ${key}`);
    }
    prioritySeen.add(key);
  }
  if (duplicateKeys.size > 0) {
    corners[-1] ??= [];
    corners[-1].push(`Duplicate corner keys: ${[...duplicateKeys].join(", ")}`);
  }
  const valid = Object.keys(corners).length === 0;
  return { corners, valid };
}

function formatGuideError(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to save track guide";
}

function initialDraft(envelope: TrackGuideEnvelope): TrackGuideDraft {
  return envelope.guide ? cloneTrackGuide(envelope.guide) : emptyTrackGuide(envelope.slug);
}

function factsTurnOptions(envelope: TrackGuideEnvelope) {
  const facts = envelope.facts;
  if (!facts) return [];
  const allNumbers = new Set<number>();
  for (const corner of facts.corners) for (const number of cornerNumbers(corner)) allNumbers.add(number);
  return [...allNumbers].sort((a, b) => a - b).map((number) => ({ key: number, label: `T${number}` }));
}

function guideSavePayload(draft: TrackGuideDraft): TrackGuideFile {
  const sources = draft.sources?.trim();
  const notes = draft.notes?.trim();
  return {
    ...draft,
    character: draft.character.trim(),
    sources: sources || undefined,
    notes: notes || undefined,
    corners: draft.corners.map((corner) => ({
      ...corner,
      key: corner.key.trim(),
      name: corner.name.trim(),
      type: corner.type.trim(),
      technique: corner.technique.trim(),
      trap: corner.trap.trim(),
    })),
  };
}

function Preview({ envelope }: { envelope: TrackGuideEnvelope }) {
  if (!envelope.resolved) {
    return <p className="text-sm text-muted-foreground">Save guide to generate resolved preview.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">{envelope.resolved.id}</p>
        <p className="text-sm text-muted-foreground">{envelope.resolved.character}</p>
      </div>
      <div className="flex flex-col gap-2">
        {envelope.resolved.corners.map((corner) => (
          <div key={`${corner.label}-${corner.numbers?.join("-") ?? ""}`} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{corner.label}</p>
              {corner.priority && <span className="text-xs text-muted-foreground">Priority</span>}
            </div>
            <p className="text-sm text-muted-foreground">{[corner.type, corner.technique, corner.trap].filter(Boolean).join(" · ")}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrackGuideEditor({ gameId, trackOrdinal }: TrackGuideEditorProps) {
  const queryClient = useQueryClient();
  const query = useTrackGuideEnvelope(gameId, trackOrdinal);
  const [draft, setDraft] = useState<TrackGuideDraft | null>(null);
  const [persistedKeys, setPersistedKeys] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    const next = initialDraft(query.data);
    setDraft(next);
    setPersistedKeys(new Set(query.data.guide?.corners.map((corner) => corner.key) ?? []));
    setSaveError(null);
    setSaved(false);
  }, [query.data]);

  const validation = useMemo(() => (draft ? validateDraft(draft) : { corners: {}, valid: false }), [draft]);
  const turnOptions = useMemo(() => (query.data ? factsTurnOptions(query.data) : []), [query.data]);

  if (query.isLoading) {
    return (
      <div className="grid gap-4 @5xl/workspace:grid-cols-2">
        <Skeleton className="h-[36rem]" />
        <Skeleton className="h-[36rem]" />
      </div>
    );
  }
  if (query.error instanceof TrackGuideMissingSlugError) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Canonical track assignment required</EmptyTitle>
          <EmptyDescription>This track has no canonical guide slug. Assign its canonical track before authoring a guide.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <p className="text-sm text-muted-foreground">Guide file path cannot be chosen safely from display name.</p>
        </EmptyContent>
      </Empty>
    );
  }
  if (query.error || !query.data || !draft) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load guide</AlertTitle>
        <AlertDescription>{formatGuideError(query.error)}</AlertDescription>
      </Alert>
    );
  }

  const envelope = query.data;
  const updateDraft = (patch: Partial<TrackGuideDraft>) => {
    setSaved(false);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const updateCorner = (index: number, patch: Partial<TrackGuideCornerFile>) => {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      const previous = current.corners[index];
      const nextCorner = { ...previous, ...patch };
      const priorityCorners = patch.key && patch.key !== previous.key ? current.priorityCorners.map((key) => (key === previous.key ? nextCorner.key : key)) : current.priorityCorners;
      return { ...current, corners: current.corners.map((corner, i) => (i === index ? nextCorner : corner)), priorityCorners };
    });
  };
  const moveCorner = (index: number, direction: -1 | 1) => {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.corners.length) return current;
      const corners = [...current.corners];
      [corners[index], corners[nextIndex]] = [corners[nextIndex], corners[index]];
      return { ...current, corners };
    });
  };
  const removeCorner = (index: number) => {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      const key = current.corners[index]?.key;
      return { ...current, corners: current.corners.filter((_, i) => i !== index), priorityCorners: current.priorityCorners.filter((priorityKey) => priorityKey !== key) };
    });
  };
  const togglePriority = (key: string, checked: boolean) => {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      if (checked && !current.priorityCorners.includes(key)) return { ...current, priorityCorners: [...current.priorityCorners, key] };
      if (!checked) return { ...current, priorityCorners: current.priorityCorners.filter((priorityKey) => priorityKey !== key) };
      return current;
    });
  };
  const movePriority = (index: number, direction: -1 | 1) => {
    setSaved(false);
    setDraft((current) => {
      if (!current) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.priorityCorners.length) return current;
      const priorityCorners = [...current.priorityCorners];
      [priorityCorners[index], priorityCorners[nextIndex]] = [priorityCorners[nextIndex], priorityCorners[index]];
      return { ...current, priorityCorners };
    });
  };
  const addCorner = () => {
    setSaved(false);
    setDraft((current) => (current ? { ...current, corners: [...current.corners, { key: "", name: "", numbers: undefined, type: "", technique: "", trap: "" }] } : current));
  };

  const saveGuide = async () => {
    if (!validation.valid || query.isFetching || saving) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const response = await devClient.api.dev["track-guides"][":ordinal"].$put(
        { param: { ordinal: String(trackOrdinal) }, query: { gameId } },
        {
          init: {
            body: JSON.stringify(guideSavePayload(draft)),
            headers: { "Content-Type": "application/json" },
          },
        },
      );
      const body = (await response.json().catch(() => null)) as TrackGuideEnvelope | { error?: string } | null;
      if (!response.ok) throw new Error((body as { error?: string } | null)?.error ?? `Unable to save track guide (${response.status})`);
      const savedEnvelope = body as TrackGuideEnvelope;
      setDraft(initialDraft(savedEnvelope));
      setPersistedKeys(new Set(savedEnvelope.guide?.corners.map((corner) => corner.key) ?? []));
      setSaved(true);
      queryClient.setQueryData(guideQueryKey(trackOrdinal, gameId), savedEnvelope);
      queryClient.setQueryData(publicTrackGuideQueryKey(trackOrdinal, gameId), savedEnvelope.resolved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: guideQueryKey(trackOrdinal, gameId) }),
        queryClient.invalidateQueries({ queryKey: publicTrackGuideQueryKey(trackOrdinal, gameId) }),
        queryClient.invalidateQueries({ queryKey: ["track-guide", trackOrdinal] }),
        queryClient.invalidateQueries({ queryKey: ["tracks", gameId] }),
      ]);
    } catch (error) {
      setSaveError(formatGuideError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid min-w-0 gap-4 @5xl/workspace:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{envelope.guide ? "Edit track guide" : "Create track guide"}</CardTitle>
          <CardDescription>
            Write English guide content for <span className="font-mono">{envelope.slug}</span>. Existing corner keys stay stable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={validation.character ? true : undefined}>
              <FieldLabel htmlFor="track-guide-character">
                Character <span className="text-destructive">*</span>
              </FieldLabel>
              <Textarea
                id="track-guide-character"
                value={draft.character}
                aria-invalid={validation.character ? true : undefined}
                onChange={(event) => updateDraft({ character: event.target.value })}
              />
              {validation.character && <FieldDescription>{validation.character}</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel htmlFor="track-guide-sources">Sources</FieldLabel>
              <Textarea id="track-guide-sources" value={draft.sources ?? ""} placeholder="Optional provenance" onChange={(event) => updateDraft({ sources: event.target.value || undefined })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="track-guide-notes">Notes</FieldLabel>
              <Textarea id="track-guide-notes" value={draft.notes ?? ""} placeholder="Optional author notes" onChange={(event) => updateDraft({ notes: event.target.value || undefined })} />
            </Field>
          </FieldGroup>

          <FieldSet className="mt-6">
            <FieldLegend variant="label">Corners</FieldLegend>
            <FieldDescription>Use official turn anchors. Anchors stay ascending and unique.</FieldDescription>
            <FieldGroup className="mt-3">
              {draft.corners.map((corner, index) => {
                const errors = validation.corners[index] ?? [];
                const keyIsPersisted = persistedKeys.has(corner.key);
                return (
                  <Card key={`${corner.key || "new"}-${index}`} size="sm" variant="form-section">
                    <CardHeader className="flex flex-row items-start justify-between gap-2">
                      <CardTitle>Corner {index + 1}</CardTitle>
                      <div className="flex gap-1">
                        <Button type="button" size="icon" variant="ghost" aria-label={`Move corner ${index + 1} earlier`} disabled={index === 0} onClick={() => moveCorner(index, -1)}>
                          <ArrowUp data-icon="inline-start" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Move corner ${index + 1} later`}
                          disabled={index === draft.corners.length - 1}
                          onClick={() => moveCorner(index, 1)}
                        >
                          <ArrowDown data-icon="inline-start" />
                        </Button>
                        <Button type="button" size="icon" variant="ghost" aria-label={`Remove corner ${index + 1}`} onClick={() => removeCorner(index)}>
                          <Trash2 data-icon="inline-start" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <FieldGroup>
                        <Field data-invalid={errors.some((error) => error.includes("Key")) || errors.some((error) => error.includes("Duplicate")) ? true : undefined}>
                          <FieldLabel htmlFor={`track-guide-corner-${index}-key`}>
                            Stable key <span className="text-destructive">*</span>
                          </FieldLabel>
                          <Input
                            id={`track-guide-corner-${index}-key`}
                            value={corner.key}
                            disabled={keyIsPersisted}
                            aria-invalid={errors.some((error) => error.includes("key")) ? true : undefined}
                            onChange={(event) => updateCorner(index, { key: event.target.value })}
                          />
                          {keyIsPersisted && <FieldDescription>Persisted key is read-only.</FieldDescription>}
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`track-guide-corner-${index}-name`}>
                            Name <span className="text-destructive">*</span>
                          </FieldLabel>
                          <Input id={`track-guide-corner-${index}-name`} value={corner.name} onChange={(event) => updateCorner(index, { name: event.target.value })} />
                        </Field>
                        <Field>
                          <FieldLabel>
                            Official turn anchors <span className="text-muted-foreground">(optional)</span>
                          </FieldLabel>
                          <SearchMultiSelect
                            buttonLabel={corner.numbers?.length ? corner.numbers.map((number) => `T${number}`).join(", ") : "Select turns"}
                            options={turnOptions}
                            isSelected={(number) => corner.numbers?.includes(number) ?? false}
                            onSelect={(number) =>
                              updateCorner(index, {
                                numbers: (corner.numbers?.includes(number) ? corner.numbers.filter((value) => value !== number) : [...(corner.numbers ?? []), number]).sort((a, b) => a - b),
                              })
                            }
                            onClear={() => updateCorner(index, { numbers: undefined })}
                            searchPlaceholder="Search official turns"
                          />
                        </Field>
                        <div className="grid gap-3 @3xl/workspace:grid-cols-3">
                          {(["type", "technique", "trap"] as const).map((field) => (
                            <Field key={field}>
                              <FieldLabel htmlFor={`track-guide-corner-${index}-${field}`}>
                                {field[0].toUpperCase() + field.slice(1)} <span className="text-destructive">*</span>
                              </FieldLabel>
                              <Textarea id={`track-guide-corner-${index}-${field}`} value={corner[field]} onChange={(event) => updateCorner(index, { [field]: event.target.value })} />
                            </Field>
                          ))}
                        </div>
                        {errors.length > 0 && (
                          <Alert variant="destructive">
                            <AlertDescription>{errors.join(" ")}</AlertDescription>
                          </Alert>
                        )}
                        <Field orientation="horizontal">
                          <Checkbox
                            id={`track-guide-corner-${index}-priority`}
                            checked={draft.priorityCorners.includes(corner.key)}
                            onCheckedChange={(checked) => togglePriority(corner.key, checked === true)}
                          />
                          <FieldLabel htmlFor={`track-guide-corner-${index}-priority`}>Priority corner</FieldLabel>
                        </Field>
                      </FieldGroup>
                    </CardContent>
                  </Card>
                );
              })}
            </FieldGroup>
            <Button type="button" variant="outline" onClick={addCorner}>
              <Plus data-icon="inline-start" />
              Add corner
            </Button>
          </FieldSet>

          <FieldSet className="mt-6">
            <FieldLegend variant="label">Priority order</FieldLegend>
            <FieldDescription>Earlier entries receive higher priority. Membership follows corner checkboxes.</FieldDescription>
            <FieldGroup className="mt-3">
              {draft.priorityCorners.length === 0 && <p className="text-sm text-muted-foreground">No priority corners selected.</p>}
              {draft.priorityCorners.map((key, index) => (
                <div key={`${key}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="truncate text-sm">{key || "(missing key)"}</span>
                  <div className="flex gap-1">
                    <Button type="button" size="icon" variant="ghost" aria-label={`Move priority ${key} earlier`} disabled={index === 0} onClick={() => movePriority(index, -1)}>
                      <ArrowUp data-icon="inline-start" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move priority ${key} later`}
                      disabled={index === draft.priorityCorners.length - 1}
                      onClick={() => movePriority(index, 1)}
                    >
                      <ArrowDown data-icon="inline-start" />
                    </Button>
                  </div>
                </div>
              ))}
            </FieldGroup>
          </FieldSet>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {saveError && (
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}
            {validation.corners[-1]?.map((error) => (
              <p key={error} className="text-sm text-destructive">
                {error}
              </p>
            ))}
            {saved && <p className="text-sm text-muted-foreground">Guide saved</p>}
          </div>
          <Button type="button" disabled={!validation.valid || query.isFetching || saving} onClick={() => void saveGuide()}>
            {saving ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}Save guide
          </Button>
        </CardFooter>
      </Card>

      <Card className="h-fit @5xl/workspace:sticky @5xl/workspace:top-4">
        <CardHeader>
          <CardTitle>Resolved preview</CardTitle>
          <CardDescription>Public Track Info and AI consume this resolved contract after save.</CardDescription>
        </CardHeader>
        <CardContent>
          <Preview envelope={envelope} />
        </CardContent>
      </Card>
    </div>
  );
}
