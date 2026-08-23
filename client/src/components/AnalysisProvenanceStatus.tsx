import type { AnalysisOutputInventoryEntry, AnalysisStaleReason, AnalysisStatus, AnalysisVerificationCheck } from "@shared/racing/provenance/contracts";
import type { ReactNode } from "react";
import { m } from "../paraglide/messages";
import { Badge } from "./ui/badge";

type StatusVariant = "success" | "warning" | "danger" | "info" | "neutral";

export interface AnalysisStatusPresentation {
  label: string;
  description: string;
  variant: StatusVariant;
}

const STALE_REASON_LABELS: Record<AnalysisStaleReason, () => string> = {
  receipt_missing: m.analysis_stale_reason_receipt_missing,
  source_hash_changed: m.analysis_stale_reason_source_hash_changed,
  source_unavailable: m.analysis_stale_reason_source_unavailable,
  receipt_schema_changed: m.analysis_stale_reason_receipt_schema_changed,
  telemetry_contract_changed: m.analysis_stale_reason_telemetry_contract_changed,
  detector_changed: m.analysis_stale_reason_detector_changed,
  algorithm_changed: m.analysis_stale_reason_algorithm_changed,
  configuration_changed: m.analysis_stale_reason_configuration_changed,
  output_verification_failed: m.analysis_stale_reason_output_verification_failed,
  rebuild_interrupted: m.analysis_stale_reason_rebuild_interrupted,
};

type StatusPresentationResolver = (analysis: AnalysisStatus) => AnalysisStatusPresentation;

const STATUS_PRESENTATIONS = {
  current: () => ({ label: m.analysis_status_current(), description: m.analysis_status_current_copy(), variant: "success" }),
  stale_rebuild_available: (analysis) =>
    analysis.capability.mode === "limited"
      ? { label: m.analysis_status_limited_rebuild_available(), description: m.analysis_status_limited_rebuild_available_copy(), variant: "warning" }
      : analysis.capability.mode === "unavailable"
        ? { label: m.analysis_status_cannot_rebuild(), description: m.analysis_status_cannot_rebuild_copy(), variant: "danger" }
        : { label: m.analysis_status_rebuild_available(), description: m.analysis_status_rebuild_available_copy(), variant: "warning" },
  stale_source_missing: () => ({ label: m.analysis_status_cannot_rebuild(), description: m.analysis_status_cannot_rebuild_copy(), variant: "danger" }),
  rebuild_in_progress: () => ({ label: m.analysis_status_rebuild_in_progress(), description: m.analysis_status_rebuild_in_progress_copy(), variant: "info" }),
  verification_failed: (analysis) =>
    analysis.activeGeneration
      ? { label: m.analysis_status_verification_failed(), description: m.analysis_status_verification_failed_copy(), variant: "danger" }
      : { label: m.analysis_status_verification_failed(), description: m.analysis_status_verification_failed_no_active_copy(), variant: "danger" },
  incompatible: () => ({ label: m.analysis_status_incompatible(), description: m.analysis_status_incompatible_copy(), variant: "danger" }),
  corrupt: () => ({ label: m.analysis_status_corrupt(), description: m.analysis_status_corrupt_copy(), variant: "danger" }),
} satisfies Record<AnalysisStatus["status"], StatusPresentationResolver>;

export function analysisStatusPresentation(analysis: AnalysisStatus): AnalysisStatusPresentation {
  return STATUS_PRESENTATIONS[analysis.status](analysis);
}


