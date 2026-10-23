import type { OnlineErrorCode } from "@raceiq/online/contracts";
import type { OnlineMessages } from "../contracts/ui-host";

const errorMessages = {
  offline: "online_error_offline",
  service_unavailable: "online_error_service_unavailable",
  policy_unavailable: "online_error_policy_unavailable",
  policy_changed: "online_error_policy_changed",
  not_connected: "online_error_not_connected",
  auth_failed: "online_error_auth_failed",
  auth_cancelled: "online_error_auth_cancelled",
  consent_required: "online_error_consent_required",
  sharing_required: "online_community_laps_private",
  stale_state: "online_error_stale_state",
  invalid_request: "online_error_invalid_request",
  preferences_failed: "online_error_preferences_failed",
  rate_limited: "online_error_rate_limited",
  unsupported_game: "online_error_unsupported_game",
  unknown_track: "online_error_unknown_track",
  unknown_car: "online_error_unknown_car",
  ineligible_lap: "online_error_ineligible_lap",
  capture_active: "online_error_capture_active",
  driver_identity_required: "online_error_driver_identity_required",
  mixed_driver_lap: "online_error_mixed_driver_lap",
  activity_identity_ambiguous: "online_error_activity_identity_ambiguous",
  activity_revision_conflict: "online_error_activity_revision_conflict",
  activity_owner_conflict: "online_error_activity_owner_conflict",
  lap_owner_conflict: "online_error_lap_owner_conflict",
  lap_identity_conflict: "online_error_lap_identity_conflict",
  f1_sanitization_failed: "online_error_f1_sanitization_failed",
  unsupported_recording_format: "online_error_unsupported_recording_format",
  recording_too_large: "online_error_recording_too_large",
  recording_not_ready: "online_error_recording_not_ready",
  validation_rejected: "online_error_validation_rejected",
  account_unavailable: "online_error_account_unavailable",
  unpublish_failed: "online_error_unpublish_failed",
  external_open_failed: "online_error_external_open_failed",
  internal_error: "online_error_internal_error",
} as const satisfies Record<OnlineErrorCode, keyof OnlineMessages>;
export function onlineErrorMessage(code: OnlineErrorCode, m: OnlineMessages): string {
  return m[errorMessages[code]]();
}
