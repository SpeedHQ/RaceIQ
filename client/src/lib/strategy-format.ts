import type { MetricRate } from "@raceiq/shared/racing/live/strategy";
import { m } from "@/paraglide/messages";

const reasonLabels: Record<string, () => string> = {
  unsupported: m.strategy_reason_unsupported,
  "unsupported-tire-wear-rate": m.strategy_reason_unsupported,
  missing: m.strategy_reason_missing,
  "fuel-unavailable": m.strategy_reason_missing,
  "tire-wear-unavailable": m.strategy_reason_missing,
  invalid: m.strategy_reason_invalid,
  "invalid-lap": m.strategy_reason_invalid,
  "insufficient-endpoints": m.strategy_reason_invalid,
  service: m.strategy_reason_service,
  "service-boundary": m.strategy_reason_service,
  "fuel-reset-or-refill": m.strategy_reason_service,
  "tire-reset-or-replacement": m.strategy_reason_service,
  refill: m.strategy_reason_service,
  "tire-replacement": m.strategy_reason_service,
  "pit-visit": m.strategy_reason_service,
  inlap: m.strategy_reason_service,
  outlap: m.strategy_reason_service,
  discontinuous: m.strategy_reason_discontinuous,
  "discontinuous-lap": m.strategy_reason_discontinuous,
  "timebase-discontinuity": m.strategy_reason_discontinuous,
  "source-gap": m.strategy_reason_discontinuous,
  history: m.strategy_reason_history,
  "no-compatible-history": m.strategy_reason_history,
  "history-refresh-pending": m.strategy_refresh_pending,
  "no-current-samples": m.strategy_gathering,
  "history-disabled": m.strategy_gathering,
  context: m.strategy_reason_context,
  "configuration-change": m.strategy_reason_context,
  "unknown-setup-key": m.strategy_setup_uncertain,
  "unknown-tire-compound": () => `${m.strategy_compounds()}: ${m.strategy_unknown()}`,
  "unknown-fuel-semantic-version": () => `${m.strategy_fuel_semantics()}: ${m.strategy_unknown()}`,
  "unknown-tire-semantic-version": () => `${m.strategy_tire_semantics()}: ${m.strategy_unknown()}`,
  "session-start": m.strategy_reason_start,
  "session-end": m.strategy_reason_end,
  "session-ended": m.strategy_reason_end,
  "recording-ended": m.strategy_reason_end,
  recovered: m.strategy_reason_recovered,
  "process-restart": m.strategy_reason_recovered,
};

export function strategyReasonText(reason: string | null | undefined): string {
  return reason ? reasonLabels[reason]?.() ?? m.strategy_reason_other() : m.strategy_unavailable();
}

export function strategyRateText(rate: MetricRate): string {
  if (rate.value == null) return strategyReasonText(rate.unavailableReason);
  return rate.unit === "L/lap"
    ? m.strategy_rate_litres({ value: rate.value.toFixed(2) })
    : m.strategy_rate_points({ value: (rate.value * 100).toFixed(2) });
}

export function strategyFuelUsedText(value: number | null, unit: "L" | "tankFraction"): string {
  if (value == null) return m.strategy_unavailable();
  return unit === "L"
    ? m.strategy_amount_litres({ value: value.toFixed(2) })
    : m.strategy_amount_points({ value: (value * 100).toFixed(2) });
}
