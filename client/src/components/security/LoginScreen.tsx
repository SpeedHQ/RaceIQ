import { useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { SiDiscord } from "react-icons/si";
import { client } from "@/lib/rpc";
import { useRouter } from "@tanstack/react-router";
import { loadDashboardAuth, useDashboardAuth } from "@/lib/dashboard-auth";
import { uiStore } from "@/stores/ui";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { PasswordField, accessErrorMessage } from "./AccessSetupForm";

export function LoginScreen({ discordComplete = false, returnPath = "/" }: { discordComplete?: boolean; returnPath?: string }) {
  const { status, refresh } = useDashboardAuth();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [discordPending, setDiscordPending] = useState(false);
  const [discordCancelPending, setDiscordCancelPending] = useState(false);
  const [discordError, setDiscordError] = useState("");
  const discordFinishStarted = useRef(false);
  async function finishDiscord() {
    if (discordFinishStarted.current) return;
    discordFinishStarted.current = true;
    setDiscordPending(true);
    setDiscordError("");
    try {
      const response = await client.api.auth.discord.finish.$post({ json: {} });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
      }
      const result = await response.json();
      if (result.status === "pending") throw new Error("request_failed");
      const updated = await loadDashboardAuth();
      if (updated.pending || !updated.onboardingComplete) await router.navigate({ to: "/onboarding", search: { welcome: true, step: "online-permissions", redirect: returnPath } });
      else await router.navigate({ href: returnPath });
    } catch (failure) {
      setDiscordError(accessErrorMessage(failure, m.access_unavailable));
    } finally {
      discordFinishStarted.current = false;
      setDiscordPending(false);
    }
  }
  useEffect(() => {
    if (discordComplete) void finishDiscord();
  }, [discordComplete]);
  async function startDiscord() {
    setDiscordPending(true);
    setDiscordError("");
    try {
      const response = await client.api.auth.discord.start.$post({ json: {} });
      if (!response.ok) {
        const body = await response.json();
        throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
      }
      const { authorizationUrl } = await response.json();
      window.location.assign(authorizationUrl);
    } catch (failure) {
      setDiscordError(accessErrorMessage(failure, m.access_unavailable));
      setDiscordPending(false);
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg p-4 text-app-text">
      <Card className="w-full max-w-md border border-app-border bg-app-surface shadow-lg">
        <CardHeader className="gap-2 border-b border-app-border pb-5">
          <div aria-hidden="true" className="mb-2 h-1 w-10 rounded-full bg-app-accent shadow-[var(--app-glow-accent)]" />
          <CardTitle>{m.access_login_title()}</CardTitle>
          <CardDescription className="text-app-text-muted">{m.access_login_description()}</CardDescription>
        </CardHeader>
        <CardContent className="pt-1">
          {status.method === "discord" || discordComplete ? <div className="flex flex-col gap-5">
            {discordError && !discordComplete && <p role="alert" className="text-sm text-status-danger">{discordError}</p>}
            {discordComplete && (discordPending || discordError) && <p role={discordError ? "alert" : "status"}>{discordPending ? m.common_loading() : discordError}</p>}
            {discordComplete && discordError && <Button variant="app-primary" className="w-full" disabled={discordPending} onClick={() => void startDiscord()}>{m.ob_continue_discord()}</Button>}
            {discordComplete && <Button variant="outline" className="w-full" disabled={discordPending || discordCancelPending} onClick={async () => {
              setDiscordCancelPending(true);
              try {
                const response = await client.api.auth.discord.cancel.$post({ json: {} });
                if (!response.ok) {
                  const body = await response.json();
                  throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
                }
                if (status.pending) await router.navigate({ to: "/onboarding", search: { welcome: true, step: undefined, redirect: returnPath } });
                else await router.navigate({ href: returnPath });
              } catch (failure) {
                setDiscordError(accessErrorMessage(failure, m.access_unavailable));
              } finally {
                setDiscordCancelPending(false);
              }
            }}>{m.common_back()}</Button>}
            {!discordComplete && <Button variant="app-primary" size="app-lg" className="w-full" disabled={discordPending} onClick={() => void startDiscord()}><SiDiscord aria-hidden="true" />{discordPending ? m.common_loading() : m.ob_continue_discord()}</Button>}
          </div> : <form className="flex flex-col gap-5" onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError("");
            try {
              const response = await client.api.auth.login.$post({ json: { password } });
              if (!response.ok) {
                const body = await response.json();
                throw new Error("error" in body && typeof body.error === "string" ? body.error : "request_failed");
              }
              setPassword("");
              uiStore.actions.closeSettings();
              await refresh();
            } catch (failure) {
              setError(accessErrorMessage(failure, m.access_unavailable));
            } finally {
              setPending(false);
            }
          }}>
            <PasswordField id="login-password" label={m.access_password()} value={password} onChange={setPassword} autoComplete="current-password" />
            {error && <p className="rounded-lg border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger" role="alert">{error}</p>}
            <Button type="submit" variant="app-primary" size="app-lg" className="w-full" disabled={pending || !password}>
              <LockKeyhole aria-hidden="true" />
              {m.access_login()}
            </Button>
          </form>}
        </CardContent>
      </Card>
    </div>
  );
}