function HashValue({ value }: { value: string | null | undefined }) {
  return value ? (
    <span className="block min-w-0 truncate font-mono text-app-micro" title={value}>
      {value}
    </span>
  ) : (
    <span className="text-app-text-muted">{m.quality_not_available()}</span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-app-text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function nullableRange(range: { start: number | null; end: number | null } | null, suffix: string): string {
  if (!range || (range.start == null && range.end == null)) return m.quality_not_available();
  return `${range.start ?? "…"}–${range.end ?? "…"}${suffix}`;
}

export function formatOutputCoverage(output: AnalysisOutputInventoryEntry): string[] {
  return [
    output.timeCoverageMs ? `${m.analysis_output_time_coverage()}: ${nullableRange(output.timeCoverageMs, " ms")}` : null,
    output.lapCoverage ? `${m.analysis_output_lap_coverage()}: ${nullableRange(output.lapCoverage, "")}` : null,
    output.participantCoverage ? `${m.analysis_output_participant_coverage()}: ${output.participantCoverage.join(", ") || m.quality_not_available()}` : null,
    output.trackDistanceCoverageM ? `${m.analysis_output_distance_coverage()}: ${nullableRange(output.trackDistanceCoverageM, " m")}` : null,
  ].filter((value): value is string => value !== null);
}

function VerificationCheck({ check }: { check: AnalysisVerificationCheck }) {
  const variant: StatusVariant = check.status === "passed" ? "success" : check.status === "failed" ? "danger" : "neutral";
  const label = check.status === "passed" ? m.analysis_check_passed() : check.status === "failed" ? m.analysis_check_failed() : m.analysis_check_not_applicable();
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 break-words font-mono">{check.id}</span>
      <Badge variant={variant} size="compact">
        {label}
      </Badge>
      <span className="col-span-2 break-words text-app-text-muted">{check.details}</span>
    </li>
  );
}

export interface AnalysisProvenanceStatusSummaryProps {
  analysis: AnalysisStatus;
}

export function AnalysisProvenanceStatusSummary({ analysis }: AnalysisProvenanceStatusSummaryProps) {
  const presentation = analysisStatusPresentation(analysis);
  return (
    <section aria-label={m.analysis_provenance_title()} className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-app-caption font-semibold text-app-text">{m.analysis_provenance_title()}</h3>
        <Badge variant={presentation.variant} size="compact" data-analysis-status={analysis.status}>
          {presentation.label}
        </Badge>
        {analysis.activeGeneration && (
          <span className="text-app-micro text-app-text-muted">
            {m.analysis_active_generation({ generation: analysis.activeGeneration.generation })}
          </span>
        )}
      </div>
      <p className="max-w-prose text-app-caption text-app-text-muted">{presentation.description}</p>
      {analysis.staleReasons.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label={m.analysis_stale_reasons()}>
          {analysis.staleReasons.map((reason) => (
            <li key={reason}>
              <Badge variant="neutral" size="compact">
                {STALE_REASON_LABELS[reason]()}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface AnalysisProvenanceDiagnosticsProps {
  analysis: AnalysisStatus;
  canonicalCleanupEligible?: boolean;
}

export function AnalysisProvenanceDiagnostics({ analysis, canonicalCleanupEligible }: AnalysisProvenanceDiagnosticsProps) {
  const receipt = analysis.receipt;
  const failureChecks = analysis.failure?.checks ?? [];
  const receiptChecks = receipt?.verification ?? [];
  const checks = [
    ...receiptChecks,
    ...failureChecks.filter((failureCheck) => !receiptChecks.some((receiptCheck) =>
      receiptCheck.id === failureCheck.id &&
      receiptCheck.status === failureCheck.status &&
      receiptCheck.details === failureCheck.details,
    )),
  ];
  const limitations = [...new Set([...(receipt?.rebuildCapability.limitations ?? []), ...analysis.capability.limitations])];
  const cleanupEligible = canonicalCleanupEligible ?? false;

  return (
    <div className="min-w-0 divide-y divide-app-border">
      <section className="min-w-0 space-y-2 pb-3">
        <h4 className="font-semibold text-app-text">{m.analysis_receipt()}</h4>
        <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          <DetailRow label={m.analysis_receipt_schema()}>
            <span className="font-mono">{receipt?.receiptSchemaVersion ?? analysis.activeGeneration?.receiptSchemaVersion ?? m.quality_not_available()}</span>
          </DetailRow>
          <DetailRow label={m.analysis_generation()}>
            <span className="font-mono">{receipt?.generation ?? analysis.activeGeneration?.generation ?? m.quality_not_available()}</span>
          </DetailRow>
          <DetailRow label={m.analysis_generation_id()}>
            <HashValue value={receipt?.generationId ?? analysis.activeGeneration?.generationId} />
          </DetailRow>
          <DetailRow label={m.analysis_lifecycle()}>
            <span className="font-mono">{receipt?.lifecycle ?? analysis.activeGeneration?.lifecycle ?? m.quality_not_available()}</span>
          </DetailRow>
          <DetailRow label={m.analysis_source_kind()}>
            <span className="font-mono">{receipt?.evidence.kind ?? analysis.capability.sourceKind}</span>
          </DetailRow>
          <DetailRow label={m.analysis_source_hash()}>
            <HashValue value={receipt?.evidence.contentHash} />
          </DetailRow>
          <DetailRow label={m.analysis_contract_hash()}>
            <HashValue value={receipt?.contractHash} />
          </DetailRow>
          <DetailRow label={m.analysis_configuration_hash()}>
            <HashValue value={receipt?.configuration.hash} />
          </DetailRow>
          <DetailRow label={m.analysis_cleanup_eligible()}>
            {cleanupEligible ? m.analysis_cleanup_eligible_yes() : m.analysis_cleanup_eligible_no()}
          </DetailRow>
        </dl>
        {analysis.latestAttempt && analysis.latestAttempt.generationId !== analysis.activeGeneration?.generationId && (
          <p className="break-words text-app-text-muted">
            {m.analysis_latest_attempt({ generation: analysis.latestAttempt.generation, lifecycle: analysis.latestAttempt.lifecycle })}
          </p>
        )}
        {analysis.failure && (
          <div role="alert" className="space-y-1 border-l-2 border-status-danger pl-3 text-status-danger">
            <div className="font-semibold">{analysis.failure.code}</div>
            <p className="break-words">{analysis.failure.message}</p>
          </div>
        )}
      </section>

      <section className="min-w-0 space-y-2 py-3">
        <h4 className="font-semibold text-app-text">{m.analysis_versions()}</h4>
        {receipt ? (
          <>
            <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
              <DetailRow label={m.quality_catalog_version()}>
                <HashValue value={receipt.telemetryVersion.catalogVersion} />
              </DetailRow>
              <DetailRow label={m.analysis_catalog_hash()}>
                <HashValue value={receipt.telemetryVersion.catalogHash} />
              </DetailRow>
              <DetailRow label={m.quality_parser_version()}>
                <span className="font-mono">{receipt.telemetryVersion.parserVersion}</span>
              </DetailRow>
              <DetailRow label={m.quality_resolver_version()}>
                <span className="font-mono">{receipt.telemetryVersion.resolverVersion}</span>
              </DetailRow>
              <DetailRow label={m.quality_derivation_version()}>
                <span className="font-mono">{receipt.telemetryVersion.derivationVersion}</span>
              </DetailRow>
            </dl>
            <ul className="divide-y divide-app-border" aria-label={m.analysis_components()}>
              {receipt.analysisComponents.map((component) => (
                <li key={`${component.id}:${component.version}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-1.5">
                  <span className="min-w-0 truncate font-mono" title={component.id}>
                    {component.id}
                  </span>
                  <span className="shrink-0 font-mono text-app-text-muted">
                    {component.version}
                    {component.schemaVersion ? ` · ${component.schemaVersion}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-app-text-muted">{m.quality_not_available()}</p>
        )}
      </section>

      <section className="min-w-0 space-y-2 py-3">
        <h4 className="font-semibold text-app-text">{m.analysis_effective_configuration()}</h4>
        {receipt ? (
          <pre className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md bg-app-surface-alt p-2 font-mono text-app-micro text-app-text-muted">
            {JSON.stringify(receipt.configuration.effective, null, 2)}
          </pre>
        ) : (
          <p className="text-app-text-muted">{m.quality_not_available()}</p>
        )}
      </section>

      <section className="min-w-0 space-y-2 py-3">
        <h4 className="font-semibold text-app-text">{m.analysis_output_inventory()}</h4>
        {receipt?.outputs.length ? (
          <ul className="divide-y divide-app-border">
            {receipt.outputs.map((output) => {
              const coverage = formatOutputCoverage(output);
              return (
                <li key={`${output.artifactType}:${output.name}`} className="min-w-0 space-y-1 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words font-semibold text-app-text">{output.name}</span>
                    <span className="min-w-0 break-all font-mono text-app-micro text-app-text-muted">
                      {output.artifactType} · {output.schemaVersion}
                    </span>
                    <span className="ml-auto shrink-0 font-mono">{m.analysis_output_count({ count: output.count })}</span>
                  </div>
                  <HashValue value={output.contentHash} />
                  {coverage.length > 0 && <p className="break-words text-app-text-muted">{coverage.join(" · ")}</p>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-app-text-muted">{m.quality_not_available()}</p>
        )}
      </section>

      <section className="min-w-0 space-y-2 py-3">
        <h4 className="font-semibold text-app-text">{m.analysis_verification_checks()}</h4>
        {checks.length > 0 ? <ul className="divide-y divide-app-border">{checks.map((check) => <VerificationCheck key={`${check.id}:${check.status}:${check.details}`} check={check} />)}</ul> : <p className="text-app-text-muted">{m.quality_not_available()}</p>}
      </section>

      <section className="min-w-0 space-y-2 pt-3">
        <h4 className="font-semibold text-app-text">{m.quality_limitations()}</h4>
        <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          <DetailRow label={m.analysis_rebuild_mode()}>
            <span className="font-mono">{analysis.capability.mode}</span>
          </DetailRow>
          <DetailRow label={m.analysis_rebuildable_outputs()}>{analysis.capability.rebuildableArtifacts.join(", ") || m.quality_not_available()}</DetailRow>
          <DetailRow label={m.analysis_unavailable_outputs()}>{analysis.capability.unavailableArtifacts.join(", ") || m.quality_not_available()}</DetailRow>
        </dl>
        {limitations.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-app-text-muted">
            {limitations.map((limitation) => (
              <li key={limitation} className="break-words">
                {limitation}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-app-text-muted">{m.quality_no_limits()}</p>
        )}
        {receipt?.warnings.length ? (
          <div className="space-y-1">
            <h5 className="font-semibold text-app-text">{m.analysis_warnings()}</h5>
            <ul className="list-disc space-y-1 pl-5 text-app-text-muted">
              {receipt.warnings.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {receipt?.unsupportedFields.length ? (
          <div className="space-y-1">
            <h5 className="font-semibold text-app-text">{m.analysis_unsupported_fields()}</h5>
            <p className="break-words font-mono text-app-micro text-app-text-muted">{receipt.unsupportedFields.join(", ")}</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
