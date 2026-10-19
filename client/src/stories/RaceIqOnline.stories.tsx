import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnlineErrorCode, OnlineLeaderboard, OnlineState } from "@raceiq/online/contracts";
import { RaceIqOnlineProvider } from "../hooks/raceiq-online";
import { OnlineSection } from "../components/settings/OnlineSection";
import { Settings } from "../components/settings/Settings";
import { OnlineCommunityLaps } from "../components/track/OnlineCommunityLaps";
import { setLocale, locales, type Locale } from "../paraglide/runtime";
import { m } from "../paraglide/messages";
import { connectedConsentRequiredUnavailableFixture, connectedServiceUnavailableFixture, consentRequiredFixture, createOnlineFixturePort, fixtureBoard, preferencesFailedFixture, preferencesWithoutProfileFixture, privateFixture, publicFixture, signedOutFixture, unavailableFixture } from "./raceiq-online-fixtures";

type PreviewProps = { state: OnlineState; onboarding?: boolean; onboardingStage?: "auth" | "permissions"; settingsShell?: boolean; board?: OnlineLeaderboard; transportFailure?: boolean; pending?: boolean; stateDelayMs?: number; commandError?: OnlineErrorCode; locale?: Locale };
export function OnlinePreview({ state, onboarding = false, onboardingStage, settingsShell = false, board, transportFailure = false, pending = false, stateDelayMs, commandError, locale = "en" }: PreviewProps) {
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
      {skipped ? <p role="status">Offline onboarding continued. No Online command was sent.</p> : settingsShell ? <div className="h-[calc(100vh-3rem)]"><Settings initialSection="general" /></div> : <OnlineSection onboarding={onboarding} stage={onboardingStage ?? (onboarding ? "auth" : undefined)} onSkip={() => setSkipped(true)} />}
      {!onboarding && !settingsShell && <div className="mt-8 border-t border-app-border pt-4"><OnlineCommunityLaps {...fixtureBoard.key} /></div>}
    </main>
  </RaceIqOnlineProvider></QueryClientProvider>;
}
const meta = { title: "Settings/RaceIQ Online", component: OnlinePreview, parameters: { layout: "fullscreen" }, argTypes: { locale: { control: "select", options: locales } } } satisfies Meta<typeof OnlinePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOut: Story = { args: { state: signedOutFixture } };
export const OptionalOnboarding: Story = { args: { state: signedOutFixture, onboarding: true } };
export const AcceptedOnboardingPermissions: Story = {
  args: { state: publicFixture, onboarding: true, onboardingStage: "permissions" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = await canvas.findByRole("button", { name: m.common_next() });
    await expect(canvas.queryByRole("checkbox", { name: m.online_confirm_policy() })).not.toBeInTheDocument();
    await expect(next).toBeEnabled();
    await userEvent.click(canvas.getByRole("switch", { name: m.online_setup_title() }));
    await userEvent.click(next);
    await waitFor(async () => {
      await expect(JSON.parse(canvasElement.querySelector("main")!.getAttribute("data-online-calls")!).some((call: { method: string }) => call.method === "setPreferences")).toBe(true);
    });
    await expect(JSON.parse(canvasElement.querySelector("main")!.getAttribute("data-online-calls")!).some((call: { method: string }) => call.method === "acceptConsent")).toBe(false);
  },
};
export const FirstConsentOnboarding: Story = {
  args: { state: consentRequiredFixture, onboarding: true, onboardingStage: "permissions" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const confirm = await canvas.findByRole("checkbox", { name: m.online_confirm_policy() });
    const accept = canvas.getByRole("button", { name: m.online_connect_accept() });
    await expect(accept).toBeDisabled();
    await userEvent.click(confirm);
    await userEvent.click(accept);
    await waitFor(async () => {
      await expect(JSON.parse(canvasElement.querySelector("main")!.getAttribute("data-online-calls")!).some((call: { method: string }) => call.method === "acceptConsent")).toBe(true);
    });
    await expect(canvas.getByRole("switch", { name: m.online_setup_title() })).toBeInTheDocument();
  },
};
export const Public: Story = { args: { state: publicFixture } };
export const SaveSettings: Story = {
  args: { state: publicFixture },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const save = await canvas.findByRole("button", { name: m.common_save() });
    const setup = canvas.getByRole("switch", { name: m.online_setup_title() });
    await expect(save).toBeDisabled();
    await userEvent.click(setup);
    await expect(save).toBeEnabled();
    await expect(canvas.getByText(m.online_preferences_effective({ visibility: m.online_visibility_public(), setup: m.common_off() }))).toBeVisible();
    await expect(JSON.parse(canvasElement.querySelector("main")!.getAttribute("data-online-calls")!).some((call: { method: string }) => call.method === "setPreferences")).toBe(false);
    await userEvent.click(save);
    await expect(await canvas.findByText(m.online_preferences_persisted_values({ visibility: m.online_visibility_public(), setup: m.common_on() }))).toBeVisible();
    await waitFor(async () => { await expect(save).toBeDisabled(); });
    await expect(setup).toBeChecked();
  },
};
export const SaveLeaderboardName: Story = {
  args: { state: publicFixture },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = await canvas.findByRole("textbox", { name: m.online_leaderboard_name() });
    const save = canvas.getByRole("button", { name: m.common_save() });
    await userEvent.clear(name);
    await userEvent.type(name, "New Leaderboard Driver");
    await expect(save).toBeEnabled();
    const calls = () => JSON.parse(canvasElement.querySelector("main")!.getAttribute("data-online-calls")!) as { method: string; input?: { displayName?: string } }[];
    await expect(calls().some((call) => call.method === "setDisplayName")).toBe(false);
    await userEvent.click(save);
    await waitFor(async () => { await expect(save).toBeDisabled(); });
    await expect(name).toHaveValue("New Leaderboard Driver");
    await expect(calls().filter((call) => call.method === "setDisplayName").map((call) => call.input?.displayName)).toEqual(["New Leaderboard Driver"]);
    await expect(calls().some((call) => call.method === "setPreferences")).toBe(false);
  },
};
export const PrivateLockedBoard: Story = { args: { state: privateFixture } };
export const PreferencesFailed: Story = { args: { state: preferencesFailedFixture } };
export const CloudUnavailableWithAccount: Story = {
  args: { state: connectedServiceUnavailableFixture, settingsShell: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.online_connected_as({ name: "Preview Driver" }))).toBeVisible();
    await expect(canvas.getByRole("switch", { name: m.online_public_title() })).toBeDisabled();
    await expect(canvas.getByRole("switch", { name: m.online_setup_title() })).toBeDisabled();
  },
};
export const ConsentRequiredDuringOutage: Story = {
  args: { state: connectedConsentRequiredUnavailableFixture, settingsShell: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.online_connected_as({ name: "Preview Driver" }))).toBeVisible();
    await expect(canvas.getByRole("switch", { name: m.online_public_title() })).toBeDisabled();
    await expect(canvas.getByRole("switch", { name: m.online_setup_title() })).toBeDisabled();
    await expect(canvas.getByRole("checkbox", { name: m.online_confirm_policy() })).toBeDisabled();
  },
};
export const SignedOutDuringOutage: Story = {
  args: { state: unavailableFixture, settingsShell: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: m.online_connect() })).toBeEnabled();
  },
};
export const LegacyPreferencesWithoutProfile: Story = {
  args: { state: preferencesWithoutProfileFixture },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: m.online_connect() })).toBeDisabled();
    await expect(canvas.getByRole("switch", { name: m.online_public_title() })).toBeDisabled();
    await expect(canvas.getByRole("switch", { name: m.online_public_title() })).not.toBeChecked();
    await expect(canvas.getByRole("switch", { name: m.online_setup_title() })).toBeChecked();
  },
};
export const ConsentRequired: Story = { args: { state: consentRequiredFixture } };
export const ConsentWithUnconfirmedPreferences: Story = {
  args: { state: { ...consentRequiredFixture, preferencePersistence: "unconfirmed" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const confirm = await canvas.findByRole("checkbox", { name: m.online_confirm_policy() });
    const submit = canvas.getByRole("button", { name: m.online_connect_accept() });
    await expect(submit).toBeDisabled();
    await userEvent.click(confirm);
    await userEvent.click(submit);
    await expect(await canvas.findByText(m.online_preferences_effective({ visibility: m.online_visibility_public(), setup: m.common_off() }))).toBeVisible();
    await waitFor(async () => {
      await expect(canvas.getByRole("switch", { name: m.online_public_title() })).toBeEnabled();
      await expect(canvas.queryByText(m.online_preferences_unconfirmed())).not.toBeInTheDocument();
    });
    await expect(canvas.getByRole("switch", { name: m.online_setup_title() })).not.toBeChecked();
  },
};
export const ConsentWithoutPreferences: Story = {
  ...ConsentWithUnconfirmedPreferences,
  args: { state: { ...consentRequiredFixture, preferences: null, persistedPreferences: null, preferencePersistence: "unconfirmed", uploadAllowed: false } },
};
export const AcceptedWithoutPreferences: Story = {
  args: { state: { ...publicFixture, preferences: null, persistedPreferences: null, preferencePersistence: "unconfirmed", uploadAllowed: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: m.online_retry_preferences() }));
    await waitFor(async () => {
      await expect(canvas.queryByText(m.online_preferences_unconfirmed())).not.toBeInTheDocument();
    });
    await expect(canvas.getByRole("switch", { name: m.online_public_title() })).toBeChecked();
    await expect(canvas.getByRole("switch", { name: m.online_setup_title() })).not.toBeChecked();
  },
};
export const PolicyUnavailable: Story = { args: { state: unavailableFixture } };
export const BackendUnreachable: Story = { args: { state: publicFixture, transportFailure: true } };
export const UnknownBackendUnreachable: Story = {
  args: { state: signedOutFixture, transportFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: m.online_connect() })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: m.online_retry() })).toBeVisible();
  },
};
export const Loading: Story = { args: { state: signedOutFixture, pending: true } };
export const SigningIn: Story = { args: { state: { ...signedOutFixture, connection: { status: "signing_in", flowId: "preview-flow-id" } } } };
export const AuthFailed: Story = { args: { state: { ...signedOutFixture, connection: { status: "error", error: { code: "auth_failed", retryable: true, retryAfter: null } } } } };
export const SignOutFailed: Story = { args: { state: publicFixture, commandError: "service_unavailable" } };
export const StaleBoard: Story = { args: { state: publicFixture, board: { ...fixtureBoard, stale: true, error: { code: "offline", retryable: true, retryAfter: null } } } };
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
