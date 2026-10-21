import type { OnlineErrorCode } from "@raceiq/online/contracts";
export type OnlineCommandStatus=200|202|400|401|403|409|429|500|503;
export function onlineErrorStatus(code:OnlineErrorCode):OnlineCommandStatus {
  switch(code){
    case "invalid_request":case "unsupported_game":case "unknown_track":case "unknown_car":case "ineligible_lap":return 400;
    case "not_connected":case "auth_failed":case "auth_cancelled":return 401;
    case "consent_required":case "account_unavailable":case "sharing_required":return 403;
    case "stale_state":case "policy_changed":case "driver_identity_required":case "mixed_driver_lap":case "capture_active":
    case "activity_identity_ambiguous":case "activity_revision_conflict":case "activity_owner_conflict":case "lap_owner_conflict":case "lap_identity_conflict":return 409;
    case "rate_limited":return 429;
    case "offline":case "service_unavailable":case "policy_unavailable":case "preferences_failed":return 503;
    default:return 500;
  }
}
