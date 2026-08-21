import type {
  EligibilityDecision,
  EligibilityPolicyId,
  EligibilityReason,
  EligibilityStatus,
  EvidenceSourceKind,
  LapQualitySummary,
  QualityFact,
  QualityReasonCode,
} from "@shared/racing/quality/contracts";
import type { GameId } from "@shared/games/ids";
import { resolveEligibilityDecision } from "@shared/racing/quality/policies";
import type { LapMeta } from "@shared/racing/sessions/types";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { qualityUpdatedQueryKeys, queryKeys } from "../hooks/query-keys";
import { useGameId } from "../stores/game";
import { m } from "../paraglide/messages";
import { getLocale } from "../paraglide/runtime";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";

const POLICY_LABELS: Record<EligibilityPolicyId, () => string> = {
  "official-timing": m.quality_policy_official_timing,
  "normal-pace": m.quality_policy_normal_pace,
  "lap-comparison": m.quality_policy_lap_comparison,
  "corner-trace": m.quality_policy_corner_trace,
  "transient-event": m.quality_policy_transient_event,
  "fuel-burn": m.quality_policy_fuel_burn,
  "tire-analysis": m.quality_policy_tire_analysis,
  "stint-falloff": m.quality_policy_stint_falloff,
  "setup-analysis": m.quality_policy_setup_analysis,
  "driver-profile": m.quality_policy_driver_profile,
  "ml-training": m.quality_policy_ml_training,
};

const STATUS_LABELS: Record<EligibilityStatus, () => string> = {
  eligible: m.quality_status_eligible,
  eligible_with_warning: m.quality_status_eligible_with_warning,
  ineligible: m.quality_status_ineligible,
  unknown: m.quality_status_unknown,
};

const REASON_LABELS: Record<QualityReasonCode, () => string> = {
  quality_not_rebuilt: m.quality_reason_quality_not_rebuilt,
  quality_stale: m.quality_reason_quality_stale,
  recording_unavailable: m.quality_reason_recording_unavailable,
  recording_incompatible: m.quality_reason_recording_incompatible,
  recording_corrupt: m.quality_reason_recording_corrupt,
  recording_incomplete: m.quality_reason_recording_incomplete,
  telemetry_gap_minor: m.quality_reason_telemetry_gap_minor,
  telemetry_gap_major: m.quality_reason_telemetry_gap_major,
  duplicate_observations: m.quality_reason_duplicate_observations,
  out_of_order_observations: m.quality_reason_out_of_order_observations,
  timeline_discontinuity: m.quality_reason_timeline_discontinuity,
  source_reconnect: m.quality_reason_source_reconnect,
  writer_drop: m.quality_reason_writer_drop,
  lap_time_fallback: m.quality_reason_lap_time_fallback,
  lap_time_unconfirmed: m.quality_reason_lap_time_unconfirmed,
  partial_track_coverage: m.quality_reason_partial_track_coverage,
  position_unavailable: m.quality_reason_position_unavailable,
  channel_unavailable: m.quality_reason_channel_unavailable,
  channel_missing: m.quality_reason_channel_missing,
  channel_stale: m.quality_reason_channel_stale,
  channel_invalid: m.quality_reason_channel_invalid,
  channel_simplified: m.quality_reason_channel_simplified,
  channel_derived: m.quality_reason_channel_derived,
  pit_only_updates: m.quality_reason_pit_only_updates,
  interpolated_channel: m.quality_reason_interpolated_channel,
  fallback_channel: m.quality_reason_fallback_channel,
  incident_lap: m.quality_reason_incident_lap,
  caution_context: m.quality_reason_caution_context,
  traffic_context: m.quality_reason_traffic_context,
  partial_lap: m.quality_reason_partial_lap,
  non_pace_classification: m.quality_reason_non_pace_classification,
  structurally_invalid: m.quality_reason_structurally_invalid,
  imported_source: m.quality_reason_imported_source,
  remote_packet_loss: m.quality_reason_remote_packet_loss,
  opponent_channel_unavailable: m.quality_reason_opponent_channel_unavailable,
  pace_segment_missing: m.quality_reason_pace_segment_missing,
  insufficient_sample_pool: m.quality_reason_insufficient_sample_pool,
  driver_inconsistent: m.quality_reason_driver_inconsistent,
  provenance_missing: m.quality_reason_provenance_missing,
  identity_unstable: m.quality_reason_identity_unstable,
  raw_redecode_required: m.quality_reason_raw_redecode_required,
};

