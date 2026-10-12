import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnlineErrorCode, OnlineLeaderboard, OnlineState } from "@raceiq/shared/integrations/raceiq-online";
import { RaceIqOnlineProvider } from "../hooks/raceiq-online";
import { OnlineSection } from "../components/settings/OnlineSection";
import { Settings } from "../components/settings/Settings";
import { OnlineCommunityLaps } from "../components/track/OnlineCommunityLaps";
import { setLocale, locales, type Locale } from "../paraglide/runtime";
import { m } from "../paraglide/messages";
import { consentRequiredFixture, createOnlineFixturePort, fixtureBoard, preferencesFailedFixture, privateFixture, publicFixture, signedOutFixture, unavailableFixture } from "./raceiq-online-fixtures";

type PreviewProps = { state: OnlineState; onboarding?: boolean; settingsShell?: boolean; board?: OnlineLeaderboard; transportFailure?: boolean; pending?: boolean; stateDelayMs?: number; commandError?: OnlineErrorCode; locale?: Locale };
export function OnlinePreview({ state, onboarding = false, settingsShell = false, board, transportFailure = false, pending = false, stateDelayMs, commandError, locale = "en" }: PreviewProps) {
  setLocale(locale, { reload: false });
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale;
    return () => { document.documentElement.lang = previous; };
  }, [locale]);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [calls, setCalls] = useState<{ method: string; input?: unknown }[]>([]);
  const [port] = useState(() => createOnlineFixturePort(state, { board, transportFailure, pending, stateDelayMs, commandFailure: commandError ? { code: commandError, retryable: true, retryAfter: null } : undefined, onCall: (method, input) => setCalls((previous) => [...previous, { method, input }]) }));
  const [skipped, setSkipped] = useState(false);
  return <QueryClientProvider client={queryClient}><RaceIqOnlineProvider port={port}>
    <main data-online-calls={JSON.stringify(calls)} className="min-h-screen bg-app-bg p-4 text-app-text sm:p-6">
      <h1 className="sr-only">{m.online_onboarding_title()}</h1>
      {skipped ? <p role="status">Offline onboarding continued. No Online command was sent.</p> : settingsShell ? <div className="h-[calc(100vh-3rem)]"><Settings initialSection="online" /></div> : <OnlineSection onboarding={onboarding} onSkip={() => setSkipped(true)} />}
      {!onboarding && !settingsShell && <div className="mt-8 border-t border-app-border pt-4"><OnlineCommunityLaps {...fixtureBoard.key} /></div>}
    </main>
  </RaceIqOnlineProvider></QueryClientProvider>;
}
const meta = { title: "Settings/RaceIQ Online", component: OnlinePreview, parameters: { layout: "fullscreen" }, argTypes: { locale: { control: "select", options: locales } } } satisfies Meta<typeof OnlinePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOut: Story = { args: { state: signedOutFixture } };
export const OptionalOnboarding: Story = { args: { state: signedOutFixture, onboarding: true } };
export const Public: Story = { args: { state: publicFixture } };
export const PrivateReadableBoard: Story = { args: { state: privateFixture } };
export const PreferencesFailed: Story = { args: { state: preferencesFailedFixture } };
export const ConsentRequired: Story = { args: { state: consentRequiredFixture } };
export const PolicyUnavailable: Story = { args: { state: unavailableFixture } };
export const BackendUnreachable: Story = { args: { state: publicFixture, transportFailure: true } };
export const Loading: Story = { args: { state: signedOutFixture, pending: true } };
export const SigningIn: Story = { args: { state: { ...signedOutFixture, connection: { status: "signing_in", flowId: "preview-flow-id" } } } };
export const AuthFailed: Story = { args: { state: { ...signedOutFixture, connection: { status: "error", error: { code: "auth_failed", retryable: true, retryAfter: null } } } } };
export const SignOutFailed: Story = { args: { state: publicFixture, commandError: "service_unavailable" } };
export const StaleBoard: Story = { args: { state: privateFixture, board: { ...fixtureBoard, stale: true, error: { code: "offline", retryable: true, retryAfter: null } } } };
export const EmptyBoard: Story = { args: { state: publicFixture, board: { ...fixtureBoard, status: "empty", rows: [] } } };
export const UnavailableBoard: Story = { args: { state: publicFixture, board: { ...fixtureBoard, status: "unavailable", rows: [], fetchedAt: null, error: { code: "service_unavailable", retryable: true, retryAfter: null } } } };
export const UnsupportedBoard: Story = { args: { state: publicFixture, board: { ...fixtureBoard, status: "unavailable", rows: [], fetchedAt: null, error: { code: "unsupported_game", retryable: false, retryAfter: null } } } };
export const ValidationRejected: Story = { args: { state: { ...publicFixture, sync: { ...publicFixture.sync, rejected: 1, lastError: { code: "validation_rejected", retryable: false, retryAfter: null } } } } };
export const SanitizationFailed: Story = { args: { state: { ...publicFixture, sync: { ...publicFixture.sync, rejected: 1, lastError: { code: "f1_sanitization_failed", retryable: false, retryAfter: null } } } } };
export const WithdrawalPending: Story = { args: { state: { ...privateFixture, publicationWithdrawal: { status: "pending", error: null } } } };
export const WithdrawalFailed: Story = { args: { state: { ...privateFixture, publicationWithdrawal: { status: "failed", error: { code: "unpublish_failed", retryable: true, retryAfter: null } } } } };
export const Offline: Story = { args: { state: { ...privateFixture, service: "offline", sync: { ...privateFixture.sync, blockedBy: "offline" } } } };
export const PreferencesPending: Story = { args: { state: { ...preferencesFailedFixture, preferencePersistence: "pending" } } };
export const SetupOptIn: Story = { args: { state: { ...publicFixture, preferences: { visibility: "public", setupUploads: true }, persistedPreferences: { visibility: "public", setupUploads: true } } } };
export const UnknownTrack: Story = { args: { state: publicFixture, board: { ...fixtureBoard, status: "unavailable", rows: [], fetchedAt: null, error: { code: "unknown_track", retryable: false, retryAfter: null } } } };
export const UnknownCar: Story = { args: { state: publicFixture, board: { ...fixtureBoard, status: "unavailable", rows: [], fetchedAt: null, error: { code: "unknown_car", retryable: false, retryAfter: null } } } };
export const RateLimited: Story = { args: { state: publicFixture, board: { ...fixtureBoard, status: "unavailable", rows: [], fetchedAt: null, error: { code: "rate_limited", retryable: true, retryAfter: "2099-01-01T00:00:00Z" } } } };
export const SettingsNavigation: Story = { args: { state: unavailableFixture, settingsShell: true } };
export const LateStateResponse: Story = { args: { state: publicFixture, stateDelayMs: 700 } };
export const ConnectionPersistenceFailed: Story = { args: { state: { ...publicFixture, connection: { status: "error", error: { code: "preferences_failed", retryable: true, retryAfter: null } }, preferences: null, persistedPreferences: null, preferencePersistence: "failed", uploadAllowed: false, sync: { ...publicFixture.sync, status: "blocked", blockedBy: "preferences_unconfirmed" } } } };
