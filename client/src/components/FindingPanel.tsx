import type {
  FindingConfidence,
  FindingEvidenceRef,
  FindingGenerationReceipt,
  FindingMeasurement,
  FindingNarrative,
  FindingRecord,
  FindingStatus,
  FindingSeverity,
  TelemetryRangeFindingEvidence,
} from "../../../shared/racing/findings/types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { BadgeProps } from "./ui/badge";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const EMPTY_NARRATIVES: readonly FindingNarrative[] = [];

const STATUS_LABELS: Record<FindingStatus, string> = {
  available: "Available",
  unavailable: "Unavailable",
  indeterminate: "Indeterminate",
};

const STATUS_BADGES: Record<FindingStatus, BadgeProps["variant"]> = {
  available: "success",
  unavailable: "neutral",
  indeterminate: "warning",
};

const STATUS_BORDERS: Record<FindingStatus, string> = {
  available: "border-status-success/30",
  unavailable: "border-status-unavailable/40",
  indeterminate: "border-status-warning/40",
};

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  informational: "Informational",
  low: "Low severity",
  medium: "Medium severity",
  high: "High severity",
  critical: "Critical severity",
};

const CONFIDENCE_LABELS: Record<FindingConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  unknown: "Confidence unknown",
};

function humanize(value: string): string {
  const words = value.replace(/[._-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findingBorder(finding: FindingRecord): string {
  return finding.status === "available" && (finding.confidence === "low" || finding.confidence === "unknown")
    ? "border-app-border"
    : STATUS_BORDERS[finding.status];
}

function severityVariant(finding: FindingRecord): BadgeProps["variant"] {
  if (finding.status !== "available" || finding.confidence === "low" || finding.confidence === "unknown") return "neutral";
  if (finding.severity === "critical" || finding.severity === "high") return "danger";
  if (finding.severity === "medium") return "warning";
  if (finding.severity === "informational") return "info";
  return "neutral";
}

function formatMeasurementValue(measurement: FindingMeasurement): string {
  const value = measurement.value;
  if (value == null) return measurement.unavailableReason ?? "Unavailable";
  if (typeof value === "object") return `${value.min}–${value.max}`;
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function formatUncertainty(measurement: FindingMeasurement): string | null {
  if (measurement.uncertainty == null) return null;
  if (typeof measurement.uncertainty === "object") return `${measurement.uncertainty.min}–${measurement.uncertainty.max}`;
  return String(measurement.uncertainty);
}

function evidenceDetail(evidence: FindingEvidenceRef): string | null {
  if (evidence.kind === "telemetry-range") {
    const frameRange = evidence.startFrameIndex == null
      ? null
      : evidence.endFrameIndex == null || evidence.endFrameIndex === evidence.startFrameIndex
        ? `frame ${evidence.startFrameIndex}`
        : `frames ${evidence.startFrameIndex}–${evidence.endFrameIndex}`;
    const timeRange = evidence.startTimestampMs == null
      ? null
      : evidence.endTimestampMs == null || evidence.endTimestampMs === evidence.startTimestampMs
        ? `${evidence.startTimestampMs} ms`
        : `${evidence.startTimestampMs}–${evidence.endTimestampMs} ms`;
    return [frameRange, timeRange, evidence.channel].filter(Boolean).join(" · ") || null;
  }
  if (evidence.kind === "quality-decision") return `${evidence.decisionId} · ${evidence.decision}`;
  if (evidence.kind === "channel") return evidence.channel;
  return null;
}

function narrativesByFinding(narratives: readonly FindingNarrative[]): ReadonlyMap<string, FindingNarrative[]> {
  const byFinding = new Map<string, FindingNarrative[]>();
  for (const narrative of narratives) {
    const candidate = narrative as Partial<FindingNarrative> | null;
    if (
      candidate == null
      || typeof candidate.id !== "string"
      || candidate.id.trim().length === 0
      || !Array.isArray(candidate.findingIds)
      || !candidate.findingIds.every((id: unknown) => typeof id === "string" && id.trim().length > 0)
      || typeof candidate.text !== "string"
      || candidate.text.trim().length === 0
      || typeof candidate.generator !== "string"
      || candidate.generator.trim().length === 0
      || typeof candidate.generationId !== "string"
      || candidate.generationId.trim().length === 0
      || (candidate.createdAt != null && typeof candidate.createdAt !== "string")
    ) continue;
    for (const findingId of candidate.findingIds) {
      const entries = byFinding.get(findingId);
      if (entries) entries.push(narrative);
      else byFinding.set(findingId, [narrative]);
    }
  }
  for (const entries of byFinding.values()) entries.sort((left, right) => compareText(left.id, right.id));
  return byFinding;
}

function EvidenceList({ title, evidence }: { title: string; evidence: FindingEvidenceRef[] }) {
  if (evidence.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4 className="text-app-micro font-semibold uppercase tracking-wider text-app-text-dim">{title}</h4>
      <ul className="mt-1 space-y-1 text-app-caption text-app-text-muted">
        {evidence.map((entry) => {
          const detail = evidenceDetail(entry);
          return (
            <li key={`${entry.kind}:${entry.id}`} className="min-w-0 break-words">
              <span className="font-medium text-app-text-secondary">{humanize(entry.kind)}</span>
              <span> · {entry.id}</span>
              {detail && <span> · {detail}</span>}
              {entry.semanticIds?.length ? <span> · {entry.semanticIds.join(", ")}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MeasurementList({ measurements }: { measurements: FindingMeasurement[] }) {
  if (measurements.length === 0) return null;
  return (
    <section aria-label="Measurements">
      <h4 className="text-app-micro font-semibold uppercase tracking-wider text-app-text-dim">Measurements</h4>
      <dl className="mt-1 divide-y divide-app-border text-app-caption">
        {measurements.map((measurement) => {
          const uncertainty = formatUncertainty(measurement);
          return (
            <div key={measurement.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-1.5 first:pt-0 last:pb-0">
              <dt className="min-w-0">
                <span className="block break-words font-medium text-app-text-secondary">{humanize(measurement.type)}</span>
                <span className="block break-words text-app-text-dim">{measurement.id}</span>
              </dt>
              <dd className="text-right">
                <span className={measurement.value == null ? "block text-status-unavailable" : "block font-mono text-app-text"}>
                  {formatMeasurementValue(measurement)}{measurement.value != null && measurement.unit ? ` ${measurement.unit}` : ""}
                </span>
                <span className="block text-app-text-dim">
                  {measurement.sampleCount} {measurement.sampleCount === 1 ? "sample" : "samples"} · {CONFIDENCE_LABELS[measurement.confidence]}
                </span>
                {uncertainty && <span className="block text-app-text-dim">Uncertainty {uncertainty}{measurement.unit ? ` ${measurement.unit}` : ""}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function EvidenceNavigation({ evidence, onEvidenceSelect }: { evidence: TelemetryRangeFindingEvidence[]; onEvidenceSelect: (evidence: FindingEvidenceRef) => void }) {
  const [eventIndex, setEventIndex] = useState(0);
  if (evidence.length === 0) return null;
  const activeIndex = Math.min(eventIndex, evidence.length - 1);
  const active = evidence[activeIndex];
  const start = active.startFrameIndex!;
  const end = active.endFrameIndex ?? start;
  const frameLabel = end === start ? `Frame ${start}` : `Frames ${start}–${end}`;
  return (
    <div className="flex items-center gap-1.5" aria-label="Telemetry evidence navigation">
      <Button
        type="button"
        variant="app-outline"
        size="app-sm"
        onClick={() => onEvidenceSelect(active)}
        data-frame-index={start}
        aria-label={`Jump to evidence ${frameLabel.toLowerCase()}`}
        className="min-w-0 flex-1"
      >
        <span className="truncate">View {frameLabel.toLowerCase()}</span>
      </Button>
      {evidence.length > 1 && (
        <>
          <Button
            type="button"
            variant="app-ghost"
            size="icon-xs"
            onClick={() => setEventIndex((activeIndex - 1 + evidence.length) % evidence.length)}
            aria-label="Previous evidence event"
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-7 text-center text-app-micro tabular-nums text-app-text-dim" aria-live="polite">
            {activeIndex + 1}/{evidence.length}
          </span>
          <Button
            type="button"
            variant="app-ghost"
            size="icon-xs"
            onClick={() => setEventIndex((activeIndex + 1) % evidence.length)}
            aria-label="Next evidence event"
          >
            <ChevronRight />
          </Button>
        </>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  narratives,
  staleReceipt,
  onEvidenceSelect,
}: {
  finding: FindingRecord;
  narratives: readonly FindingNarrative[];
  staleReceipt: boolean;
  onEvidenceSelect: (evidence: FindingEvidenceRef) => void;
}) {
  const status = staleReceipt && finding.status === "available" ? "unavailable" : finding.status;
  const displayFinding = status === finding.status ? finding : { ...finding, status };
  const telemetryEvidence = finding.evidenceRefs.filter(
    (entry): entry is TelemetryRangeFindingEvidence => entry.kind === "telemetry-range" && entry.startFrameIndex != null,
  );
  const reason = finding.limitations.find((limitation) => limitation.detail)?.detail;
  const matchingNarratives = narratives;
  const stateExplanation = staleReceipt && finding.status === "available"
    ? "Finding receipt is stale; this result is not current."
    : status === "unavailable"
      ? reason ?? "Required evidence is unavailable."
      : status === "indeterminate"
        ? reason ?? "Evidence does not support a definite result."
        : finding.confidence === "low"
          ? "Low-confidence result; treat as uncertain."
          : finding.confidence === "unknown"
            ? "Confidence is unknown; result is not promoted."
            : null;

  return (
    <article className={`space-y-3 rounded border bg-app-surface-alt p-3 ${findingBorder(displayFinding)}`} data-finding-id={finding.id} data-status={status} data-confidence={finding.confidence}>
      <header>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge size="compact" variant={STATUS_BADGES[status]}>{staleReceipt && finding.status === "available" ? "Stale" : STATUS_LABELS[status]}</Badge>
          <Badge size="compact" variant={severityVariant(displayFinding)}>{SEVERITY_LABELS[finding.severity]}</Badge>
          <Badge size="compact" variant={finding.confidence === "high" ? "success" : finding.confidence === "medium" ? "info" : "neutral"}>{CONFIDENCE_LABELS[finding.confidence]}</Badge>
        </div>
        <h3 className="mt-2 break-words text-app-subtext font-semibold text-app-text">{finding.title ?? humanize(finding.type)}</h3>
        <p className="mt-0.5 text-app-caption text-app-text-muted">{humanize(finding.category)}</p>
        {stateExplanation && (
          <p className={status === "indeterminate" ? "mt-2 text-app-caption text-status-warning" : "mt-2 text-app-caption text-app-text-muted"}>
            {stateExplanation}
          </p>
        )}
      </header>

      {matchingNarratives.length > 0 && (
        <section aria-label="Finding narrative">
          <h4 className="text-app-micro font-semibold uppercase tracking-wider text-app-text-dim">Guidance</h4>
          <ul className="mt-1 space-y-1 text-app-caption text-app-text-secondary">
            {matchingNarratives.map((narrative) => <li key={narrative.id} className="break-words">{narrative.text}</li>)}
          </ul>
        </section>
      )}

      <MeasurementList measurements={finding.measurements} />

      {finding.limitations.length > 0 && (
        <section aria-label="Limitations">
          <h4 className="text-app-micro font-semibold uppercase tracking-wider text-app-text-dim">Limitations</h4>
          <ul className="mt-1 space-y-1 text-app-caption text-app-text-muted">
            {finding.limitations.map((limitation) => (
              <li key={`${limitation.code}:${limitation.detail ?? ""}`}>
                <span className="font-medium text-app-text-secondary">{humanize(limitation.code)}</span>
                {limitation.detail && <span> · {limitation.detail}</span>}
                {limitation.evidenceRefs?.length ? <span> · Evidence {limitation.evidenceRefs.map((entry) => entry.id).join(", ")}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      <EvidenceNavigation evidence={telemetryEvidence} onEvidenceSelect={onEvidenceSelect} />
      <EvidenceList title="Evidence" evidence={finding.evidenceRefs} />
      <EvidenceList title="Quality evidence" evidence={finding.qualityRefs} />
      {finding.comparisonReference && (
        <section aria-label="Comparison reference">
          <h4 className="text-app-micro font-semibold uppercase tracking-wider text-app-text-dim">Comparison reference</h4>
          <p className="mt-1 break-words text-app-caption text-app-text-secondary">
            <span className="font-medium">{humanize(finding.comparisonReference.kind)}</span>
            <span> · {finding.comparisonReference.id}</span>
            <span> · {finding.comparisonReference.selectionReason}</span>
          </p>
          <div className="mt-2">
            <EvidenceList title="Reference evidence" evidence={finding.comparisonReference.evidenceRefs} />
          </div>
        </section>
      )}
    </article>
  );
}

function FindingList({
  findings,
  narratives,
  staleReceipt,
  onEvidenceSelect,
}: {
  findings: readonly FindingRecord[];
  narratives: readonly FindingNarrative[];
  staleReceipt: boolean;
  onEvidenceSelect: (evidence: FindingEvidenceRef) => void;
}) {
  const ordered = useMemo(
    () => [...findings].sort((left, right) =>
      compareText(left.category, right.category) || compareText(left.type, right.type) || compareText(left.id, right.id),
    ),
    [findings],
  );
  const narrativesById = useMemo(() => narrativesByFinding(narratives), [narratives]);
  return (
    <div className="flex flex-col gap-3" aria-label="Deterministic findings">
      {ordered.map((finding) => (
        <FindingCard
          key={finding.id}
          finding={finding}
          narratives={narrativesById.get(finding.id) ?? EMPTY_NARRATIVES}
          staleReceipt={staleReceipt}
          onEvidenceSelect={onEvidenceSelect}
        />
      ))}
    </div>
  );
}

export function FindingPanel({
  findings,
  narratives = EMPTY_NARRATIVES,
  receipt = null,
  pending = false,
  onEvidenceSelect,
}: {
  findings: readonly FindingRecord[];
  narratives?: readonly FindingNarrative[];
  receipt?: FindingGenerationReceipt | null;
  pending?: boolean;
  onEvidenceSelect: (evidence: FindingEvidenceRef) => void;
}) {
  const staleReceipt = pending || (receipt != null && receipt.status !== "current");
  return (
    <div className="space-y-3">
      {staleReceipt && (
        <div role="status" className="rounded border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-app-caption text-status-warning" data-finding-receipt-status={pending ? "backfilling" : receipt?.status ?? "stale"}>
          {pending ? "Findings are backfilling. Results will update automatically." : `Finding receipt is ${receipt?.status ?? "stale"}; available results are not current.`}
        </div>
      )}
      {findings.length === 0 ? (
        <div role="status" className="rounded border border-app-border bg-app-surface-alt p-4 text-center">
          <p className="text-app-subtext font-medium text-app-text">No deterministic findings</p>
          <p className="mt-1 text-app-caption text-app-text-muted">Analysis found no evidence-backed issues for this lap.</p>
        </div>
      ) : (
        <FindingList findings={findings} narratives={narratives} staleReceipt={staleReceipt} onEvidenceSelect={onEvidenceSelect} />
      )}
    </div>
  );
}