export type QualityLevel = "good" | "degraded" | "unsuitable" | "stale" | "unknown";
type BadgeVariant = "success" | "warning" | "danger" | "neutral";

const LEVEL_PRESENTATION: Record<QualityLevel, { label: () => string; summary: () => string; variant: BadgeVariant }> = {
  good: { label: m.quality_badge_good, summary: m.quality_summary_good, variant: "success" },
  degraded: { label: m.quality_badge_degraded, summary: m.quality_summary_degraded, variant: "warning" },
  unsuitable: { label: m.quality_badge_unsuitable, summary: m.quality_summary_unsuitable, variant: "danger" },
  stale: { label: m.quality_badge_stale, summary: m.quality_summary_stale, variant: "warning" },
  unknown: { label: m.quality_badge_unknown, summary: m.quality_summary_unknown, variant: "neutral" },
};

const STATUS_VARIANTS: Record<EligibilityStatus, BadgeVariant> = {
  eligible: "success",
  eligible_with_warning: "warning",
  ineligible: "danger",
  unknown: "neutral",
};

export function localizedEligibilityDecisionPresentation(decision: EligibilityDecision | null | undefined): { status: string; firstReason: string | null; text: string } {
  const status = decision ? STATUS_LABELS[decision.status]() : m.quality_status_unknown();
  const firstReasonCode = decision?.reasons[0]?.code;
  const firstReason = firstReasonCode ? REASON_LABELS[firstReasonCode]() : null;
  return {
    status,
    firstReason,
    text: firstReason ? `${status}: ${firstReason}` : status,
  };
}

export function localizedEligibilityDecisionText(decision: EligibilityDecision | null | undefined): string {
  return localizedEligibilityDecisionPresentation(decision).text;
}

export function resolveLapQualityLevel(quality: LapQualitySummary | null | undefined, decision: EligibilityDecision | null | undefined): QualityLevel {
  if (decision?.reasons.some((reason) => reason.code === "quality_stale")) return "stale";
  if (!quality || !decision || decision.status === "unknown") return "unknown";
  if (decision.status === "ineligible") return "unsuitable";
  if (decision.status === "eligible_with_warning" || quality.lifecycleState !== "exact") return "degraded";
  return "good";
}

function lifecyclePresentation(quality: LapQualitySummary | null | undefined): { label: string; variant: BadgeVariant } {
  switch (quality?.lifecycleState) {
    case "exact":
      return { label: m.quality_lifecycle_exact(), variant: "success" };
    case "minor_gaps":
      return { label: m.quality_lifecycle_minor_gaps(), variant: "warning" };
    case "degraded":
      return { label: m.quality_lifecycle_degraded(), variant: "warning" };
    case "incomplete":
      return { label: m.quality_lifecycle_incomplete(), variant: "danger" };
    case "corrupt":
      return { label: m.quality_lifecycle_unavailable(), variant: "danger" };
    default:
      return { label: m.quality_lifecycle_unavailable(), variant: "neutral" };
  }
}

type DiagnosticReason = Pick<EligibilityReason, "code" | "timeRange" | "distanceRange" | "semanticIds" | "evidenceIds"> & { key: string; eventIds: string[] };

