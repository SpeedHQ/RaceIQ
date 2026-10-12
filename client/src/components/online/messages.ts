import type { OnlineErrorCode } from "@raceiq/shared/integrations/raceiq-online";
import { m } from "@/paraglide/messages";

const errorMessages: Record<OnlineErrorCode, () => string> = {
  offline: m.online_error_offline,
  service_unavailable: m.online_error_service_unavailable,
  policy_unavailable: m.online_error_policy_unavailable,
  policy_changed: m.online_error_policy_changed,
  not_connected: m.online_error_not_connected,
  auth_failed: m.online_error_auth_failed,
  auth_cancelled: m.online_error_auth_cancelled,
  consent_required: m.online_error_consent_required,
  sharing_required: m.online_community_laps_private,
  stale_state: m.online_error_stale_state,
  invalid_request: m.online_error_invalid_request,
  preferences_failed: m.online_error_preferences_failed,
  rate_limited: m.online_error_rate_limited,
  unsupported_game: m.online_error_unsupported_game,
  unknown_track: m.online_error_unknown_track,
  unknown_car: m.online_error_unknown_car,
  ineligible_lap: m.online_error_ineligible_lap,
  f1_sanitization_failed: m.online_error_f1_sanitization_failed,
  validation_rejected: m.online_error_validation_rejected,
  account_unavailable: m.online_error_account_unavailable,
  unpublish_failed: m.online_error_unpublish_failed,
  external_open_failed: m.online_error_external_open_failed,
  internal_error: m.online_error_internal_error,
};

export function onlineErrorMessage(code: OnlineErrorCode): string {
  return errorMessages[code]();
}