export function diagnosticReasons(quality: LapQualitySummary | null | undefined, decisions: readonly EligibilityDecision[]): DiagnosticReason[] {
  const factReasons =
    quality?.facts.map((fact: QualityFact) => ({
      code: fact.code,
      timeRange: fact.timeRange,
      distanceRange: fact.distanceRange ?? null,
      semanticIds: fact.semanticIds,
      evidenceIds: [fact.id],
      eventIds: fact.eventIds,
    })) ?? [];
  const factIds = new Set(factReasons.flatMap(({ evidenceIds }) => evidenceIds));
  const decisionReasons = decisions.flatMap((decision) =>
    decision.reasons
      .filter((reason) => reason.evidenceIds.length === 0 || !reason.evidenceIds.every((evidenceId) => factIds.has(evidenceId)))
      .map((reason) => ({
        ...reason,
        eventIds: [],
      })),
  );
  const merged = new Map<string, DiagnosticReason>();
  for (const item of [...factReasons, ...decisionReasons]) {
    const key = JSON.stringify([item.code, [...item.semanticIds].sort(), item.timeRange, item.distanceRange]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        key,
        ...item,
        semanticIds: [...item.semanticIds],
        evidenceIds: [...item.evidenceIds],
        eventIds: [...item.eventIds],
      });
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...item.evidenceIds])].sort();
    existing.eventIds = [...new Set([...existing.eventIds, ...item.eventIds])].sort();
  }
  return [...merged.values()];
}

export function mergeQualityDialogDecisions(
  persistedDecisions: readonly EligibilityDecision[],
  policyId: EligibilityPolicyId,
  selectedDecision: EligibilityDecision | null | undefined,
): EligibilityDecision[] {
  return [...persistedDecisions.filter((item) => item.policyId !== policyId), ...(selectedDecision ? [selectedDecision] : [])];
}

export function formatReasonRange(reason: DiagnosticReason): string | null {
  if (reason.distanceRange) {
    const percent = new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 1 });
    return `${m.quality_range_lap()} ${percent.format(reason.distanceRange.startFraction)}–${percent.format(reason.distanceRange.endFraction)}`;
  }
  if (reason.timeRange) {
    const seconds = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 });
    return `${m.quality_range_time()} ${seconds.format(reason.timeRange.startMs / 1_000)}–${seconds.format(reason.timeRange.endMs / 1_000)} s`;
  }
  return null;
}

function percent(value: number | null): string {
  return value == null ? m.quality_not_available() : new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatCount(value: number | null): string {
  return value == null ? m.quality_not_available() : new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(value);
}

function formatMilliseconds(value: number): string {
  return `${formatCount(value)} ms`;
}

export interface SessionQualityStatus {
  action: "current" | "rebuild_eligibility" | "reprocess" | "unavailable";
}
export async function getSessionQualityStatus(sessionId: number, gameId: GameId) {
  const response = await client.api.sessions[":id"].quality.$get({ param: { id: String(sessionId) }, query: { gameId } });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

export async function rebuildSessionQuality(sessionId: number, gameId: GameId) {
  const response = await client.api.sessions[":id"].quality.rebuild.$post({ param: { id: String(sessionId) }, query: { gameId } });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

export async function invalidateSessionQualityQueries(queryClient: Pick<QueryClient, "invalidateQueries">, sessionId: number, gameId: GameId): Promise<void> {
  await Promise.all(qualityUpdatedQueryKeys(sessionId, gameId).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}


export interface QualityRebuildStatusProps {
  action: SessionQualityStatus["action"] | undefined;
  statusPending: boolean;
  statusFetching: boolean;
  statusError: boolean;
  rebuildPending: boolean;
  rebuildError: boolean;
  rebuildSuccess: boolean;
  onRetry: () => void;
  onRebuild: () => void;
}

export function QualityRebuildStatus({ action, statusPending, statusFetching, statusError, rebuildPending, rebuildError, rebuildSuccess, onRetry, onRebuild }: QualityRebuildStatusProps): ReactNode {
  let liveStatus: ReactNode = null;
  if (rebuildError) {
    liveStatus = (
      <p role="alert" className="text-app-caption text-status-danger">
        {m.quality_rebuild_failed()}
      </p>
    );
  } else if (statusError) {
    liveStatus = (
      <div role="alert" className="flex items-center justify-between gap-3 text-app-caption text-status-danger">
        <span>{m.quality_status_load_failed()}</span>
        <Button variant="app-outline" size="app-sm" onClick={onRetry} disabled={statusFetching}>
          {m.label_retry()}
        </Button>
      </div>
    );
  } else if (rebuildPending) {
    liveStatus = (
      <p role="status" aria-live="polite" className="text-app-caption text-app-text-muted">
        {m.quality_rebuilding()}
      </p>
    );
  } else if (rebuildSuccess) {
    liveStatus = (
      <p role="status" aria-live="polite" className="text-app-caption text-status-success">
        {m.quality_rebuilt()}
      </p>
    );
  } else if (statusPending || statusFetching) {
    liveStatus = (
      <p role="status" aria-live="polite" className="text-app-caption text-app-text-muted">
        {m.quality_status_loading()}
      </p>
    );
  } else if (action === "current") {
    liveStatus = (
      <p role="status" aria-live="polite" className="text-app-caption text-status-success">
        {m.quality_status_current()}
      </p>
    );
  } else if (action === "unavailable") {
    liveStatus = (
      <p role="alert" className="text-app-caption text-status-danger">
        {m.quality_rebuild_unavailable()}
      </p>
    );
  }

  return (
    <section aria-label={m.quality_title()} aria-busy={statusPending || statusFetching || rebuildPending || undefined} className="space-y-3">
      {liveStatus}
      {(action === "rebuild_eligibility" || action === "reprocess") && (
        <DialogFooter>
          <Button variant="app-primary" onClick={onRebuild} disabled={rebuildPending}>
            {rebuildPending ? m.quality_rebuilding() : m.quality_rebuild()}
          </Button>
        </DialogFooter>
      )}
    </section>
  );
}

interface LapQualityBadgeProps {
  lap: {
    sessionId?: number | null;
    quality?: LapMeta["quality"] | null;
    eligibility?: LapMeta["eligibility"] | null;
    qualityGeneration?: string | null;
    qualityStale?: boolean;
    source?: EvidenceSourceKind | null;
  };
  policyId?: EligibilityPolicyId;
  size?: "compact" | "default";
  decisionOverride?: EligibilityDecision | null;
}

export function LapQualityBadge({ lap, policyId = "corner-trace", size = "compact", decisionOverride }: LapQualityBadgeProps) {
  const [open, setOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const queryClient = useQueryClient();
  const gameId = useGameId();
  const decision = decisionOverride === undefined ? resolveEligibilityDecision(lap, policyId) : decisionOverride;
  const level = resolveLapQualityLevel(lap.quality, decision);
  const presentation = LEVEL_PRESENTATION[level];
  const recording = lifecyclePresentation(lap.quality);
  const sessionId = lap.sessionId ?? null;
  const statusQuery = useQuery({
    queryKey: queryKeys.sessionQuality(sessionId, gameId),
    enabled: open && sessionId != null && gameId != null,
    queryFn: async () => {
      if (sessionId == null || gameId == null) throw new Error("Missing session game");
      return getSessionQualityStatus(sessionId, gameId);
    },
  });
  const rebuild = useMutation({
    mutationFn: async () => {
      if (sessionId == null || gameId == null) throw new Error("Missing session game");
      return rebuildSessionQuality(sessionId, gameId);
    },
    onSuccess: async () => {
      if (sessionId != null && gameId != null) await invalidateSessionQualityQueries(queryClient, sessionId, gameId);
    },
  });

  const persistedDecisions = lap.eligibility ? Object.values(lap.eligibility) : [];
  const decisions = mergeQualityDialogDecisions(persistedDecisions, policyId, decision);
  const reasons = diagnosticReasons(lap.quality, decisions);
  const eventIds = [...new Set(lap.quality?.facts.flatMap((fact) => fact.eventIds) ?? [])].sort();
  const rebuildAction = statusQuery.data?.action;
  const provenance = lap.quality?.provenance;
  const identity = lap.quality?.versionIdentity;
  const gaps = lap.quality?.gapSummary;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        nativeButton={false}
        render={
          <button
            type="button"
            className="inline-flex cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-app-accent"
            aria-label={`${m.quality_title()}: ${POLICY_LABELS[policyId]()} — ${localizedEligibilityDecisionText(decision)}`}
          />
        }
      >
        <Badge variant={presentation.variant} size={size} title={presentation.summary()} data-quality-level={level}>
          {presentation.label()}
        </Badge>
      </DialogTrigger>
      <DialogContent size="md" layout="scrollable">
        <DialogHeader>
          <DialogTitle>{m.quality_title()}</DialogTitle>
          <DialogDescription>{presentation.summary()}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-app-caption">
          <span className="text-app-text-muted">{m.quality_recording()}</span>
          <Badge variant={recording.variant} size="compact">
            {recording.label}
          </Badge>
          <span className="ml-auto text-app-text-muted">{POLICY_LABELS[policyId]()}</span>
          <Badge variant={decision ? STATUS_VARIANTS[decision.status] : "neutral"} size="compact">
            {decision ? STATUS_LABELS[decision.status]() : m.quality_status_unknown()}
          </Badge>
        </div>

        <section className="space-y-2">
          <h3 className="text-app-caption font-semibold text-app-text">{m.quality_policies()}</h3>
          <div className="divide-y divide-app-border rounded-lg border border-app-border">
            {decisions.map((item) => (
              <div key={item.policyId} className="flex items-center justify-between gap-3 px-3 py-2 text-app-caption">
                <span>{POLICY_LABELS[item.policyId]()}</span>
                <span className="flex items-center gap-2">
                  {item.confidence.score != null && <span className="font-mono text-app-micro text-app-text-muted">{percent(item.confidence.score)}</span>}
                  <Badge variant={STATUS_VARIANTS[item.status]} size="compact">
                    {STATUS_LABELS[item.status]()}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-app-caption font-semibold text-app-text">{m.quality_reasons()}</h3>
          {reasons.length === 0 ? (
            <p className="text-app-caption text-app-text-muted">{m.quality_no_limits()}</p>
          ) : (
            <ul className="space-y-2 text-app-caption text-app-text-muted">
              {reasons.map((reason) => {
                const range = formatReasonRange(reason);
                return (
                  <li key={reason.key} className="rounded-md border border-app-border px-3 py-2">
                    <div className="text-app-text">{REASON_LABELS[reason.code]()}</div>
                    {range && <div>{range}</div>}
                    {reason.semanticIds.length > 0 && (
                      <div>
                        {m.quality_channels()}: {reason.semanticIds.join(", ")}
                      </div>
                    )}
                    {reason.eventIds.length > 0 && (
                      <div>
                        {m.quality_event_ids()}: {reason.eventIds.join(", ")}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Collapsible open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
          <CollapsibleTrigger render={<Button type="button" variant="app-outline" size="app-sm" className="w-full justify-between" />}>
            {m.quality_diagnostics()}
            <ChevronDown data-icon="inline-end" className={`size-3.5 transition-transform ${diagnosticsOpen ? "rotate-180" : ""}`} />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3 rounded-lg border border-app-border p-3 text-app-caption">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-app-text-muted">{m.quality_source()}</dt>
              <dd>{lap.quality?.sourceKind ?? lap.source ?? "unknown"}</dd>
              <dt className="text-app-text-muted">{m.quality_schema_version()}</dt>
              <dd className="font-mono">{provenance?.schemaVersion ?? m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_policy_version()}</dt>
              <dd className="font-mono">{provenance?.policyVersion ?? m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_configuration_version()}</dt>
              <dd className="font-mono">{provenance?.configurationVersion ?? m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_catalog_version()}</dt>
              <dd className="truncate font-mono" title={identity?.catalogVersion}>
                {identity?.catalogVersion ?? m.quality_not_available()}
              </dd>
              <dt className="text-app-text-muted">{m.quality_parser_version()}</dt>
              <dd className="truncate font-mono" title={identity?.parserVersion}>
                {identity?.parserVersion ?? m.quality_not_available()}
              </dd>
              <dt className="text-app-text-muted">{m.quality_resolver_version()}</dt>
              <dd className="truncate font-mono" title={identity?.resolverVersion}>
                {identity?.resolverVersion ?? m.quality_not_available()}
              </dd>
              <dt className="text-app-text-muted">{m.quality_derivation_version()}</dt>
              <dd className="truncate font-mono" title={identity?.derivationVersion}>
                {identity?.derivationVersion ?? m.quality_not_available()}
              </dd>
              <dt className="text-app-text-muted">{m.quality_frames_observed()}</dt>
              <dd className="font-mono">{gaps ? formatCount(gaps.observedCount) : m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_frames_expected()}</dt>
              <dd className="font-mono">{gaps ? formatCount(gaps.expectedCount) : m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_frames_missing()}</dt>
              <dd className="font-mono">{gaps ? formatCount(gaps.totalMissingCount) : m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_largest_gap()}</dt>
              <dd className="font-mono">{gaps ? formatMilliseconds(gaps.largestContiguousGapMs) : m.quality_not_available()}</dd>
              <dt className="text-app-text-muted">{m.quality_source_generation()}</dt>
              <dd className="truncate font-mono text-app-micro" title={provenance?.sourceGeneration}>
                {provenance?.sourceGeneration ?? m.quality_not_available()}
              </dd>
              <dt className="text-app-text-muted">{m.quality_generation()}</dt>
              <dd className="truncate font-mono text-app-micro" title={provenance?.outputGeneration ?? lap.qualityGeneration ?? undefined}>
                {provenance?.outputGeneration ?? lap.qualityGeneration ?? m.quality_not_available()}
              </dd>
            </dl>

            <div className="space-y-1">
              <h4 className="font-semibold text-app-text">{m.quality_channels()}</h4>
              {lap.quality?.channelQuality.length ? (
                <div className="space-y-1">
                  {lap.quality.channelQuality.map((channel) => (
                    <div key={channel.semanticId} className="rounded-md bg-app-surface-alt/40 px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono" title={channel.semanticId}>
                          {channel.semanticId}
                        </span>
                        <span className="shrink-0">
                          {channel.mappingStatus} · {percent(channel.coverage)}
                        </span>
                      </div>
                      <div className="text-app-text-muted">
                        {m.quality_freshness()}: {formatCount(channel.freshnessCounts.fresh)} / {formatCount(channel.freshnessCounts.stale)} / {formatCount(channel.freshnessCounts.unknown)}
                      </div>
                      {channel.limitations.length > 0 && (
                        <div className="text-app-text-muted">
                          {m.quality_limitations()}: {channel.limitations.join("; ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-app-text-muted">{m.quality_not_available()}</p>
              )}
            </div>

            <div className="space-y-1">
              <h4 className="font-semibold text-app-text">{m.quality_event_ids()}</h4>
              <p className="break-all font-mono text-app-micro text-app-text-muted">{eventIds.length > 0 ? eventIds.join(", ") : m.quality_not_available()}</p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <QualityRebuildStatus
          action={rebuildAction}
          statusPending={statusQuery.isPending}
          statusFetching={statusQuery.isFetching}
          statusError={statusQuery.isError}
          rebuildPending={rebuild.isPending}
          rebuildError={rebuild.isError}
          rebuildSuccess={rebuild.isSuccess}
          onRetry={() => void statusQuery.refetch()}
          onRebuild={() => rebuild.mutate()}
        />
      </DialogContent>
    </Dialog>
  );
}
